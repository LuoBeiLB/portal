# 开通失败 → 自动退款 路径验证
#
# 用法（在 portal/server 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-e2e-refund.ps1
#
# 与 run-e2e-round3.ps1 的区别：产品桩以 PROVISION_MODE=fail 启动，
# 对任何 provision 都返回 4004（业务失败、不重试），用来验证门户的自动退款闭环。

$ErrorActionPreference = 'Stop'
$server = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $server)
$redisCli = Join-Path $repoRoot '.tools\redis\redis-cli.exe'

function Stop-ListenerOnPort {
    param([int]$Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return }
    foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  · 结束占用 $Port 的进程 PID=$procId ($($proc.ProcessName))"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
}

Push-Location $server
$app = $null
$stub = $null
$exitCode = 1

try {
    Write-Host '=== 1. 清理残留进程 ==='
    # 只清产品桩端口，**不杀 3000**：开发机上常跑着自己的门户实例，
    # 杀它之后可能被自动拉起并重新占住端口，导致本脚本的 app 起不来
    # 而健康检查探到的是那个实例（会跑出一串假失败）。详见 run-e2e-round3.ps1 注释。
    Stop-ListenerOnPort -Port 8081
    Stop-ListenerOnPort -Port 3301

    Write-Host '=== 2. 检查 Redis ==='
    if (Test-Path $redisCli) {
        $pong = & $redisCli -p 6379 ping 2>$null
        Write-Host "  · Redis 6379: $pong"
        if ($pong -ne 'PONG') { Write-Warning '  · Redis 未就绪' }
    }

    Write-Host '=== 3. 重置商品缓存并立即同步 ==='
    & node scripts/reset-products.cjs

    Write-Host '=== 4. 起故障模式产品桩（PROVISION_MODE=fail）+ 门户服务 ==='
    $env:PROVISION_MODE = 'fail'
    # 与 run-e2e-round3.ps1 保持一致：用 STUB_* 覆盖 .env，让门户指向测试桩而不是真实云存储；
    # 并注入一个"仅入站"产品的密钥，保证断言集可复现。
    $env:PRODUCT_STORAGE_BASE_URL = 'http://127.0.0.1:8081'
    $env:PRODUCT_STORAGE_INTERNAL_KEY = 'stub-storage-key'
    $env:STUB_PRODUCT_INTERNAL_KEY = 'stub-storage-key'
    $env:PRODUCT_PHONE_INTERNAL_KEY = 'e2e-inbound-only-phone-key'
    $env:PRODUCT_PHONE_BASE_URL = ''
    # 与 run-e2e-round3.ps1 一致：公开接口限流阈值调大（本套不验证限流）
    $env:PUBLIC_RATE_WINDOW = '60'
    $env:PUBLIC_RATE_MAX = '300'
    # 专属端口 + 独立测试库：与开发机上运行的实例彻底隔离（同 run-e2e-round3.ps1）
    $env:APP_PORT = '3301'
    $env:DB_DATABASE = 'cloud_portal_e2e'
    $stub = Start-Process -FilePath 'node' -ArgumentList 'scripts/stub-product-server.cjs' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\stub-refund.txt" `
        -RedirectStandardError "$env:TEMP\stub-refund-err.txt" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2

    $app = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\portal-refund.txt" `
        -RedirectStandardError "$env:TEMP\portal-refund-err.txt" -PassThru -WindowStyle Hidden

    $ready = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3301/api/healthz' -TimeoutSec 3
            if ($health.code -eq 0) { Write-Host "  · 门户就绪（$($i + 1)s）"; $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        Get-Content "$env:TEMP\portal-refund-err.txt" -ErrorAction SilentlyContinue |
            Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
        throw '门户未能就绪（http://127.0.0.1:3301）'
    }

    Write-Host '=== 5. 等待商品同步 ==='
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 3
        $calls = (Get-Content "$env:TEMP\stub-refund.txt" -ErrorAction SilentlyContinue |
            Select-String -Pattern 'internal/products').Count
        if ($calls -gt 0) { Write-Host "  · 产品桩已被调用 $calls 次"; break }
    }

    Write-Host ''
    Write-Host '=== 6. 执行退款路径验证 ==='
    $env:E2E_BASE_URL = 'http://127.0.0.1:3301'
    & node scripts/e2e-refund.cjs
    $exitCode = $LASTEXITCODE
} finally {
    Write-Host ''
    Write-Host '=== 7. 清理 ==='
    if ($app -and -not $app.HasExited) { $app.Kill(); Write-Host '  · 已停止门户服务' }
    if ($stub -and -not $stub.HasExited) { $stub.Kill(); Write-Host '  · 已停止产品桩' }
    Remove-Item Env:\PROVISION_MODE -ErrorAction SilentlyContinue
    Pop-Location
}

exit $exitCode
