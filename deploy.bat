@echo off
echo ========================================
echo    SINAV MERKEZI - RAILWAY DEPLOY
echo ========================================
echo.

echo [1/5] GitHub Desktop kurulumunu kontrol et...
echo        https://desktop.github.com/
echo.
pause

echo [2/5] GitHub Desktop'ta projeyi publish et...
echo        - File ^> Add Local Repository
echo        - Secim: C:\Users\yusuf\Desktop\egitim
echo        - Commit message: "Update - Egitim klasorundenki kod"
echo        - Commit to main
echo        - Publish repository (repo adi: sinav-merkezi-new veya baska)
echo.
pause

echo [3/5] Railway'e git ve proje sec...
echo        https://railway.app/dashboard
echo        
echo        SECENEK A - Mevcut sinav-merkezi projesini guncelle:
echo        - Mevcut sinav-merkezi projesine tikla
echo        - Settings ^> Source ^> Connect Repo
echo        - Yeni GitHub repo'nuzu sec
echo        
echo        SECENEK B - Yeni proje olustur:
echo        - New Project ^> Deploy from GitHub repo
echo.
pause

echo [4/5] Repository sec ve deploy baslasin...
echo        - GitHub repo'nuzu secin
echo        - Deploy otomatik baslayacak!
echo.
pause

echo [5/5] Environment Variables ekle...
echo        Railway Dashboard ^> Variables:
echo        - NODE_ENV = production
echo        - SESSION_SECRET = super-secret-key-123
echo        - PORT = 3000
echo.
echo [TAMAMLANDI] Domain al ve kullanmaya basla!
echo        Settings ^> Domains ^> Generate Domain
echo.
pause

