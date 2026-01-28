@echo off
REM Nine1Bot 启动脚本 (Windows)

setlocal EnableDelayedExpansion

REM 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"

REM 移除末尾的反斜杠
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

REM 运行 Nine1Bot
"%SCRIPT_DIR%\runtime\bun.exe" run "%SCRIPT_DIR%\packages\nine1bot\src\index.ts" %*
