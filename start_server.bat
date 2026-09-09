@echo off
title SLOMO LIVE 240FPS HOST SERVER + INTERNET TUNNEL
color 0A
echo ========================================================
echo       SLOMO LIVE 240FPS HOST SERVER + CLOUDFLARE TUNNEL
echo ========================================================
echo.
echo [1/5] Giai phong cac cong 4000, 1935, 8000 cu (neu co)...
taskkill /F /FI "WINDOWTITLE eq SloMo Host Server Backend*" 2>nul
taskkill /F /IM cloudflared.exe 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :4000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :1935 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :8000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
echo.
echo [2/5] Khoi dong Backend Server tren cong 4000...
start "SloMo Host Server Backend" cmd /k "cd /d "%~dp0server" && npm start"
echo.
echo [3/5] Cho server san sang (3 giay)...
timeout /t 3 /nobreak >nul
echo.
echo [4/5] Khoi tao Cloudflare Tunnel cho cong 4000 (HTTP/Web Admin + API)...
start "SloMo Cloudflare Tunnel 4000" cmd /k "cloudflared tunnel --url http://localhost:4000"
echo.
echo [5/5] Khoi tao Cloudflare Tunnel cho cong 1935 (RTMP Ingest tu iOS)...
echo       ^|^| Day la cong RTMP - neu khong mo, iOS qua 5G se khong the push live.
start "SloMo Cloudflare Tunnel 1935" cmd /k "cloudflared tunnel --url tcp://localhost:1935"
echo.
echo ========================================================
echo  * Ket noi qua Wi-Fi nha:    http://localhost:4000
echo  * Ket noi qua Internet/5G:  Copy link https://....trycloudflare.com
echo                              ben cua so 'SloMo Cloudflare Tunnel 4000'
echo  * RTMP Ingest qua 5G:       Lay hostname cua cua so
echo                              'SloMo Cloudflare Tunnel 1935' va set
echo                              header X-RTMP-Host trong app iOS
echo                              (hoac sua trong server/src/routes/stream.ts).
echo ========================================================
echo.
pause
