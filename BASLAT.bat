@echo off
chcp 65001 >nul
title Soru Ekleme
cd /d "%~dp0"

cls
echo ================================================================
echo                    SORU EKLEME UYGULAMASI
echo ================================================================
echo.
echo IPUCU: Uygulama acikken bu siyah pencereyi KAPATMAYINIZ.
echo (Kucultup simge durumuna alabilirsiniz.)
echo.

where node >nul 2>nul
if %errorlevel%==0 (
    node "%~dp0sunucu.js"
) else (
    echo [UYARI] Node.js bulunamadi. Uygulama acilacak ama soru OKUMA otomatik kurulumu
    echo YAPILAMAZ. Cozmek icin https://nodejs.org adresinden
    echo "LTS" surumunu kurup bu dosyayi tekrar calistirin.
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sunucu.ps1"
)

pause
