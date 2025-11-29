# 🚀 Sınav Merkezi - Railway Deployment Rehberi

## 📋 Önkoşullar

Projeniz deploy için hazır! Şimdi adım adım ilerleyelim:

---

## 🎯 Yöntem 1: GitHub Desktop ile Deployment (EN KOLAY - ÖNERİLEN)

### Adım 1: GitHub Desktop Kurulumu
1. **İndir**: https://desktop.github.com/
2. **Kur** ve **GitHub hesabınızla giriş yapın**

### Adım 2: Projeyi GitHub'a Yükle
1. GitHub Desktop'ı aç
2. `File` → `Add Local Repository`
3. `C:\Users\yusuf\Desktop\egitim` klasörünü seç
4. "Initialize Git Repository" de
5. Sol altta **Commit message** yaz: `Update - Egitim klasöründen deploy`
6. **Commit to main** butonuna tıkla
7. **Publish repository** butonuna tıkla
   - Repository name: `sinav-merkezi` ⚠️ VEYA başka bir isim (Railway'deki projeyle eşleştirmek için)
   - ✅ Keep this code private (istersen)
   - **Publish Repository** tıkla

**NOT**: Railway'de zaten `sinav-merkezi` projeniz varsa:
- Ya yeni bir repo adı kullanın (örn: `sinav-merkezi-v2`)
- Ya da mevcut Railway projesini bu yeni repo ile bağlayın (Adım 3'te)

### Adım 3: Railway'e Deploy

#### Seçenek A: Mevcut Railway Projenizi Güncelle
Railway'de zaten `sinav-merkezi` projeniz varsa:

1. **Railway Dashboard**'a git: https://railway.app/dashboard
2. Mevcut `sinav-merkezi` projenize tıkla
3. **Settings** → **Source**
4. **Connect Repo** tıkla
5. Yeni oluşturduğunuz GitHub repo'sunu seç
6. Railway otomatik yeniden deploy başlatacak! 🎉

#### Seçenek B: Yeni Proje Oluştur
1. **Railway**'e git: https://railway.app/
2. **New Project** tıkla
3. **Deploy from GitHub repo** seç
4. GitHub'a yüklediğiniz repository'yi seç
5. Railway otomatik deploy başlatacak! 🎉

### Adım 4: Environment Variables Ayarla
1. Railway Dashboard'da projenize tıklayın
2. **Variables** sekmesine gidin
3. Şu değişkenleri ekleyin:

```
NODE_ENV=production
SESSION_SECRET=super-secret-key-change-this-123456
PORT=3000
```

### Adım 5: Domain Al
1. **Settings** → **Domains**
2. **Generate Domain** tıkla
3. URL'niz hazır! Örnek: `sinav-merkezi-production.up.railway.app`

---

## 🎯 Yöntem 2: PowerShell Execution Policy Düzelt + Railway CLI

### Adım 1: PowerShell'i Yönetici Olarak Aç
1. Windows tuşu → `PowerShell` ara
2. **Sağ tık** → **Run as Administrator**

### Adım 2: Execution Policy Ayarla
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Adım 3: Railway CLI Kur
```powershell
npm install -g @railway/cli
```

### Adım 4: Git Kur (Eğer yoksa)
Git indirin: https://git-scm.com/download/win

### Adım 5: Deploy Et
```powershell
# Projenizin klasörüne gidin
cd C:\Users\yusuf\Desktop\egitim

# Railway'e login
railway login

# Yeni proje oluştur
railway init

# Deploy et!
railway up

# Domain ekle
railway domain
```

---

## 🎯 Yöntem 3: Manuel ZIP Upload (Railway Dashboard)

### Adım 1: Gereksiz Dosyaları Temizle
1. `node_modules` klasörünü SİL
2. `sinav_merkezi.db` dosyasını SİL (production'da yenisi oluşacak)
3. `uploads` klasörü büyükse SİL veya temizle

### Adım 2: ZIP Oluştur
1. `egitim` klasörünü **sağ tık**
2. **Send to** → **Compressed (zipped) folder**
3. `egitim.zip` oluşacak

### Adım 3: Railway'e Yükle
1. https://railway.app/ → **Login**
2. **New Project** → **Empty Project**
3. **+ New** → **Empty Service**
4. **Settings** → **Source** kısmında:
   - Şu an manuel upload direkt desteklenmeyebilir
   - **Bu yöntem yerine Yöntem 1'i öneririm!**

---

## ✅ Deploy Sonrası Kontroller

### 1. Logs Kontrol
Railway Dashboard → **Deployments** → En son deployment → **View Logs**

### 2. Database İlk Kurulum
İlk deployment'ta database tablolarınız otomatik oluşacak (server.js'deki init kodları çalışacak)

### 3. Test Et
Domain URL'nize gidin ve test edin:
- ✅ Ana sayfa yükleniyor mu?
- ✅ Login çalışıyor mu?
- ✅ Database bağlantısı var mı?

---

## 🛠️ Sorun Giderme

### Railway Logs'da "Module not found" hatası
```bash
# Railway Dashboard → Settings → Build Command:
npm install

# Start Command:
node server.js
```

### Database hatası (ENOENT)
SQLite production'da sorun yaratabilir. Railway'de şunları yapın:

1. **Volume ekleyin** (Settings → Volumes):
   - Mount Path: `/app/data`
   
2. `server.js`'de database yolunu güncelleyin:
```javascript
const db = new sqlite3.Database(path.join(__dirname, 'data', 'sinav_merkezi.db'));
```

### Port hatası
Railway otomatik PORT assign eder. `server.js`'nizde zaten var:
```javascript
const PORT = process.env.PORT || 3000;
```

---

## 🎉 Başarılı Deployment Mesajı

Railway logs'da şunu göreceksiniz:
```
✅ Server http://localhost:3000 üzerinde çalışıyor...
✅ Database bağlantısı başarılı
✅ Tablolar oluşturuldu
```

---

## 📞 Önerilen Yöntem Özeti

**En kolay ve güvenilir yöntem: YÖNTEM 1 (GitHub Desktop)**

1. ✅ GitHub Desktop kur
2. ✅ Projeyi GitHub'a yükle
3. ✅ Railway'e GitHub repo'dan deploy et
4. ✅ Domain al ve kullanmaya başla!

**Toplam süre: ~10 dakika**

---

## 🔗 Faydalı Linkler

- Railway Dashboard: https://railway.app/dashboard
- Railway Docs: https://docs.railway.app/
- GitHub Desktop: https://desktop.github.com/
- Git for Windows: https://git-scm.com/download/win

---

**Not**: Deployment sonrası güncelleme yapmak için sadece GitHub Desktop'ta commit + push yapmanız yeterli. Railway otomatik yeniden deploy eder! 🚀

