@echo off
setlocal EnableExtensions
title SloMo Live - LAN Server
color 0A

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "WEB_DIR=%ROOT%web"
set "MTX_EXE=%SERVER_DIR%\tools\mediamtx\mediamtx.exe"
set "MTX_CONFIG=%SERVER_DIR%\mediamtx-slomo.yml"
set "BUNDLED_FFMPEG=%SERVER_DIR%\tools\ffmpeg\ffmpeg.exe"
set "BACKEND_LOG=%SERVER_DIR%\backend.log"

echo ========================================================
echo       SLOMO LIVE - LAN DVR + WEBRTC TEST SERVER
echo ========================================================
echo.
echo iPhone va may xem phai cung Wi-Fi voi may nay.
echo Script nay KHONG mo Cloudflare/Pinggy va KHONG can router/VPS.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Hay cai Node.js LTS roi chay lai script.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay npm trong PATH.
  pause
  exit /b 1
)

if not exist "%MTX_EXE%" (
  echo [LOI] Khong tim thay MediaMTX: %MTX_EXE%
  pause
  exit /b 1
)

if exist "%BUNDLED_FFMPEG%" (
  set "FFMPEG_PATH=%BUNDLED_FFMPEG%"
) else (
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo [LOI] Khong tim thay FFmpeg.
    echo       Cai dat ffmpeg vao PATH, hoac dat ffmpeg.exe tai:
    echo       %BUNDLED_FFMPEG%
    echo.
    echo FFmpeg bat buoc de ghi master DVR va tao live WebRTC 60 FPS.
    pause
    exit /b 1
  )
  set "FFMPEG_PATH=ffmpeg"
)

echo [1/5] Dung toan bo dich vu SloMo tu lan chay truoc...
call "%ROOT%stop_server.bat" --quiet
timeout /t 1 /nobreak >nul

echo [2/5] Kiem tra/cai dependency khi can...
pushd "%SERVER_DIR%"
if not exist "node_modules\." (
  call npm ci
  if errorlevel 1 (
    popd
    echo [LOI] Khong cai duoc dependency backend.
    pause
    exit /b 1
  )
)
call npm run build
if errorlevel 1 (
  popd
  echo [LOI] Backend build that bai.
  pause
  exit /b 1
)
popd
pushd "%WEB_DIR%"
if not exist "node_modules\." (
  call npm ci
  if errorlevel 1 (
    popd
    echo [LOI] Khong cai duoc dependency web.
    pause
    exit /b 1
  )
)
call npm run build
if errorlevel 1 (
  popd
  echo [LOI] Web build that bai.
  pause
  exit /b 1
)
popd

echo [3/5] Khoi dong MediaMTX WebRTC ^(RTSP 8554, WHEP 8889, ICE 8189^)...
REM Luon tao relay moi voi mediamtx-slomo.yml. Tai su dung process cu chi dua vao
REM port 8554 co the giu publisher dang treo va lam WHEP tra 404 cho stream moi.
start "SloMo MediaMTX WebRTC" /D "%SERVER_DIR%\tools\mediamtx" cmd /k ""%MTX_EXE%" "%MTX_CONFIG%""
timeout /t 2 /nobreak >nul

echo [4/5] Khoi dong backend ^(web/API 4000, RTMP 1935, HLS 8000, FFmpeg^)...
REM Chay node truc tiep nen, khong long trong `cmd /k` (co the dong som ma khong hien loi).
REM Output duoc ghi vao log de hien nguyen nhan neu health check that bai.
start "SloMo Host Server Backend" /B /D "%SERVER_DIR%" node -e "process.env.FFMPEG_PATH=process.argv[1]; require('./dist/index.js')" "%FFMPEG_PATH%" >> "%BACKEND_LOG%" 2>&1
echo [5/5] Cho backend san sang...
set "READY="
for /L %%I in (1,1,15) do (
  if not defined READY (
    powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:4000/api/health).StatusCode -eq 200 } catch { $false }" | findstr /i "True" >nul && set "READY=1"
    if not defined READY timeout /t 1 /nobreak >nul
  )
)
if not defined READY (
  echo [LOI] Backend chua tra loi o cong 4000. 30 dong loi/cuoi cung:
  if exist "%BACKEND_LOG%" powershell -NoProfile -Command "Get-Content -LiteralPath '%BACKEND_LOG%' -Tail 30"
  echo [LOI] Khong mo web. Sua loi tren roi chay lai start_server.bat.
  if /I not "%~1"=="--quiet" pause
  exit /b 1
) else (
  echo [OK] Toan bo dich vu SloMo da san sang.
)

echo.
echo ========================================================
echo SAN SANG TEST LAN
echo   iOS Server URL: http://192.168.1.10:4000
echo   RTMP ingest:    rtmp://192.168.1.10:1935/live
echo   Web viewer:     http://192.168.1.10:4000
echo.
echo Neu iPhone khong ket noi duoc, mo Windows Firewall cho:
echo   TCP 4000, TCP 1935, TCP 8554, TCP 8889, UDP/TCP 8189
echo ========================================================
echo.
if /I not "%~1"=="--quiet" pause
