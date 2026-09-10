@echo off
title SloMo Live - Open WebRTC Firewall
net session >nul 2>&1
if not %errorlevel%==0 (
  echo ERROR: Hay bam chuot phai file nay va chon "Run as administrator".
  pause
  exit /b 1
)

netsh advfirewall firewall add rule name="SloMo Live WebRTC ICE UDP 8189" dir=in action=allow protocol=UDP localport=8189
netsh advfirewall firewall add rule name="SloMo Live WebRTC ICE TCP 8189" dir=in action=allow protocol=TCP localport=8189
netsh advfirewall firewall add rule name="SloMo Live WebRTC signaling 8889" dir=in action=allow protocol=TCP localport=8889
netsh advfirewall firewall add rule name="SloMo Live RTSP relay 8554" dir=in action=allow protocol=TCP localport=8554

echo.
echo Da mo Windows Firewall:
echo   UDP 8189  - WebRTC ICE media (uu tien)
echo   TCP 8189  - WebRTC ICE fallback
echo   TCP 8889  - WebRTC signaling
echo   TCP 8554  - RTSP relay noi bo
echo.
echo BUOC CON LAI: Port-forward tren router ve IP LAN cua may nay cho 8189 UDP,
echo 8189 TCP va 8889 TCP. Neu ISP dung CGNAT, port-forward se khong hoat dong.
pause
