# Proje Optimizasyon Rehberi

## Mevcut Durum
- **Proje Boyutu**: ~414 MB (0.4 GB)
- **Hedef**: Maksimum 4 GB
- **Durum**: ✅ Hedefin altında

## Yapılan Optimizasyonlar

### 1. ✅ Gereksiz Dosyalar Temizlendi
- `server.js.bak` - Backup dosyası silindi
- `server.js.bak2` - Backup dosyası silindi
- `tmp_idx.txt` - Geçici dosya silindi

### 2. ✅ .gitignore Güncellendi
- `uploads/` klasörü git'e dahil edilmeyecek (kullanıcı yüklemeleri)
- Backup dosyaları için kurallar eklendi (*.bak, *.bak2, *.backup)
- Gelecekte oluşturulacak backup dosyaları otomatik olarak ignore edilecek

## Proje Boyutunu Kontrol Etme

### PowerShell ile Boyut Kontrolü
```powershell
# Toplam proje boyutu
Get-ChildItem -Recurse -ErrorAction SilentlyContinue | 
  Measure-Object -Property Length -Sum | 
  Select-Object @{Name="Size(GB)";Expression={[math]::Round($_.Sum / 1GB, 2)}}, 
                @{Name="Size(MB)";Expression={[math]::Round($_.Sum / 1MB, 2)}}

# Klasör bazında boyut kontrolü
Get-ChildItem -Directory | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | 
           Measure-Object -Property Length -Sum).Sum
  [PSCustomObject]@{
    Folder = $_.Name
    "Size(MB)" = [math]::Round($size / 1MB, 2)
  }
} | Sort-Object "Size(MB)" -Descending
```

## Gelecek İçin Öneriler

### 1. Uploads Klasörü Yönetimi
- `uploads/` klasörü git'e dahil edilmiyor (✅ zaten yapıldı)
- **Öneri**: Eski PDF dosyalarını periyodik olarak temizleyin
- **Öneri**: PDF dosyalarını sıkıştırılmış formatda saklayın
- **Öneri**: Eski sınav sonuçlarını arşivleyin (ör: 6 aydan eski dosyalar)

### 2. Veritabanı Yönetimi
- `*.db` dosyaları git'e dahil edilmiyor (✅ zaten yapıldı)
- **Öneri**: Veritabanı boyutunu düzenli kontrol edin
- **Öneri**: Eski verileri arşivleyin veya temizleyin
- **Öneri**: VACUUM komutu ile veritabanını optimize edin

### 3. node_modules
- `node_modules/` git'e dahil edilmiyor (✅ zaten yapıldı)
- **Öneri**: Production'da sadece gerekli paketleri yükleyin (`npm ci --production`)
- **Öneri**: Kullanılmayan bağımlılıkları kaldırın

### 4. Geliştirme Dosyaları
Aşağıdaki dosyalar geliştirme amaçlı kullanılıyor:
- `test-modules.js` - Modül test scripti
- `test-detailed-modules.js` - Detaylı test scripti
- `modify.js`, `modify2.js`, `modify3.js` - Server.js modifikasyon scriptleri
- `autoMatcher.js` - Otomatik eşleştirme sistemi
- `insertIndex.js` - Index ekleme scripti

**Öneri**: Bu dosyaları bir `scripts/` veya `dev-tools/` klasörüne taşıyın ve .gitignore'a ekleyin (isteğe bağlı)

### 5. Büyük Dosyalar
- `tur.traineddata` (4.46 MB) - Tesseract OCR için Türkçe dil modeli
- **Öneri**: Bu dosya gerekli, ancak git'e dahil edilmemesi için .gitignore'a eklenebilir

### 6. Log Dosyaları
- Log dosyaları git'e dahil edilmiyor (✅ zaten yapıldı)
- **Öneri**: Log dosyalarını periyodik olarak temizleyin
- **Öneri**: Log rotation kullanın

## Otomatik Temizlik Scripti (Öneri)

Aşağıdaki gibi bir temizlik scripti oluşturabilirsiniz:

```javascript
// cleanup.js
const fs = require('fs');
const path = require('path');

// Eski log dosyalarını temizle (30 günden eski)
function cleanOldLogs() {
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) return;
  
  const files = fs.readdirSync(logsDir);
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  
  files.forEach(file => {
    const filePath = path.join(logsDir, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtime.getTime() > thirtyDays) {
      fs.unlinkSync(filePath);
      console.log(`Silindi: ${file}`);
    }
  });
}

// Eski upload dosyalarını temizle (6 aydan eski)
function cleanOldUploads() {
  const uploadsDir = path.join(__dirname, 'uploads');
  // ... implementasyon
}
```

## Boyut Kontrolü Checklist

Her deployment öncesi kontrol edin:
- [ ] `node_modules/` git'e dahil değil
- [ ] `uploads/` git'e dahil değil
- [ ] `*.db` dosyaları git'e dahil değil
- [ ] Backup dosyaları (*.bak) yok
- [ ] Geçici dosyalar (*.tmp) yok
- [ ] Log dosyaları temizlenmiş
- [ ] Proje boyutu 4 GB'ın altında

## İletişim

Sorularınız için: [Proje sahibi ile iletişime geçin]

