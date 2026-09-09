param(
    [Parameter(Mandatory = $true)][string]$CloudflaredLog,
    [int]$TimeoutSeconds = 30
)

function Wait-ForMatch {
    param(
        [string]$Path,
        [string]$Pattern,
        [int]$TimeoutSeconds
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $Path) {
            $content = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
            if ($content) {
                $m = [regex]::Match($content, $Pattern)
                if ($m.Success) {
                    return $m.Value
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Wait-ForPinggyUrl {
    param(
        [int]$TimeoutSeconds
    )
    # Pinggy Web Debugger API: khi tunnel len xong, http://localhost:4300/urls
    # tra ve JSON chua danh sach URL (bao gom ca tcp://host:port cho TCP tunnel).
    # Cach nay dang tin cay hon nhieu so voi doc banner PTY qua SSH.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-RestMethod -Uri 'http://localhost:4300/urls' -TimeoutSec 3 -ErrorAction Stop
            if ($resp -and $resp.urls) {
                $tcpUrl = $resp.urls | Where-Object { $_ -like 'tcp://*' } | Select-Object -First 1
                if ($tcpUrl) {
                    return $tcpUrl
                }
            }
        } catch {
            # Web Debugger chua san sang / tunnel chua len xong -> thu lai
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

Write-Host ""
Write-Host "Dang doi Cloudflare Tunnel (HTTP) tra ve URL..." -ForegroundColor Cyan
$cfUrl = Wait-ForMatch -Path $CloudflaredLog -Pattern 'https://[a-zA-Z0-9\-]+\.trycloudflare\.com' -TimeoutSeconds $TimeoutSeconds

Write-Host "Dang doi Pinggy Tunnel (RTMP) qua Web Debugger API (localhost:4300)..." -ForegroundColor Cyan
$pgUrl = Wait-ForPinggyUrl -TimeoutSeconds $TimeoutSeconds

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " KET QUA TUNNEL - DIEN THANG VAO APP iOS" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""

if ($cfUrl) {
    Write-Host "  [Server IP / VPS Host URL]" -ForegroundColor Yellow
    Write-Host "  -> $cfUrl" -ForegroundColor White
} else {
    Write-Host "  [Server IP / VPS Host URL]  -> KHONG TIM THAY" -ForegroundColor Red
    Write-Host "  Mo cua so 'SloMo Cloudflare Tunnel 4000 - HTTP' de xem loi chi tiet." -ForegroundColor Red
}

Write-Host ""

if ($pgUrl) {
    # $pgUrl dang: tcp://host:port
    $noScheme = $pgUrl -replace '^tcp://', ''
    $lastColon = $noScheme.LastIndexOf(':')
    $pgHost = $noScheme.Substring(0, $lastColon)
    $pgPort = $noScheme.Substring($lastColon + 1)

    Write-Host "  [RTMP Host Override]" -ForegroundColor Yellow
    Write-Host "  -> Host: $pgHost" -ForegroundColor White
    Write-Host "  -> Port: $pgPort" -ForegroundColor White
} else {
    Write-Host "  [RTMP Host Override]  -> KHONG TIM THAY" -ForegroundColor Red
    Write-Host "  Mo cua so 'SloMo Pinggy Tunnel 1935 - RTMP' de xem loi chi tiet," -ForegroundColor Red
    Write-Host "  hoac thu mo trinh duyet toi http://localhost:4300/urls de kiem tra thu cong." -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " Neu dung cung Wi-Fi voi server: bo qua 2 URL tren, dien" -ForegroundColor Green
Write-Host " thang http://<IP_LAN>:4000 va de trong RTMP Host Override." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
