# 第 3 轮端到端自验（幂等：先清干净再跑）
#
# 用法（在 portal/server 下）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-e2e-round3.ps1
#
# 做五件事：
#   1. 杀掉占用 3000 / 8081 的残留进程（手工测试最容易在这里翻车）
#   2. 检查 Redis
#   3. 重置商品缓存（p_product / p_product_sync_log），不动用户与钱包
#   4. 起产品桩 + 门户服务，等就绪与首次商品同步
#   5. 跑 e2e-round3.cjs，无论成败都清理进程
#
# 注意：本文件必须保存为「UTF-8 with BOM」。Windows PowerShell 5.1 读无 BOM 的 UTF-8
# 会按 ANSI 解码，中文注释里的引号会打乱语法，报出与真实原因无关的 ParserError。

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
            Write-Host "  - 结束占用 $Port 的进程 PID=$procId ($($proc.ProcessName))"
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
    Stop-ListenerOnPort -Port 3000
    Stop-ListenerOnPort -Port 8081

    Write-Host '=== 2. 检查 Redis ==='
    if (Test-Path $redisCli) {
        $pong = & $redisCli -p 6379 ping 2>$null
        Write-Host "  - Redis 6379: $pong"
        if ($pong -ne 'PONG') { Write-Warning '  - Redis 未就绪，登录相关用例会失败' }
    } else {
        Write-Warning '  - 未找到便携 Redis，跳过检查'
    }

    Write-Host '=== 3. 重置商品缓存 ==='
    & node scripts/reset-products.cjs

    Write-Host '=== 4. 起产品桩 + 门户服务 ==='
    # 模拟「只配了入站密钥、未配地址」的产品（云手机），验证入站鉴权与出站同步已解耦：
    # phone 不参与商品同步，但它的密钥必须能通过门户的入站校验。
    $env:PRODUCT_PHONE_INTERNAL_KEY = 'e2e-inbound-only-phone-key'
    $env:PRODUCT_PHONE_BASE_URL = ''
    $stub = Start-Process -FilePath 'node' -ArgumentList 'scripts/stub-product-server.cjs' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\stub-run.txt" `
        -RedirectStandardError "$env:TEMP\stub-run-err.txt" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2

    $app = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\portal-run.txt" `
        -RedirectStandardError "$env:TEMP\portal-run-err.txt" -PassThru -WindowStyle Hidden

    $ready = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/healthz' -TimeoutSec 3
            if ($health.code -eq 0) { Write-Host "  - 门户就绪（$($i + 1)s）"; $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        Get-Content "$env:TEMP\portal-run-err.txt" -ErrorAction SilentlyContinue |
            Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
        throw '门户未能就绪'
    }

    Write-Host '=== 5. 等待首次商品同步（cron 每分钟；首次启动应立即同步）==='
    $synced = $false
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 3
        $calls = (Get-Content "$env:TEMP\stub-run.txt" -ErrorAction SilentlyContinue |
            Select-String -Pattern 'internal/products').Count
        if ($calls -gt 0) { Write-Host "  - 产品桩已被调用 $calls 次"; $synced = $true; break }
    }
    if (-not $synced) { Write-Warning '  - 等待超时，商品同步可能未发生' }

    Write-Host ''
    Write-Host '=== 6. 执行第 3 轮端到端 ==='
    & node scripts/e2e-round3.cjs
    $exitCode = $LASTEXITCODE
} finally {
    Write-Host ''
    Write-Host '=== 7. 清理 ==='
    if ($app -and -not $app.HasExited) { $app.Kill(); Write-Host '  - 已停止门户服务' }
    if ($stub -and -not $stub.HasExited) { $stub.Kill(); Write-Host '  - 已停止产品桩' }
    Pop-Location
}

exit $exitCode
