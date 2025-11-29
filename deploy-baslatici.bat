@echo off
title Railway Deploy Hizli Baslatici
color 0A

echo ================================================
echo     RAILWAY DEPLOY - HIZLI BASLATICI
echo ================================================
echo.

echo Railway CLI kurulu: [OK]
echo PowerShell execution policy: [OK]
echo.

echo ================================================
echo   SECENEK 1: GIT + RAILWAY CLI (En hizli)
echo ================================================
echo.
echo 1. Git'i kur: https://git-scm.com/download/win
echo 2. PowerShell'i YENIDEN AC (onemli!)
echo 3. Bu komutlari calistir:
echo.
echo    cd C:\Users\yusuf\Desktop\egitim
echo    git init
echo    git add .
echo    git commit -m "Initial commit"
echo    railway login
echo    railway init
echo    railway up
echo.
pause

echo ================================================
echo   SECENEK 2: GITHUB DESKTOP (Gorsel)
echo ================================================
echo.
echo 1. GitHub Desktop kur: https://desktop.github.com/
echo 2. File ^> Add Local Repository
echo 3. C:\Users\yusuf\Desktop\egitim sec
echo 4. Commit ^> Publish repository
echo 5. Railway'e git: https://railway.app
echo 6. New Project ^> Deploy from GitHub repo
echo.
pause

echo ================================================
echo   RAILWAY DASHBOARD
echo ================================================
echo.
echo Railway Dashboard: https://railway.app/dashboard
echo.
start https://railway.app/dashboard
echo.
echo [OK] Railway Dashboard tarayicida acildi!
echo.
pause

