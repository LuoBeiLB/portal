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

# 专属端口与专属库：避免与开发机上正在运行的门户实例冲突（见第 1 步注释）
$appPort = 3300
$e2eDatabase = 'cloud_portal_e2e'

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
    # ⚠️ 只清产品桩端口，**不再杀 3000**（2026-10-12 改）。
    # 原先会 Stop-ListenerOnPort -Port 3000，但开发机上常跑着自己的门户实例，
    # 杀它之后它可能被 npm/终端自动拉起来，重新占住 3000 ——
    # 于是本脚本的 app 起不来（EADDRINUSE 静默失败），而健康检查探的是**那个实例**，
    # 断言就会读到它连的真实云存储数据（价格 50000 而不是桩的 3000）。
    # 现在用专属端口 3300 + 独立库 cloud_portal_e2e，与开发实例彻底互不干扰。
    Stop-ListenerOnPort -Port 8081
    Stop-ListenerOnPort -Port $appPort

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
    # 用 STUB_* 覆盖 .env：让门户指向**测试桩**而不是 .env 里配的真实云存储。
    # process.loadEnvFile 不覆盖已存在的环境变量，所以这里的进程环境优先。
    # 同时注入一个"仅入站"产品（云手机）的密钥，验证入站鉴权与出站同步已解耦。
    $env:PRODUCT_STORAGE_BASE_URL = 'http://127.0.0.1:8081'
    $env:PRODUCT_STORAGE_INTERNAL_KEY = 'stub-storage-key'
    $env:STUB_PRODUCT_INTERNAL_KEY = 'stub-storage-key'
    $env:PRODUCT_PHONE_INTERNAL_KEY = 'e2e-inbound-only-phone-key'
    $env:PRODUCT_PHONE_BASE_URL = ''
    # 公开接口限流：**第 3 轮不需要验证限流**，而它自己要打 6 次 /shop/products，
    # 阈值调成 5 会把后面的商品查询拒掉（表现为"取不到最便宜 SKU"这类莫名失败）。
    # 限流验证在第 2 轮（那里的 15 段断言会先把配额清空再打满）。
    $env:PUBLIC_RATE_WINDOW = '60'
    $env:PUBLIC_RATE_MAX = '300'

    # ⚠️ **必须用独立测试库**（2026-10-12 加的）：
    # 开发者常在自己机器上跑着一个门户实例（读 .env → 真实云存储），它每 10 分钟
    # 把 p_product / p_product_sync_log 覆盖成真实商品。而本脚本会先清空这两张表，
    # 于是断言里"storage-500g = 3000 分"（桩价）会被真实价（50000）冲掉，
    # 表现为"莫名其妙的价格不符失败"，且**跑之前完全看不出来**（踩过一整轮）。
    # 用独立库后，本脚本与那个实例彻底隔离，也不再污染正在使用的数据。
    $env:DB_DATABASE = $e2eDatabase
    $env:APP_PORT = "$appPort"
    Write-Host "  - 数据库: $env:DB_DATABASE（与 .env 里的运营库隔离）"
    Write-Host "  - 端口:   $appPort（不用 3000，避免与开发实例抢端口）"

    $stub = Start-Process -FilePath 'node' -ArgumentList 'scripts/stub-product-server.cjs' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\stub-run.txt" `
        -RedirectStandardError "$env:TEMP\stub-run-err.txt" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2

    $app = Start-Process -FilePath 'node' -ArgumentList 'dist/main.js' `
        -WorkingDirectory $server -RedirectStandardOutput "$env:TEMP\portal-run.txt" `
        -RedirectStandardError "$env:TEMP\portal-run-err.txt" -PassThru -WindowStyle Hidden

    # 健康检查必须打在**自己的端口**上。
    # 早先这里探的是 3000：一旦本脚本的 app 因 EADDRINUSE 起不来，
    # 探到的其实是开发实例，会误判"就绪"并继续跑出一堆价格不符的假失败。
    $baseUrl = "http://127.0.0.1:$appPort"
    $ready = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri "$baseUrl/api/healthz" -TimeoutSec 3
            if ($health.code -eq 0) { Write-Host "  - 门户就绪（$($i + 1)s）"; $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        Get-Content "$env:TEMP\portal-run-err.txt" -ErrorAction SilentlyContinue |
            Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
        throw "门户未能就绪（$baseUrl）"
    }
    if ($app.HasExited) { throw "门户进程已退出（exit=$($app.ExitCode)），检查上面的 stderr" }

    Write-Host '=== 5. 等待首次商品同步 ==='
    # 不再靠"桩被调用过"判断（那只说明请求发出去了，商品未必已落库）。
    # 直接查**测试库**里有没有商品：这才是断言真正依赖的状态。
    $synced = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $count = & node -e "const m=require('mysql2/promise');m.createConnection({host:process.env.DB_HOST||'127.0.0.1',user:process.env.DB_USERNAME||'root',password:process.env.DB_PASSWORD||'root',database:process.env.DB_DATABASE}).then(async c=>{const [r]=await c.query('SELECT COUNT(*) n FROM p_product WHERE is_active=1');console.log(r[0].n);await c.end()}).catch(()=>console.log('0'))"
        if ([int]$count -gt 0) { Write-Host "  - 测试库已有 $count 条在售商品"; $synced = $true; break }
    }
    if (-not $synced) { throw '等待超时：测试库里始终没有商品（同步没成功，继续跑只会得到一串假失败）' }

    Write-Host ''
    Write-Host '=== 6. 执行第 3 轮端到端 ==='
    $env:E2E_BASE_URL = $baseUrl
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
