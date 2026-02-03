@echo off
echo ========================================
echo   Livia - Build Script
echo ========================================
echo.

cd /d "%~dp0livia-windows"

echo [1/3] Restoring packages...
dotnet restore

echo.
echo [2/3] Building project...
dotnet build -c Release

echo.
echo [3/3] Publishing single-file executable...
dotnet publish -c Release -o ../dist

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo The executable is located at: dist\Livia.exe
echo.
echo To distribute:
echo   1. Copy dist\Livia.exe to anywhere on the user's computer
echo   2. Run Livia.exe (requires Discord to be running)
echo   3. The app will appear in the system tray
echo.
pause
