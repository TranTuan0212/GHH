@echo off
title SLOMO LIVE 240FPS HOST SERVER + INTERNET TUNNEL
color 0A
echo ========================================================
echo       SLOMO LIVE 240FPS HOST SERVER + CLOUDFLARE TUNNEL
echo ========================================================
echo.
echo [1/4] Giai phong cac cong 4000, 1935, 8000 cu (neu co)...
taskkill /F /FI "WINDOWTITLE eq SloMo Host Server Backend*" 2>nul
taskkill /F /IM cloudflared.exe 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :4000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :1935 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :8000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
echo.
echo [2/4] Khoi dong Backend Server tren cong 4000...
start "SloMo Host Server Backend" cmd /k "cd /d "%~dp0server" && npm start"
echo.
echo [3/4] Cho server san sang (3 giay)...
timeout /t 3 /nobreak >nul
echo.
echo [4/4] Khoi tao duong truyen Cloudflare Tunnel toan cau...
echo ========================================================
echo  * Ket noi qua Wi-Fi nha: Mo http://localhost:4000
echo  * Ket noi qua Internet / 4G: Copy link https://....trycloudflare.com ben duoi
echo ========================================================
echo.
cloudflared tunnel --url http://localhost:4000
pause
