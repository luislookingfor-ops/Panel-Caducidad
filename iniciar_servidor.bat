@echo off
chcp 65001 >nul
echo Iniciando servidor local en http://localhost:8085 ...
start http://localhost:8085
python -m http.server 8085 --directory "%~dp0"
