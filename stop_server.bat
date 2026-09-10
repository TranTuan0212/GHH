@echo off
setlocal EnableExtensions
title DUNG HOST SERVER
color 0C
echo Dang tat SloMo backend va MediaMTX...
REM /T is important: backend owns Node Media Server and its FFmpeg children.
taskkill /F /T /FI "WINDOWTITLE eq SloMo Host Server Backend*" >nul 2>nul
taskkill /F /T /FI "WINDOWTITLE eq SloMo MediaMTX WebRTC*" >nul 2>nul
REM Process MediaMTX co the bi mo co khi cua so cmd bi dong/doi title. Giai phong
REM cac cong rieng cua relay de lan start tiep theo luon nap duoc dung config.
for %%P in (4000 1935 8000 8554 8889 8189) do (
  for /f "tokens=5" %%A in ('netstat -aon -p tcp ^| findstr /r /c:":%%P .*LISTENING"') do taskkill /F /T /PID %%A >nul 2>nul
)
REM ICE uses UDP as well as TCP. netstat's UDP layout puts PID in column 4.
for /f "tokens=4" %%A in ('netstat -aon -p udp ^| findstr /r /c:":8189 "') do taskkill /F /T /PID %%A >nul 2>nul
echo.
echo Da dung backend, Node Media Server, FFmpeg va MediaMTX.
if /I not "%~1"=="--quiet" pause
