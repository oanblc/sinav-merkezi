# 🎓 Sınav Merkezi - Simülasyon Sınav Yönetim Sistemi

Türkiye'nin önde gelen simülasyon sınav merkezi için geliştirilmiş, modern ve güvenli web platformu.

## 🚀 Özellikler

### 👨‍💼 Kurum Yöneticisi
- ✅ Sınav oluşturma ve yönetimi
- ✅ Akıllı PDF sonuç yükleme (5 katmanlı AI eşleştirme)
- ✅ Öğrenci ve rehber öğretmen yönetimi
- ✅ Sınav paketleri oluşturma
- ✅ WhatsApp bildirim sistemi
- ✅ Kurumsal içerik yönetimi (Admin Panel)
- ✅ Detaylı raporlama ve istatistikler

### 👨‍🏫 Rehber Öğretmen
- ✅ Sınav sonuçlarını görüntüleme
- ✅ Öğrenci performans takibi
- ✅ Talep yönetimi
- ✅ Raporlama

### 👨‍👩‍👧‍👦 Veli
- ✅ Öğrenci kayıt ve yönetimi
- ✅ Sınav sonuçlarını görüntüleme
- ✅ PDF sonuç indirme
- ✅ Sınav takvimi
- ✅ Online ödeme (PayTR entegrasyonu)
- ✅ Talep gönderme

## 🛠️ Teknolojiler

- **Backend**: Node.js + Express.js
- **Veritabanı**: SQLite3
- **Template Engine**: EJS
- **PDF İşleme**: pdf-parse, pdf-lib
- **Güvenlik**: bcrypt, express-session, express-rate-limit
- **Ödeme**: PayTR API
- **Bildirim**: WhatsApp (Whapi.cloud API)
- **Frontend**: Bootstrap 5, Bootstrap Icons

## 📦 Kurulum

### Gereksinimler
- Node.js 14+ 
- npm 6+

### Adımlar

1. **Projeyi klonlayın**
```bash
git clone <repo-url>
cd sinav-merkezi
```

2. **Bağımlılıkları yükleyin**
```bash
npm install
```

3. **Environment variables ayarlayın**
```bash
cp env.example.txt .env
# .env dosyasını düzenleyin
```

4. **Sunucuyu başlatın**
```bash
npm start
```

5. **Tarayıcıda açın**
```
http://localhost:3000
```

## 🔐 Varsayılan Kullanıcılar

### Kurum Yöneticisi
- **Kullanıcı Adı**: admin
- **Şifre**: admin123

### Test Velisi
- **Kullanıcı Adı**: veli1
- **Şifre**: 123456

## 🎯 Akıllı PDF Eşleştirme Sistemi

Sistem, yüklenen PDF sınav sonuçlarını öğrencilerle otomatik eşleştirir:

### 5 Katmanlı Strateji
1. **Öğrenilmiş Paternler**: Geçmiş başarılı eşleştirmelerden öğrenir
2. **Veritabanı Benzerliği**: Kayıtlı öğrenci isimleriyle karşılaştırır
3. **Pozisyon Tabanlı**: PDF'deki isim pozisyonunu analiz eder
4. **Gelişmiş Regex**: Karmaşık isim formatlarını tanır
5. **Fuzzy Search**: Levenshtein distance ile benzer isimleri bulur

### Özellikler
- 🧠 Makine öğrenmesi ile sürekli gelişir
- 📊 %80+ güven skorunda otomatik eşleştirir
- 🔍 Manuel eşleştirme desteği
- 👁️ PDF önizleme
- 🔄 Yeniden eşleştirme imkanı

## 🔒 Güvenlik

- ✅ **Session Güvenliği**: httpOnly, secure, sameSite
- ✅ **Rate Limiting**: DDoS koruması
- ✅ **Input Validation**: XSS ve SQL injection koruması
- ✅ **Password Hashing**: bcrypt ile şifreleme
- ✅ **Role-Based Access Control**: Rol bazlı yetkilendirme
- ✅ **File Upload Security**: Dosya tipi ve boyut kontrolü

## 📊 Veritabanı Yapısı

### Ana Tablolar
- `users`: Kullanıcılar (kurum, veli, rehber)
- `ogrenciler`: Öğrenci kayıtları
- `sinavlar`: Sınav bilgileri
- `sinav_katilimcilari`: Sınav-öğrenci ilişkisi
- `sinav_sonuclari`: Sınav sonuçları
- `sinav_paketleri`: Sınav paketleri
- `kurumsal_icerik`: Kurumsal sayfa içerikleri
- `pdf_learning_patterns`: AI öğrenme verileri
- `whatsapp_ayarlari`: WhatsApp API ayarları
- `bildirim_gecmisi`: Bildirim logları

## 🚀 Production Deployment

### 1. PM2 ile Başlatma
```bash
npm install -g pm2
pm2 start server.js --name sinav-merkezi
pm2 save
pm2 startup
```

### 2. Nginx Reverse Proxy
```nginx
server {
    listen 80;
    server_name sinavmerkezi.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. SSL Sertifikası (Let's Encrypt)
```bash
sudo certbot --nginx -d sinavmerkezi.com
```

### 4. Otomatik Yedekleme
```bash
# Crontab ekleyin
0 2 * * * /usr/bin/sqlite3 /path/to/sinav_merkezi.db ".backup '/backup/sinav_$(date +\%Y\%m\%d).db'"
```

## 📱 WhatsApp Entegrasyonu

Whapi.cloud API kullanılarak:
- Sınav sonuç bildirimleri
- Talep onay bildirimleri
- Özel mesajlar

### Kurulum
1. [Whapi.cloud](https://whapi.cloud) hesabı oluşturun
2. API token alın
3. Admin panelden ayarları yapın

## 💳 Ödeme Entegrasyonu

PayTR API ile güvenli online ödeme:
- Kredi kartı
- Banka kartı
- Sanal pos

### Kurulum
1. [PayTR](https://www.paytr.com) hesabı oluşturun
2. Merchant bilgilerini alın
3. `.env` dosyasına ekleyin

## 📈 Performans İyileştirmeleri

- ✅ Database indexing
- ✅ Session caching
- ✅ Gzip compression
- ✅ Static file caching
- ✅ Lazy loading
- ✅ Connection pooling

## 🐛 Hata Ayıklama

### Loglar
```bash
# PM2 logları
pm2 logs sinav-merkezi

# Hata logları
tail -f logs/error.log
```

### Veritabanı Kontrolü
```bash
sqlite3 sinav_merkezi.db
.tables
.schema users
```

## 🤝 Katkıda Bulunma

1. Fork edin
2. Feature branch oluşturun (`git checkout -b feature/amazing-feature`)
3. Commit edin (`git commit -m 'Add amazing feature'`)
4. Push edin (`git push origin feature/amazing-feature`)
5. Pull Request açın

## 📝 Lisans

Bu proje özel lisans altındadır. Ticari kullanım için iletişime geçin.

## 📞 İletişim

- **Web**: https://sinavmerkezi.com
- **E-posta**: info@sinavmerkezi.com
- **Telefon**: +90 XXX XXX XX XX

## 🎉 Teşekkürler

30 yıllık eğitim tecrübesiyle Türkiye'nin her köşesindeki öğrencilere ulaşmak için geliştirilen bu platform, binlerce öğrencinin başarı yolculuğuna katkıda bulunmaktadır.

---

**Geliştirme Tarihi**: 2024
**Versiyon**: 1.0.0
**Durum**: ✅ Production Ready
