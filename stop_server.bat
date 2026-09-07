@echo off
title DUNG HOST SERVER
color 0C
echo Dang tat Host Server va Cloudflare Tunnel...
taskkill /F /FI "WINDOWTITLE eq SloMo Host Server Backend*" 2>nul
taskkill /F /IM cloudflared.exe 2>nul
echo.
echo Da dung thanh cong toan bo Server va Tunnel!
pause
