# Otomatik Railway Deployment Script
# Bu script projenizi Railway'e deploy eder

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SINAV MERKEZI - OTOMATIK DEPLOY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Renk fonksiyonları
function Write-Success { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Error { param($msg) Write-Host "✗ $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "ℹ $msg" -ForegroundColor Yellow }

# 1. Git kontrolü
Write-Host "[1/6] Git kontrolü..." -ForegroundColor Cyan
try {
    $gitVersion = git --version 2>$null
    if ($gitVersion) {
        Write-Success "Git kurulu: $gitVersion"
        $gitInstalled = $true
    }
} catch {
    Write-Error "Git kurulu değil!"
    Write-Info "Git'i kurmak için: winget install --id Git.Git -e"
    Write-Info "Veya: https://git-scm.com/download/win"
    $gitInstalled = $false
}
Write-Host ""

# 2. Railway CLI kontrolü
Write-Host "[2/6] Railway CLI kontrolü..." -ForegroundColor Cyan
try {
    $railwayVersion = railway --version 2>$null
    if ($railwayVersion) {
        Write-Success "Railway CLI kurulu"
        $railwayInstalled = $true
    }
} catch {
    Write-Info "Railway CLI kurulu değil, kuruluyor..."
    npm install -g @railway/cli
    $railwayInstalled = $true
    Write-Success "Railway CLI kuruldu"
}
Write-Host ""

# 3. Git repository başlatma
if ($gitInstalled) {
    Write-Host "[3/6] Git repository başlatılıyor..." -ForegroundColor Cyan
    
    if (Test-Path ".git") {
        Write-Info "Git repository zaten mevcut"
    } else {
        git init
        Write-Success "Git repository oluşturuldu"
    }
    
    # .gitignore kontrolü
    if (-not (Test-Path ".gitignore")) {
        Write-Error ".gitignore bulunamadı!"
    } else {
        Write-Success ".gitignore mevcut"
    }
    
    # Git commit
    Write-Info "Dosyalar commit ediliyor..."
    git add .
    git commit -m "Deploy: Egitim klasöründen Railway'e" 2>$null
    Write-Success "Commit tamamlandı"
    Write-Host ""
} else {
    Write-Host "[3/6] Git kurulu olmadığı için atlanıyor..." -ForegroundColor Yellow
    Write-Host ""
}

# 4. Railway Login kontrolü
Write-Host "[4/6] Railway login kontrolü..." -ForegroundColor Cyan
Write-Info "Railway'e login olmanız gerekiyor"
Write-Info "Tarayıcıda authentication sayfası açılacak"
Write-Host ""
Write-Host "Devam etmek için ENTER'a basın (veya Ctrl+C ile iptal edin)..." -ForegroundColor Yellow
$null = Read-Host

# Railway login
railway login

Write-Host ""

# 5. Railway projesi bağlantısı
Write-Host "[5/6] Railway projesi..." -ForegroundColor Cyan
Write-Info "Mevcut projeniz varsa onu seçin, yoksa yeni proje oluşturacak"
Write-Host ""

# Mevcut proje var mı kontrol
$projectExists = Test-Path "railway.json"
if ($projectExists) {
    Write-Info "railway.json bulundu, mevcut proje kullanılacak"
    railway link
} else {
    Write-Info "Yeni proje oluşturuluyor..."
    railway init
}

Write-Host ""

# 6. Deploy!
Write-Host "[6/6] Railway'e deploy ediliyor..." -ForegroundColor Cyan
Write-Info "Bu işlem birkaç dakika sürebilir..."
Write-Host ""

railway up

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DEPLOYMENT TAMAMLANDI!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Domain bilgisi al
Write-Host "Domain bilginizi almak için:" -ForegroundColor Cyan
Write-Host "  railway domain" -ForegroundColor Yellow
Write-Host ""
Write-Host "Logs görmek için:" -ForegroundColor Cyan
Write-Host "  railway logs" -ForegroundColor Yellow
Write-Host ""
Write-Host "Dashboard'u açmak için:" -ForegroundColor Cyan
Write-Host "  railway open" -ForegroundColor Yellow
Write-Host ""

# Domain'i otomatik al
Write-Host "Domain oluşturuluyor..." -ForegroundColor Cyan
railway domain
Write-Host ""

Write-Success "Deployment başarılı! 🚀"
Write-Host ""

