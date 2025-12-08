# Railway Log Kontrol Rehberi

## 🔍 Adım 1: Railway Loglarını Kontrol Edin

1. **Railway Dashboard** → https://railway.app/dashboard
2. **sinav-merkezi** projenizi seçin
3. **Deployments** sekmesine gidin
4. **En son deployment**'ı tıklayın (en üstteki)
5. **Logs** sekmesine gidin

## 📋 Loglarda Arayacağınız Hatalar:

### ❌ Hata 1: "SESSION_SECRET environment variable is required"
**Durum:** SESSION_SECRET hala eksik veya yanlış yazılmış
**Çözüm:** 
- Variables sekmesine gidin
- SESSION_SECRET'ın doğru eklendiğinden emin olun
- Büyük/küçük harf duyarlı: `SESSION_SECRET` (tam olarak böyle)

### ❌ Hata 2: "Cannot find module" veya "Module not found"
**Durum:** npm paketleri yüklenmemiş
**Çözüm:** Railway otomatik yükler, ama build loglarını kontrol edin

### ❌ Hata 3: "Database connection error" veya "ENOENT"
**Durum:** Veritabanı dosyası bulunamıyor
**Çözüm:** 
- Railway'de Volume ekleyin (Settings → Volumes)
- Mount Path: `/app/data`
- DB_PATH variable'ını güncelleyin: `./data/sinav_merkezi.db`

### ❌ Hata 4: "Port already in use" veya "EADDRINUSE"
**Durum:** Port çakışması (nadir)
**Çözüm:** Railway otomatik PORT atar, bu hata normalde olmaz

### ❌ Hata 5: Syntax Error veya "Unexpected token"
**Durum:** Kod hatası
**Çözüm:** Loglardaki tam hata mesajını paylaşın

## ✅ Başarılı Deploy İşaretleri:

Loglarda şunları görmelisiniz:
```
✅ Sunucu başarıyla başlatıldı!
🌐 Port: [PORT_NUMARASI]
🔗 URL: http://0.0.0.0:[PORT]
📁 Veritabanı: [DB_PATH]
🌍 Environment: PRODUCTION
==================================================
```

## 🆘 Logları Bana Gönderin

Logların tamamını kopyalayıp paylaşın, özellikle:
- En son 50-100 satır
- Kırmızı hata mesajları
- "Error", "Failed", "Cannot" gibi kelimeler içeren satırlar

