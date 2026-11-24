@echo off
chcp 65001 >nul
echo ========================================================
echo   SINCRONIZANDO DATOS DEL ERP (047 JORGE ESTRELLA & 079 INGELAB)
echo ========================================================
echo.
python "%~dp0sync_erp.py"
echo.
echo Proceso finalizado. Puedes recargar tu navegador en http://localhost:8085
pause
