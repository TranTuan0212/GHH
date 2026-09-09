@echo off
title SLOMO LIVE 240FPS HOST SERVER + INTERNET TUNNEL
color 0A
echo ========================================================
echo    SLOMO LIVE 240FPS HOST SERVER + CLOUDFLARE + PINGGY
echo ========================================================
echo.
echo [LUU Y QUAN TRONG]
echo  Cloudflare Quick Tunnel (trycloudflare.com) CHI ho tro HTTP.
echo  RTMP la giao thuc TCP tho -^> khong the dung Cloudflare Quick
echo  Tunnel cho RTMP (iOS se khong bao gio connect duoc qua 5G).
echo  Script nay dung: Cloudflare cho HTTP (4000), Pinggy (SSH) cho RTMP (1935).
echo  (ngrok free hien bat buoc xac minh the tin dung cho TCP endpoint,
echo   nen dung Pinggy thay the - mien phi, khong can the, khong can cai dat
echo   gi them, dung san ssh cua Windows 10/11).
echo.

echo [1/5] Giai phong cac cong 4000, 1935, 8000 cu (neu co)...
taskkill /F /FI "WINDOWTITLE eq SloMo Host Server Backend*" 2>nul
taskkill /F /IM cloudflared.exe 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :4000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :1935 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :8000 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
REM Giai phong cong metrics rieng cua cloudflared, phong khi lan chay truoc bi treo
for /f "tokens=5" %%a in ('netstat -aon 2^^^>nul ^^^| findstr :20241 ^^^| findstr LISTENING') do taskkill /f /pid %%a 2>nul
echo.

echo [2/5] Khoi dong Backend Server tren cong 4000...
start "SloMo Host Server Backend" cmd /k "cd /d "%~dp0server" && npm start"
echo.

echo [3/5] Cho server san sang (3 giay)...
timeout /t 3 /nobreak >nul
echo.

echo [4/5] Khoi tao Cloudflare Tunnel cho cong 4000 (HTTP/Web Admin + API)...
start "SloMo Cloudflare Tunnel 4000 - HTTP" cmd /k "cloudflared tunnel --protocol http2 --url http://localhost:4000 --metrics localhost:20241"
echo.

echo [5/5] Khoi tao Pinggy TCP Tunnel cho cong 1935 (RTMP Ingest tu iOS)...
echo       ^|^| Day la cong RTMP that su - moi hoat dong duoc voi ket noi
echo       ^|^| RTMP tho tu app iOS qua 5G (Cloudflare Quick Tunnel khong the).
start "SloMo Pinggy Tunnel 1935 - RTMP" cmd /k "ssh -p 443 -o StrictHostKeyChecking=no -R0:localhost:1935 tcp@free.pinggy.io"
echo.

echo [Cho 6 giay de ca 2 tunnel len xong truoc khi ban doc URL]...
timeout /t 6 /nobreak >nul
echo.

echo ========================================================
echo  CACH DOC KET QUA:
echo.
echo  1) Cua so "SloMo Cloudflare Tunnel 4000 - HTTP":
echo     Tim dong trong khung ve, dang:
echo         https://xxxx-xxxx-xxxx.trycloudflare.com
echo     -^> Dien vao o "Server IP / VPS Host URL" trong app iOS.
echo        (KHONG them :4000 phia sau)
echo.
echo  2) Cua so "SloMo Pinggy Tunnel 1935 - RTMP":
echo     Tim dong dang:
echo         tcp://rndnj-xxx.a.free.pinggy.online:37315
echo     -^> Host  = rndnj-xxx.a.free.pinggy.online   (phan truoc dau ":")
echo     -^> Port  = 37315                            (so sau dau ":")
echo     Dien 2 gia tri nay vao "RTMP Host Override" + "Port" trong app iOS.
echo     LUU Y: URL/Port nay se DOI MOI KHI cua so nay khoi dong lai (goi
echo     free khong co dia chi co dinh) - phai doc lai va dien lai moi lan.
echo.
echo  * Neu dung cung Wi-Fi voi server: khong can tunnel gi ca, dien
echo    thang http://192.168.1.X:4000 va de trong RTMP Host Override.
echo.
echo  KIEM TRA LOI: mo ca 2 cua so, neu thay dong do "ERR" hoac
echo  "address already in use" thi bao lai ngay, dung dien URL cu.
echo ========================================================
echo.
pause
