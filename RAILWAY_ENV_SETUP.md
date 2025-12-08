# Railway Environment Variables Kurulum Rehberi

## 🚨 502 Bad Gateway Hatası Çözümü

502 hatası genellikle uygulamanın başlamamasından kaynaklanır. En yaygın neden: **SESSION_SECRET** environment variable'ının eksik olması.

## ✅ Yapılması Gerekenler

### 1. Railway Dashboard'a Giriş Yapın
- https://railway.app/dashboard adresine gidin
- Projenizi seçin

### 2. Environment Variables Ekleyin
**Settings → Variables** bölümüne gidin ve şu değişkenleri ekleyin:

#### 🔴 ZORUNLU (Olmasa uygulama başlamaz):
```
SESSION_SECRET = [güçlü bir secret key - en az 32 karakter]
```
**Örnek değer oluşturma:**
```bash
openssl rand -hex 32
```
veya online: https://randomkeygen.com/

#### 🟡 ÖNERİLEN:
```
NODE_ENV = production
PORT = [Railway otomatik atar, boş bırakabilirsiniz]
DB_PATH = ./sinav_merkezi.db
```

#### 🟢 OPSİYONEL (İleride ekleyebilirsiniz):
```
# WhatsApp API
WHATSAPP_API_URL = https://gate.whapi.cloud
WHATSAPP_API_TOKEN = [token]

# PayTR Ödeme
PAYTR_MERCHANT_ID = [id]
PAYTR_MERCHANT_KEY = [key]
PAYTR_MERCHANT_SALT = [salt]

# E-posta (Opsiyonel)
SMTP_HOST = smtp.gmail.com
SMTP_PORT = 587
SMTP_USER = [email]
SMTP_PASS = [password]

# Rate Limiting
RATE_LIMIT_WINDOW = 15
RATE_LIMIT_MAX = 1000
LOGIN_RATE_LIMIT_MAX = 5
UPLOAD_RATE_LIMIT_MAX = 50

# Upload Limits
MAX_FILE_SIZE = 10485760
MAX_FILES_PER_UPLOAD = 1
```

### 3. Deploy Loglarını Kontrol Edin
**Deployments → Son deployment → Logs** bölümünden:
- ✅ "Sunucu başarıyla başlatıldı!" mesajını görmelisiniz
- ❌ "SESSION_SECRET environment variable is required" hatası varsa → Environment variable ekleyin
- ❌ Başka hatalar varsa → Logları kontrol edin

### 4. Health Check Endpoint'i Test Edin
Deploy sonrası şu URL'yi ziyaret edin:
```
https://www.adanasinavkulubu.com/health
```

Beklenen yanıt:
```json
{
  "status": "ok",
  "timestamp": "2024-...",
  "port": "3000",
  "nodeEnv": "production"
}
```

## 🔍 Sorun Giderme

### Hata: "SESSION_SECRET environment variable is required"
**Çözüm:** Railway Dashboard → Variables → SESSION_SECRET ekleyin

### Hata: "Port already in use"
**Çözüm:** Railway otomatik PORT atar, bu hata normalde olmaz. Eğer görürseniz Railway support'a başvurun.

### Hata: "Database connection error"
**Çözüm:** 
1. Railway'de Volume ekleyin (Settings → Volumes)
2. Mount Path: `/app/data`
3. DB_PATH'i güncelleyin: `./data/sinav_merkezi.db`

### Uygulama başlıyor ama 502 hatası devam ediyor
**Kontrol edin:**
1. Railway'de domain ayarları doğru mu?
2. Health check endpoint çalışıyor mu? (`/health`)
3. Loglarda başka hata var mı?

## 📝 Hızlı Kontrol Listesi

- [ ] SESSION_SECRET eklendi
- [ ] NODE_ENV=production ayarlandı
- [ ] Deploy loglarında "Sunucu başarıyla başlatıldı!" mesajı var
- [ ] /health endpoint çalışıyor
- [ ] Domain doğru yapılandırıldı

## 🆘 Hala Çalışmıyorsa

1. Railway Dashboard → Deployments → Son deployment → Logs'u kontrol edin
2. Tüm hata mesajlarını kopyalayın
3. Railway Support'a başvurun veya GitHub Issues'a yazın

---

**Not:** Environment variables ekledikten sonra Railway otomatik olarak yeniden deploy edecektir. Birkaç dakika bekleyin.

