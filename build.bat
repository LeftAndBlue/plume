@echo off
rem Plume ?????vite build + tauri build --bundles nsis
chcp 65001 >nul
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [??] ??? Visual Studio Build Tools???? vcvars64.bat ???
  pause
  exit /b 1
)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0"
call npm run dist
echo.
echo ???src-tauri\target\release\plume.exe
echo      src-tauri\target\release\bundle\nsis\
pause