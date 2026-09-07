@echo off
title CLOUDFLARE INTERNET TUNNEL
color 0B
echo ========================================================
echo       KHOI DONG DUONG TRUYEN INTERNET TOAN CAU
echo ========================================================
echo.
echo Dang ket noi vao mang Cloudflare...
echo Vui long copy duong link https://....trycloudflare.com ben duoi de gui cho nguoi xem / iPhone!
echo.
cloudflared tunnel --url http://localhost:4000
pause
