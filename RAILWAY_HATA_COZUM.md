# Railway "Application failed to respond" Hatası Çözümü

## 🔍 Adım 1: Railway Loglarını Kontrol Edin

1. **Railway Dashboard** → https://railway.app/dashboard
2. Projenizi seçin
3. **Deployments** sekmesine gidin
4. **En son deployment**'ı tıklayın
5. **Logs** sekmesine gidin

## 📋 Loglarda Arayacağınız Hatalar:

### ❌ Hata 1: "SESSION_SECRET environment variable is required"
**Çözüm:**
- Railway Dashboard → **Variables** → **Add**
- Key: `SESSION_SECRET`
- Value: Güçlü bir secret (32+ karakter)
- Örnek: `openssl rand -hex 32` komutu ile oluşturun

### ❌ Hata 2: "Port already in use" veya "EADDRINUSE"
**Çözüm:** Railway otomatik PORT atar, bu hata normalde olmaz. Railway support'a başvurun.

### ❌ Hata 3: "Cannot find module" veya "Module not found"
**Çözüm:** 
- `package.json` dosyası doğru mu kontrol edin
- Railway otomatik `npm install` yapacak

### ❌ Hata 4: "Database connection error"
**Çözüm:**
- Railway'de **Volume** ekleyin (Settings → Volumes)
- Mount Path: `/app/data`
- `DB_PATH` variable'ını güncelleyin: `./data/sinav_merkezi.db`

### ❌ Hata 5: Uygulama başlıyor ama hemen kapanıyor
**Çözüm:**
- Logların tamamını kontrol edin
- Hangi satırda hata veriyor bakın

## ✅ Başarılı Deploy İşaretleri:

Loglarda şunları görmelisiniz:
```
✅ Sunucu başarıyla başlatıldı!
🌐 Port: [PORT_NUMARASI]
🔗 URL: http://0.0.0.0:[PORT]
📁 Veritabanı: [DB_PATH]
🌍 Environment: PRODUCTION
```

## 🧪 Test Endpoint'i

Deploy sonrası şu URL'yi test edin:
```
https://www.adanasinavkulubu.com/health
```

Beklenen yanıt:
```json
{
  "status": "ok",
  "timestamp": "2024-...",
  "port": "...",
  "nodeEnv": "production"
}
```

## 🆘 Hala Çalışmıyorsa

1. Railway Dashboard → **Settings** → **Redeploy** butonuna tıklayın
2. Tüm logları kopyalayın
3. Railway Support'a başvurun: https://railway.app/help

---

## 📝 Hızlı Kontrol Listesi

- [ ] SESSION_SECRET environment variable eklendi
- [ ] NODE_ENV=production ayarlandı
- [ ] Loglarda "Sunucu başarıyla başlatıldı!" mesajı var
- [ ] /health endpoint çalışıyor
- [ ] Domain doğru yapılandırıldı

