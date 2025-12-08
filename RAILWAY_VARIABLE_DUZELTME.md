# Railway Variable Düzeltme Rehberi

## ❌ Sorun
Railway'de SESSION_SECRET variable'ı yanlış formatta eklenmiş. Hata:
```
ERROR: invalid key-value pair "=   SESSION_SECRET=P5ilMh0CcW53gOLBvLw5SEdrG151zKb5": empty key
```

## ✅ Çözüm

### Adım 1: Eski Variable'ı Silin
1. Railway Dashboard → **Variables** sekmesine gidin
2. SESSION_SECRET variable'ını bulun
3. **Silin** (X butonuna tıklayın veya Delete)

### Adım 2: Yeni Variable'ı Doğru Formatta Ekleyin

**ÖNEMLİ:** Boşluk veya özel karakter olmamalı!

1. **VARIABLE_NAME** alanına (ilk input):
   ```
   SESSION_SECRET
   ```
   - Sadece `SESSION_SECRET` yazın
   - Başında/sonunda boşluk olmasın
   - Büyük harflerle yazın

2. **VALUE** alanına (ikinci input):
   ```
   P5ilMh0CcW53gOLBvLw5SEdrG151zKb5
   ```
   - Sadece secret key'i yazın
   - Başında/sonunda boşluk olmasın
   - Özel karakter yoksa sorun yok

3. **Add** butonuna tıklayın

### Adım 3: Kontrol Edin
Variables listesinde şöyle görünmeli:
```
SESSION_SECRET = P5ilMh0CcW53gOLBvLw5SEdrG151zKb5
```

**YANLIŞ:**
- `=   SESSION_SECRET=...` (başında = var)
- ` SESSION_SECRET ` (boşluklar var)
- `session_secret` (küçük harf)

**DOĞRU:**
- `SESSION_SECRET` (tam olarak böyle)

### Adım 4: Yeniden Deploy
1. Variable'ı düzelttikten sonra Railway otomatik deploy başlatacak
2. **Deployments** sekmesine gidin
3. Yeni deployment'ı izleyin
4. **Deploy Logs**'da artık hata olmamalı

## 🎯 Beklenen Sonuç

Deploy Logs'da şunu görmelisiniz:
```
✅ Sunucu başarıyla başlatıldı!
🌐 Port: [PORT]
🔗 URL: http://0.0.0.0:[PORT]
```

