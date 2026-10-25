@echo off
chcp 65001 >nul
title KHOI DONG SERVER 1 + AI YOLO + WEB (TEST CUNG WIFI)

echo =====================================================================
echo           HE THONG TEST SERVER 1 + AI YOLO + WEB CUNG WIFI
echo =====================================================================
echo.
echo [1] DIA CHI IP MAY TINH CUA BAN TRONG MANG WIFI:
echo.
echo       ==^> http://192.168.0.175:4000
echo.
echo [2] HUONG DAN TEST TREN IPHONE VA MAY TINH:
echo   - Tren may tinh: Mo trinh duyet vao: http://localhost:4000
echo   - Tren iPhone: Ket noi cung mang Wi-Fi, mo App Live vao cai dat
echo     nhap dia chi Server: http://192.168.0.175:4000
echo   - Tren Web: Chon [Che do 2 (Ban cuoc AI)], re chuot vao tay chia
echo.
echo =====================================================================
echo Dang khoi dong AI YOLOv8 Service (Port 5001)...
start "YOLOv8 AI Service" cmd /k "cd /d %~dp0server\ai && python yolo_service.py"

timeout /t 2 >nul

echo Dang khoi dong Server 1 Backend + Web (Port 4000)...
cd /d %~dp0server
node dist/index.js

pause
