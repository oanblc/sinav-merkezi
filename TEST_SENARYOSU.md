# Test Senaryosu - Toplu PDF Yükleme Sistemi

## Gerekli Hazırlıklar

### 1. Sunucuyu Başlatın
```bash
npm start
```
Tarayıcıda: http://localhost:3000

### 2. Test Kullanıcıları Oluşturun

#### Rehber Öğretmen
- Kullanıcı Adı: `rehber1`
- Email: `rehber@test.com`
- Şifre: `123456`
- Kullanıcı Tipi: **rehber_ogretmen**

#### Veliler
**Veli 1:**
- Kullanıcı Adı: `veli1`
- Email: `veli1@test.com`
- Şifre: `123456`
- Kullanıcı Tipi: **veli**

**Veli 2:**
- Kullanıcı Adı: `veli2`
- Email: `veli2@test.com`
- Şifre: `123456`
- Kullanıcı Tipi: **veli**

### 3. Öğrencileri Ekleyin

Rehber öğretmen olarak giriş yapın ve şu öğrencileri ekleyin:

**Öğrenci 1:**
- Ad Soyad: `Ahmet Yılmaz`
- TC No: `12345678901`
- Veli Kullanıcı Adı: `veli1`

**Öğrenci 2:**
- Ad Soyad: `Ayşe Demir`
- TC No: `12345678902`
- Veli Kullanıcı Adı: `veli1`

**Öğrenci 3:**
- Ad Soyad: `Mehmet Kaya`
- TC No: `12345678903`
- Veli Kullanıcı Adı: `veli2`

## Test 1: Toplu PDF Yükleme

### Adımlar:
1. Rehber öğretmen olarak giriş yapın
2. Dashboard'dan **"Toplu PDF Yükle"** butonuna tıklayın
3. Formu doldurun:
   - **Sınav Adı**: TYT Deneme 1
   - **Sınav Türü**: TYT
   - **Sınav Tarihi**: (Bugünün tarihi)
4. **"Dosya Seç"** butonuna tıklayıp birden fazla PDF dosyası seçin
5. **"Yükle ve Eşleştir"** butonuna tıklayın

### Beklenen Sonuçlar:
- ✅ Progress bar %100'e ulaşmalı
- ✅ Eşleştirme sonuçları tablosu görünmeli
- ✅ Eşleşen öğrenciler yeşil badge ile işaretlenmeli
- ✅ Eşleşmeyen öğrenciler kırmızı badge ile işaretlenmeli
- ✅ Özet istatistikler gösterilmeli:
  - Toplam PDF sayısı
  - Başarılı eşleşme sayısı
  - Başarısız eşleşme sayısı
  - Kaydedilen sonuç sayısı

## Test 2: PDF İsim Eşleştirme Algoritması

### Test Durumları:

| PDF'deki İsim | Veritabanındaki İsim | Beklenen Sonuç |
|---------------|---------------------|----------------|
| AHMET YILMAZ | Ahmet Yılmaz | ✅ Eşleşmeli (100%) |
| Ahmet YILMAZ | Ahmet Yılmaz | ✅ Eşleşmeli (100%) |
| ahmet yılmaz | Ahmet Yılmaz | ✅ Eşleşmeli (100%) |
| Ahmet Y. | Ahmet Yılmaz | ⚠️ Eşleşmeyebilir (<%60) |
| Ali Yılmaz | Ahmet Yılmaz | ❌ Eşleşmemeli |

### Test Adımları:
1. Farklı formatlarda isim içeren PDF'ler hazırlayın
2. Toplu yükleme yapın
3. Eşleştirme sonuçlarını kontrol edin

## Test 3: Veli Sonuç Görüntüleme

### Adımlar:
1. Veli olarak giriş yapın (`veli1` / `123456`)
2. Dashboard'da öğrencileri görüntüleyin
3. Bir öğrencinin **"PDF Sonuçları"** butonuna tıklayın
4. PDF sonuçları sayfasında her sınav kartını kontrol edin
5. **"PDF'i Görüntüle"** butonuna tıklayıp PDF'in açılıp açılmadığını kontrol edin

### Beklenen Sonuçlar:
- ✅ Öğrenci kartlarında PDF sonuç sayısı görünmeli
- ✅ PDF sonuçları sayfasında tüm yüklenen PDF'ler listelenmelidir
- ✅ Her kart şunları içermelidir:
  - Sınav adı
  - Sınav tarihi
  - Sınav türü (badge)
  - Öğrenci numarası
  - Sınıf
  - Puan (varsa)
- ✅ PDF modal'da dosya düzgün görüntülenmelidir

## Test 4: Hata Durumları

### 4.1 PDF Parse Hatası
- **Test**: Bozuk veya okunamayan PDF yükleyin
- **Beklenen**: Hata mesajı gösterilmeli, diğer PDF'ler işlenmeye devam etmeli

### 4.2 Eşleşme Bulunamama
- **Test**: Veritabanında olmayan öğrenci ismi içeren PDF yükleyin
- **Beklenen**: Kırmızı badge ile "Eşleşmedi" gösterilmeli

### 4.3 Boş Dosya Yükleme
- **Test**: Dosya seçmeden "Yükle ve Eşleştir" butonuna tıklayın
- **Beklenen**: Buton devre dışı olmalı

## Test 5: Performans

### Test Senaryosu:
- 50 adet PDF dosyası birden yükleyin
- İşlem süresini ölçün
- Tüm dosyaların başarıyla işlendiğini doğrulayın

### Beklenen:
- ✅ Tüm dosyalar sırayla işlenmeli
- ✅ Progress bar düzgün çalışmalı
- ✅ Hiçbir dosya atlanmamalı
- ✅ Veritabanına doğru kayıt yapılmalı

## Test 6: Güvenlik

### 6.1 Yetki Kontrolü
- **Test**: Veli hesabıyla `/rehber/toplu-sinav-yukle` adresine gitmeyi deneyin
- **Beklenen**: Erişim reddedilmeli, yönlendirme yapılmalı

### 6.2 Başka Velinin Öğrencisi
- **Test**: `veli1` hesabıyla `veli2`'nin öğrencisinin sonuçlarına erişmeyi deneyin
- **Beklenen**: Erişim reddedilmeli

## Notlar

### PDF Formatı
Sistem şu formatta PDF'leri parse edebilir:
```
Öğrenci    Numara    Sınıf
Ahmet Yılmaz    12345    12-A

Ders        Soru  Doğru  Yanlış  Net
Türkçe      40    35     3       33,50
Matematik   40    30     5       27,50
...
Puan: ▼ 485,50
```

### Sık Karşılaşılan Sorunlar

**1. PDF'ler görüntülenmiyor**
- Çözüm: `server.js`'de uploads klasörünün static olarak sunulduğundan emin olun

**2. Eşleşme skoru çok düşük**
- Çözüm: Öğrenci isimlerini veritabanına girerken PDF'deki isimle uyumlu şekilde girin
- Tam isim kullanın (kısaltmalar kullanmayın)

**3. PDF parse edilemiyor**
- Çözüm: PDF formatının düzgün olduğundan emin olun
- Regex pattern'leri PDF formatınıza göre güncelleyin

## Başarı Kriterleri

✅ Tüm testler başarıyla tamamlanmalı
✅ Hata durumları düzgün handle edilmeli
✅ Kullanıcı deneyimi akıcı olmalı
✅ Güvenlik kontrolleri çalışmalı
✅ Performans kabul edilebilir seviyede olmalı

