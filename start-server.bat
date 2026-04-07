@echo off
cd /d "%~dp0"

echo.
echo  Fluid Particles - local server
echo  ------------------------------
echo  Open in browser:  http://localhost:8000
echo  Stop server:      Ctrl+C
echo.

:: Try Python 3
python -m http.server 8000 2>nul
if %errorlevel% equ 0 goto :done

:: Try Windows Python launcher
py -m http.server 8000 2>nul
if %errorlevel% equ 0 goto :done

:: Fallback: npx http-server (requires Node.js)
echo Python not found. Using npx http-server...
npx -y http-server -p 8000
goto :done

:done
