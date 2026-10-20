@echo off
title Flip PDF
cd /d "%~dp0"
where python >nul 2>nul && ( python server.py & goto :eof )
where py >nul 2>nul && ( py server.py & goto :eof )
where node >nul 2>nul && ( node server.js & goto :eof )
echo.
echo   Flip PDF needs either Python or Node.js installed (both are free).
echo   Python: https://www.python.org/downloads/   Node: https://nodejs.org/
echo.
pause
