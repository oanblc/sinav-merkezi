# Sınav Merkezi Web Sitesi

Sınav sonuçlarını yönetmek ve görüntülemek için web uygulaması (Node.js/Express).

## Özellikler

- 👨‍👩‍👧‍👦 **Veli Paneli**: Öğrenci sonuçlarını görüntüleme
- 👨‍🏫 **Rehber Öğretmen Paneli**: Sınav yönetimi ve öğrenci ekleme
- 📊 **Excel/CSV Yükleme**: DataFrame dosyasını sayfalara ayırma ve öğrenci isimleri ile eşleştirme
- 📄 **Toplu PDF Yükleme**: Birden fazla öğrenciye ait PDF sınav sonuçlarını otomatik eşleştirme
- 🤖 **Akıllı İsim Eşleştirme**: PDF'deki öğrenci isimlerini veritabanındaki isimlerle %60+ doğrulukla eşleştirme
- 📈 **Detaylı Raporlama**: Eşleşme başarı oranları ve detaylı sonuç görüntüleme

## Gereksinimler

- Node.js (v14 veya üzeri)
- npm (Node Package Manager)

## Kurulum

1. Bağımlılıkları yükleyin:
```bash
npm install
```

## Çalıştırma

```bash
npm start
```

veya geliştirme modu için (otomatik yeniden başlatma):

```bash
npm run dev
```

Tarayıcıda `http://localhost:3000` adresine gidin.

## İlk Kullanım

### 1. Hesap Oluşturma
- Tarayıcıda `http://localhost:3000` adresine gidin
- "Kayıt Ol" sayfasından **Rehber Öğretmen** hesabı oluşturun
- Veliler için de hesap oluşturun (user_type: **veli**)

### 2. Öğrenci Ekleme
- Rehber öğretmen olarak giriş yapın
- "Öğrenci Ekle" butonuna tıklayın
- Öğrenci adı, TC no ve veli kullanıcı adını girin
- **ÖNEMLİ**: Öğrenci adını PDF'deki isimle uyumlu şekilde girin

### 3. Sınav Sonuçları Yükleme

#### Excel/CSV Yükleme:
- Dashboard'dan "Sınav Dosyası Yükle (Excel/CSV)" seçin
- Excel/CSV dosyanızı yükleyin
- Öğrenci isimleri içeren kolon otomatik algılanır

#### Toplu PDF Yükleme:
- Dashboard'dan "Toplu PDF Yükle" butonuna tıklayın
- Sınav adı, türü ve tarihi girin
- Birden fazla PDF dosyası seçin
- "Yükle ve Eşleştir" butonuna tıklayın
- Sistem her PDF'deki öğrenci adını otomatik olarak veritabanındaki öğrencilerle eşleştirir

### 4. Sonuçları Görüntüleme
- Veli olarak giriş yapın
- Öğrencinizi seçin
- "Excel/CSV Sonuçları" veya "PDF Sonuçları" sekmelerinden sonuçları görüntüleyin

## PDF Eşleştirme Nasıl Çalışır?

Sistem gelişmiş bir isim eşleştirme algoritması kullanır:

1. **Normalizasyon**: Türkçe karakterler normalize edilir (ı→i, ğ→g, vb.)
2. **Kelime Karşılaştırma**: İsimdeki kelimeler tek tek karşılaştırılır
3. **Skor Hesaplama**: %60 ve üzeri eşleşme skoru gereklidir
4. **En İyi Eşleşme**: Her PDF için en yüksek skorlu öğrenci seçilir

### Örnek Eşleşmeler:
- "Ahmet Yılmaz" ↔ "AHMET YILMAZ" ✅ (100% eşleşme)
- "Mehmet Ali Demir" ↔ "Mehmet Demir" ✅ (66% eşleşme)
- "Ayşe KARA" ↔ "ayse kara" ✅ (100% eşleşme)

## Teknolojiler

- **Backend**: Node.js, Express.js
- **Veritabanı**: SQLite (better-sqlite3)
- **Template Engine**: EJS
- **Dosya İşleme**: ExcelJS, csv-parser
- **Güvenlik**: bcrypt (şifre hashleme), express-session
