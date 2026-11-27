@echo off
setlocal
set "NODE_ENV=production"
set "PORT=4177"
set "HOST=127.0.0.1"
set "PMS_DB_PATH=%LOCALAPPDATA%\HOPR-PMS\data\clinic.sqlite"
if not defined PMS_PUBLIC_ORIGIN set "PMS_PUBLIC_ORIGIN=https://desktop-rpl642b.tail350fbe.ts.net"
set "PATH=%LOCALAPPDATA%\Programs\node-v24.20.0-win-x64;%PATH%"

if not exist "%~dp0data\" mkdir "%~dp0data"
if not exist "%~dp0data\" exit /b 1
cd /d "%~dp0"
if errorlevel 1 exit /b 1
node server.js
