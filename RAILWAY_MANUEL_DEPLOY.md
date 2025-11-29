# Railway Manuel Deploy Rehberi

## 1. Projeyi ZIP'leyin
- `egitim` klasörünü sağ tık → "Send to" → "Compressed folder"
- VEYA: 7-Zip, WinRAR kullanın

## 2. Railway Dashboard
1. https://railway.app adresine gidin
2. GitHub ile giriş yapın
3. "New Project" → "Empty Project"

## 3. GitHub Repo Oluşturun
1. https://github.com/new
2. Repository adı: sinav-merkezi
3. Public seçin
4. "Create repository"

## 4. GitHub Desktop Kullanın (En Kolay)
1. https://desktop.github.com/ - indir
2. Kurulum yap
3. GitHub hesabıyla giriş yap
4. "Add" → "Add Existing Repository"
5. `C:\Users\yusuf\Desktop\egitim` seç
6. "Publish repository" tıkla

## 5. Railway'e Bağlayın
1. Railway Dashboard
2. "New Project" → "Deploy from GitHub repo"
3. `sinav-merkezi` seç
4. Deploy başlayacak!

## 6. Environment Variables
Railway Dashboard'da:
- Settings → Variables
- Ekle:
  - `NODE_ENV` = `production`
  - `SESSION_SECRET` = `super-secret-key-123`

## 7. Domain Ekle
- Settings → Domains
- "Generate Domain" tıkla
- Örn: `sinav-merkezi-production.up.railway.app`

