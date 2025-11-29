# 📱 WhatsApp Bildirim Sistemi - Whapi.cloud Entegrasyonu

## 🎯 Genel Bakış

Bu sistem, yeni sınav talepleri geldiğinde otomatik olarak WhatsApp üzerinden bildirim gönderir. 
**[Whapi.cloud](https://whapi.cloud/tr/docs)** API'si kullanılarak entegre edilmiştir.

---

## 🚀 Kurulum Adımları

### 1. Whapi.cloud Hesabı Oluşturma

1. **[whapi.cloud](https://whapi.cloud/tr/docs)** adresine gidin
2. **"Şimdi Kaydol"** butonuna tıklayın
3. Ücretsiz geliştirici hesabınızı oluşturun (5 gün deneme)
4. Email onayı yapın

### 2. WhatsApp Bağlantısı

1. Whapi.cloud Dashboard'a giriş yapın
2. **"New Channel"** butonuna tıklayın
3. Kanal adı verin (örn: "Sınav Merkezi Bot")
4. QR kod ile WhatsApp hesabınızı bağlayın
   - Telefonunuzda WhatsApp'ı açın
   - Ayarlar → Bağlı Cihazlar → Cihaz Bağla
   - QR kodu tarayın

### 3. API Token Alma

1. Dashboard'da oluşturduğunuz kanalı seçin
2. **Settings** → **API Token** bölümüne gidin
3. Token'ı kopyalayın (örn: `Bearer aBcD1234eFgH5678...`)

### 4. Sistem Ayarları

1. Kurum hesabıyla sisteme giriş yapın
2. **Kurum Paneli → WhatsApp Bildirimleri** sayfasına gidin
   - URL: `http://localhost:3000/kurum/whatsapp-ayarlari`

3. Formu doldurun:
   ```
   API URL: https://gate.whapi.cloud/messages/text
   API Token: [Whapi.cloud'dan aldığınız token]
   Alıcı Telefon: +905551234567 (kendi numaranız)
   ```

4. **"Sistemi Aktif Et"** kutucuğunu işaretleyin
5. **"Ayarları Kaydet"** butonuna tıklayın

### 5. Test Etme

1. Aynı sayfada **"Test Mesajı Gönder"** butonuna tıklayın
2. Birkaç saniye içinde WhatsApp'ınıza test mesajı gelecektir
3. Console loglarını kontrol edin (başarılı/başarısız)

---

## 📋 Bildirim Akışı

### Yeni Talep Geldiğinde

1. Kullanıcı `/sinav-paketleri` sayfasından talep gönderir
2. Talep veritabanına kaydedilir
3. Sistem veli bilgilerini alır
4. WhatsApp ayarları kontrol edilir (aktif mi?)
5. Bildirim mesajı oluşturulur
6. Whapi.cloud API'ye POST isteği gönderilir
7. Yanıt loglanır ve veritabanına kaydedilir

### Bildirim Formatı

```
🔔 YENİ SINAV TALEBİ

👤 Veli: Ahmet Yılmaz
📞 Telefon: +905551234567
📧 E-posta: ahmet@example.com

📚 Sınav: 8. Sınıf Matematik Deneme
💰 Fiyat: 150 TL
📅 Tarih: 25 Aralık 2025

⏱️ Talep Zamanı: 22.11.2025 14:30
```

---

## 🔧 Teknik Detaylar

### API Endpoint

```
POST https://gate.whapi.cloud/messages/text
```

### Headers

```
Content-Type: application/json
Authorization: Bearer YOUR_API_TOKEN
```

### Request Body

```json
{
  "to": "905551234567@s.whatsapp.net",
  "body": "Mesaj içeriği"
}
```

### Telefon Formatı

Sistem otomatik olarak telefon numarasını Whapi.cloud formatına çevirir:
- **Giriş:** `+905551234567` veya `05551234567`
- **İşlenen:** `905551234567`
- **API Formatı:** `905551234567@s.whatsapp.net`

---

## 📊 Veritabanı Tabloları

### `whatsapp_ayarlari`

| Kolon | Tip | Açıklama |
|-------|-----|----------|
| id | INTEGER | Birincil anahtar |
| api_url | TEXT | Whapi.cloud endpoint |
| api_token | TEXT | Bearer token |
| phone_number | TEXT | Alıcı telefon numarası |
| aktif | INTEGER | 0: Pasif, 1: Aktif |
| created_at | DATETIME | Oluşturma tarihi |
| updated_at | DATETIME | Güncelleme tarihi |

### `bildirim_gecmisi`

| Kolon | Tip | Açıklama |
|-------|-----|----------|
| id | INTEGER | Birincil anahtar |
| bildirim_tipi | TEXT | yeni_talep, test, vb. |
| alici_telefon | TEXT | Gönderilen numara |
| mesaj | TEXT | Mesaj içeriği |
| durum | TEXT | basarili, basarisiz, simulasyon |
| hata_mesaji | TEXT | Hata varsa detayı |
| created_at | DATETIME | Gönderim tarihi |

---

## 🎨 Kod Örnekleri

### Backend (server.js)

```javascript
// WhatsApp bildirimi gönder
const result = await whatsappBildirimGonder(
  '+905551234567',
  'Test mesajı',
  'test'
);

if (result.success) {
  console.log('✅ Bildirim gönderildi!');
} else {
  console.error('❌ Hata:', result.error);
}
```

### Manuel Test (curl)

```bash
curl -X POST https://gate.whapi.cloud/messages/text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "to": "905551234567@s.whatsapp.net",
    "body": "Test mesajı"
  }'
```

---

## ⚠️ Önemli Notlar

### Güvenlik

- ✅ API Token'ı **asla** GitHub'a yüklemeyin
- ✅ `.env` dosyası kullanarak token'ı saklayabilirsiniz
- ✅ Sunucu loglarını düzenli kontrol edin

### Limitler

- **Whapi.cloud Ücretsiz Plan:**
  - 5 gün deneme süresi
  - Günlük mesaj limiti: 1000 (plan'a göre değişir)
  - Detaylı limit bilgisi için: [Fiyatlandırma](https://whapi.cloud/tr/pricing)

### Hata Yönetimi

Sistem otomatik olarak hataları yönetir:
1. API hatası → Veritabanına kaydedilir
2. Bağlantı hatası → Console'a yazılır
3. Token yoksa → Simülasyon modu (sadece log)

---

## 📚 Ek Kaynaklar

- **Whapi.cloud Dokümantasyonu:** https://whapi.cloud/tr/docs
- **API Referansı:** https://whapi.cloud/docs/api
- **Node.js Bot Örneği:** https://github.com/whapi-cloud/whapi-bot-examples
- **Python SDK:** https://github.com/whapi-cloud/whapi-python-sdk
- **PHP SDK:** https://github.com/whapi-cloud/whapi-php-sdk

---

## 🐛 Sorun Giderme

### "API Token bulunamadı" Hatası

**Çözüm:** WhatsApp ayarları sayfasından token'ı kaydetmeyi unutmayın ve "Sistemi Aktif Et" kutucuğunu işaretleyin.

### "Bağlantı Hatası"

**Çözüm:**
1. İnternet bağlantınızı kontrol edin
2. API URL'in doğru olduğundan emin olun
3. Firewall ayarlarını kontrol edin

### "Telefon Numarası Geçersiz"

**Çözüm:**
- Format: `+905551234567` (ülke kodu ile)
- Türkiye için `+90` zorunlu
- Boşluk veya tire kullanmayın

### Mesaj Gelmiyor

**Çözüm:**
1. WhatsApp bağlantısının aktif olduğunu kontrol edin (Whapi.cloud Dashboard)
2. Telefon numarasının doğru olduğundan emin olun
3. `bildirim_gecmisi` tablosunu kontrol edin
4. Console loglarını inceleyin

---

## 💡 İpuçları

1. **Test Modu:** Önce test mesajı göndererek sistemi kontrol edin
2. **Loglama:** `bildirim_gecmisi` tablosunu düzenli kontrol edin
3. **Yedekleme:** API token'ınızı güvenli bir yerde saklayın
4. **Monitoring:** Günlük limit kontrolü için dashboard'u takip edin

---

## 🎉 Tamamlandı!

Artık WhatsApp bildirim sisteminiz aktif! Her yeni talep geldiğinde otomatik olarak bilgilendirileceksiniz.

**Başarılar! 🚀**

