@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem === ANSI color setup (Windows 10+ / Windows 11) ===
for /f %%A in ('echo prompt $E ^| cmd') do set "ESC=%%A"
set "RESET=%ESC%[0m"
set "BOLD=%ESC%[1m"
set "DIM=%ESC%[2m"
set "RED=%ESC%[91m"
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "BLUE=%ESC%[94m"
set "MAGENTA=%ESC%[95m"
set "CYAN=%ESC%[96m"
set "WHITE=%ESC%[97m"
set "GREY=%ESC%[90m"

rem === helper tags ===
set "TAG_OK=[ OK ]"
set "TAG_FAIL=[FAIL]"
set "TAG_WARN=[WARN]"
set "TAG_INFO=[INFO]"
set "TAG_DB=[ DB ]"

call :banner

rem ============================================================
rem  1. Verify Node.js and npm
rem ============================================================
call :section "1/6" "Checking base tooling"

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  call :fail "Node.js not found. Install Node.js LTS and try again."
  goto :halt
)
for /f "delims=" %%V in ('node -v') do set "NODE_VER=%%V"
call :ok "Node.js !NODE_VER!"

where npm >nul 2>nul
if errorlevel 1 (
  call :fail "npm not found. Reinstall Node.js LTS."
  goto :halt
)
for /f "delims=" %%V in ('npm -v') do set "NPM_VER=%%V"
call :ok "npm !NPM_VER!"

rem ============================================================
rem  2. Verify Cloudflare Tunnel (Auto-Install)
rem ============================================================
call :section "2/6" "Checking Cloudflare Tunnel"

set "CLOUDFLARED="
for /f "delims=" %%C in ('where cloudflared 2^>nul ^| findstr /I /R /C:"cloudflared\.exe$"') do if not defined CLOUDFLARED set "CLOUDFLARED=%%C"
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles%\cloudflared\cloudflared.exe"

if not defined CLOUDFLARED (
  call :warn "cloudflared.exe not found. Attempting automatic installation via winget..."
  call :info "Running: winget install --id Cloudflare.cloudflared --exact"
  winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements
  
  rem -- ตรวจสอบผลลัพธ์หลังการติดตั้ง --
  if errorlevel 1 (
    call :fail "Automatic installation failed. This might be due to a Windows Installer conflict (Error 1618) or winget missing."
    echo %GREY%         Please try restarting your PC and running this script again,%RESET%
    echo %GREY%         or download the installer manually from:%RESET%
    echo %GREY%         https://github.com/cloudflare/cloudflared/releases%RESET%
    goto :halt
  )
  
  rem -- อัปเดต PATH ชั่วคราวเพื่อให้เรียกใช้ได้ทันที --
  set "PATH=%ProgramFiles%\cloudflared;%PATH%"
  
  rem -- ตรวจสอบอีกครั้ง --
  if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles%\cloudflared\cloudflared.exe"
  
  if not defined CLOUDFLARED (
    call :fail "Installation appeared successful, but cloudflared.exe is still missing."
    echo %GREY%         Please close this window, open a new one, and run start.bat again.%RESET%
    goto :halt
  )
  call :ok "cloudflared installed successfully."
) else (
  call :ok "cloudflared located"
)
echo %GREY%         !CLOUDFLARED!%RESET%

rem ============================================================
rem  3. Verify .env
rem ============================================================
call :section "3/6" "Checking .env configuration"

if not exist ".env" (
  call :fail ".env file missing. Create one from .env.example."
  goto :halt
)
call :ok ".env file found"

findstr /R /C:"^MONGO_URI=." .env >nul
if errorlevel 1 (
  call :fail "MONGO_URI is not set in .env"
  goto :halt
)
call :ok "MONGO_URI configured"

findstr /R /C:"^JWT_SECRET=." .env >nul
if errorlevel 1 (
  call :fail "JWT_SECRET is not set in .env"
  goto :halt
)
call :ok "JWT_SECRET configured"

rem ============================================================
rem  4. Install dependencies and build CSS
rem ============================================================
call :section "4/6" "Preparing application"

if not exist "node_modules" (
  call :info "node_modules not found — running npm install..."
  call npm install
  if errorlevel 1 (
    call :fail "npm install failed. Check your internet connection."
    goto :halt
  )
  call :ok "Dependencies installed"
) else (
  call :ok "node_modules present (skipping install)"
)

call :info "Building Tailwind CSS..."
call npm run build:css
if errorlevel 1 (
  call :fail "CSS build failed."
  goto :halt
)
call :ok "CSS build complete"

rem ============================================================
rem  5. Verify MongoDB connection
rem ============================================================
call :section "5/6" "Checking MongoDB connection"

node -e "require('dotenv').config();const dns=require('dns');dns.setServers(['8.8.8.8','1.1.1.1']);const m=require('mongoose');m.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000,family:4}).then(()=>{console.log('  mongo OK');return m.disconnect()}).then(()=>process.exit(0)).catch(e=>{console.error('  mongo FAIL:',e.message);process.exit(1)})"
if errorlevel 1 (
  call :fail "MongoDB connection failed. Check MONGO_URI, Atlas, and DNS."
  goto :halt
)
call :ok "MongoDB reachable"

rem ============================================================
rem  6. Start web server + HTTPS tunnel
rem ============================================================
call :section "6/6" "Starting Server + HTTPS Tunnel"

echo %GREY%  ┌───────────────────────────────────────────────────────────┐%RESET%
echo %GREY%  │%RESET%  %CYAN%Server%RESET%    %DIM%Runs on this machine (localhost:3000)│%RESET%
echo %GREY%  │%RESET%  %CYAN%Tunnel%RESET%    %DIM%Public HTTPS URL for phones / customers%RESET%
echo %GREY%  │%RESET%  %CYAN%Ready%RESET%     %DIM%Use only the URL on the [READY] line%RESET%
echo %GREY%  │%RESET%  %CYAN%Keep%RESET%      %DIM%This window open while the app is running%RESET%
echo %GREY%  └───────────────────────────────────────────────────────────┘%RESET%
echo.

node scripts/run-public.js
if errorlevel 1 (
  echo.
  call :fail "Web server or HTTPS tunnel failed to start."
  echo %GREY%         See [WEB] / [TUNNEL] lines above for the cause.%RESET%
  goto :halt
)

echo.
call :ok "Server and Tunnel are running — press Ctrl+C to stop."
echo.
pause
goto :end


rem ============================================================
rem  helper routines
rem ============================================================
:banner
echo.
echo %MAGENTA%  ╔═══════════════════════════════════════════════════════════╗%RESET%
echo %MAGENTA%  ║%RESET%                                                           %MAGENTA%║%RESET%
echo %MAGENTA%  ║%RESET%   %BOLD%%WHITE% TEEHID BUFFET %RESET% %DIM%%GREY%· Smart Queue Restaurant%RESET%            %MAGENTA%    ║%RESET%
echo %MAGENTA%  ║%RESET%   %GREY%Queue • Dine-in • Kitchen • Checkout%RESET%                %MAGENTA%    ║%RESET%
echo %MAGENTA%  ║%RESET%                                                           %MAGENTA%║%RESET%
echo %MAGENTA%  ╚═══════════════════════════════════════════════════════════╝%RESET%
echo.
exit /b 0

:section
echo.
echo %CYAN%%BOLD%  ── %~1 %~2 %GREY%%ESC%[90m─────────────────────────────%RESET%
exit /b 0

:ok
echo %GREEN%   %TAG_OK%%RESET%  %~1
exit /b 0

:fail
echo %RED%   %TAG_FAIL%%RESET%  %~1
exit /b 0

:warn
echo %YELLOW%   %TAG_WARN%%RESET%  %~1
exit /b 0

:info
echo %BLUE%   %TAG_INFO%%RESET%  %~1
exit /b 0

:halt
echo.
echo %RED%%BOLD%  ✖ Aborted — fix the issue above and try again.%RESET%
echo.
pause
goto :end

:end
endlocal