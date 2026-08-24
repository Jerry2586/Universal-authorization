@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在启动通用 Key 授权服务器一键搭建程序...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"

if errorlevel 1 (
  echo.
  echo 搭建失败，请查看上面的错误信息。
  pause
  exit /b 1
)

echo.
echo 搭建完成，按任意键关闭窗口。
pause >nul
