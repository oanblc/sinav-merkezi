const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const csv = require('csv-parser');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// WHATSAPP BİLDİRİM SİSTEMİ
// ============================================

// WhatsApp bildirimi gönder (Whapi.cloud API kullanarak)
async function whatsappBildirimGonder(telefon, mesaj, bildirimTipi = 'genel') {
  console.log('\n📱 ════════════════════════════════════════════════════');
  console.log('📱 WHATSAPP BİLDİRİM - Whapi.cloud');
  console.log('📱 ════════════════════════════════════════════════════');
  console.log(`📞 Alıcı: ${telefon}`);
  console.log(`📝 Mesaj: ${mesaj}`);
  console.log(`🏷️  Tip: ${bildirimTipi}`);
  console.log('📱 ════════════════════════════════════════════════════\n');
  
  try {
    // WhatsApp ayarlarını al
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.api_token) {
      console.log('⚠️  WhatsApp API token bulunamadı, sadece log yazılıyor');
      
      // Bildirim geçmişine kaydet (simülasyon)
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
         VALUES (?, ?, ?, 'simulasyon', datetime('now'))`,
        [bildirimTipi, telefon, mesaj]
      );
      
      return { success: true, message: 'Bildirim gönderildi (simülasyon - API token yok)' };
    }
    
    // Whapi.cloud API'ye istek gönder
    const https = require('https');
    const url = require('url');
    
    // Telefon numarasını formatla (Whapi.cloud formatı: 905551234567@s.whatsapp.net)
    let formattedPhone = telefon.replace(/[^0-9]/g, ''); // Sadece rakamlar
    if (!formattedPhone.startsWith('90')) {
      formattedPhone = '90' + formattedPhone; // Türkiye kodu ekle
    }
    formattedPhone = formattedPhone + '@s.whatsapp.net';
    
    // API URL'ini düzelt
    const baseUrl = (ayarlar.api_url || 'https://gate.whapi.cloud').replace(/\/$/, '');
    const apiUrl = `${baseUrl}/messages/text`;
    
    const postData = JSON.stringify({
      to: formattedPhone,
      body: mesaj
    });
    
    console.log('📡 API URL:', apiUrl);
    console.log('📞 Formatted Phone:', formattedPhone);
    console.log('📦 POST Data:', postData);
    
    const parsedUrl = url.parse(apiUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ayarlar.api_token}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', async () => {
          console.log('✅ Whapi.cloud API Yanıtı:', res.statusCode);
          console.log('📦 Response:', data);
          
          if (res.statusCode === 200 || res.statusCode === 201) {
            // Başarılı - Bildirim geçmişine kaydet
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
               VALUES (?, ?, ?, 'basarili', datetime('now'))`,
              [bildirimTipi, telefon, mesaj]
            );
            
            resolve({ success: true, message: 'WhatsApp bildirimi başarıyla gönderildi!' });
          } else {
            // API hatası
            const errorMsg = `API Error: ${res.statusCode} - ${data}`;
            console.error('❌', errorMsg);
            
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
               VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
              [bildirimTipi, telefon, mesaj, errorMsg]
            );
            
            resolve({ success: false, message: 'WhatsApp bildirimi gönderilemedi', error: errorMsg });
          }
        });
      });
      
      req.on('error', async (error) => {
        console.error('❌ Whapi.cloud bağlantı hatası:', error);
        
        // Hata durumunu kaydet
        try {
          await dbRun(
            `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
             VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
            [bildirimTipi, telefon, mesaj, error.message]
          );
        } catch (logError) {
          console.error('❌ Bildirim geçmişi kayıt hatası:', logError);
        }
        
        resolve({ success: false, message: 'Bağlantı hatası', error: error.message });
      });
      
      req.write(postData);
      req.end();
    });
    
  } catch (error) {
    console.error('❌ WhatsApp bildirim hatası:', error);
    
    // Hata durumunu kaydet
    try {
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
         VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
        [bildirimTipi, telefon, mesaj, error.message]
      );
    } catch (logError) {
      console.error('❌ Bildirim geçmişi kayıt hatası:', logError);
    }
    
    return { success: false, message: 'Bildirim gönderilemedi', error: error.message };
  }
}

// Yeni talep bildirimi oluştur
function talepBildirimMesaji(veli, sinav) {
  return `🔔 YENİ SINAV TALEBİ

👤 Veli: ${veli.ad_soyad}
📞 Telefon: ${veli.telefon}
📧 E-posta: ${veli.email}

📚 Sınav: ${sinav.ad}
💰 Fiyat: ${sinav.fiyat} TL
📅 Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

⏱️  Talep Zamanı: ${new Date().toLocaleString('tr-TR')}

Lütfen bu talebi değerlendirin ve yanıtlayın.`;
}

// ============================================
// GELIŞMIŞ PDF TEXT EXTRACTION
// ============================================

// Bozuk text tespit et
function isGarbledText(text) {
  if (!text || text.length === 0) return true;
  
  // 1. Aynı karakterin 10+ kez tekrarı (DYBNDYBNDYBN...)
  if (text.match(/(.)\1{9,}/)) {
    console.log('   ⚠️ Tespit: Tekrarlayan karakter paterni');
    return true;
  }
  
  // 2. 2-3 karakterlik tekrar (DYBN DYBN DYBN...)
  if (text.match(/(.{2,4})\1{5,}/)) {
    console.log('   ⚠️ Tespit: Tekrarlayan string paterni');
    return true;
  }
  
  // 3. Çok az sesli harf (encoding sorunlarında sesliler kaybolur)
  const vowelCount = (text.match(/[AEIOUÜÖIİaeıouüö]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars > 50 && vowelCount / totalChars < 0.15) {
    console.log(`   ⚠️ Tespit: Çok az sesli harf (${vowelCount}/${totalChars})`);
    return true;
  }
  
  return false;
}

// Alternatif PDF okuma (şimdilik devre dışı - gelecekte OCR eklenebilir)
async function extractTextWithAlternative(pdfPath) {
  console.log('   ⚠️ Alternatif extraction şu anda desteklenmiyor');
  console.log('   💡 PDF\'i farklı formatta export edin veya manuel giriş kullanın');
  return null;
}

// Hibrit extraction: Önce pdf-parse, bozuksa PDF.js
async function extractTextHybrid(pdfPath) {
  // 1. Önce pdf-parse dene
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const text1 = data.text;
  
  // Bozuk mu kontrol et
  if (!isGarbledText(text1)) {
    console.log('   ✅ pdf-parse başarılı');
    return { text: text1, method: 'pdf-parse' };
  }
  
  console.log('   ⚠️ pdf-parse bozuk text üretti');
  
  // 2. Alternatif yöntem dene (şimdilik sadece uyarı)
  await extractTextWithAlternative(pdfPath);
  
  // 3. Bozuk text ile devam et ama işaretle
  console.log('   ⚠️ Bozuk text ile devam ediliyor - Manuel kontrol gerekli');
  return { text: text1, method: 'pdf-parse-garbled', garbled: true };
}

// ============================================
// MULTER CONFIGURATION (PDF & Excel Upload)
// ============================================

// PDF Upload Storage
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const pdfUpload = multer({ 
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Sadece PDF dosyası yükleyebilirsiniz!'), false);
    }
  }
});

// Veritabanı bağlantısı
const db = new sqlite3.Database('sinav_merkezi.db', (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err);
  } else {
    console.log('✅ Veritabanı bağlandı');
  }
});

// Veritabanı tablolarını oluştur
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      user_type TEXT NOT NULL,
      ad_soyad TEXT,
      kurum TEXT,
      telefon TEXT,
      brans TEXT,
      uzmanlik_alani TEXT,
      mezuniyet TEXT,
      profil_foto TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Mevcut veritabanına yeni sütunları ekle (eğer yoksa)
  db.run(`ALTER TABLE users ADD COLUMN ad_soyad TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN kurum TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN brans TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN uzmanlik_alani TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN mezuniyet TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN profil_foto TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS ogrenciler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_soyad TEXT NOT NULL,
      tc_no TEXT,
      telefon TEXT,
      okul TEXT,
      sinif TEXT,
      veli_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (veli_id) REFERENCES users(id)
    )
  `);
  
  // Mevcut veritabanına yeni sütunları ekle
  db.run(`ALTER TABLE ogrenciler ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN okul TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN sinif TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN ogrenci_no TEXT UNIQUE`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  // Sınavlar tablosuna yeni kolonlar ekle
  db.run(`ALTER TABLE sinavlar ADD COLUMN fiyat REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN aciklama TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sinif TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN ders TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  
  // Satınalma tablosuna PayTR kolonları ekle
  db.run(`ALTER TABLE satinalma ADD COLUMN merchant_oid TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  db.run(`ALTER TABLE satinalma ADD COLUMN paytr_token TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {}
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS sinavlar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad TEXT NOT NULL,
      tarih DATE NOT NULL,
      dosya_yolu TEXT,
      fiyat REAL DEFAULT 0,
      aciklama TEXT,
      sinif TEXT,
      ders TEXT,
      durum TEXT DEFAULT 'taslak',
      katilimci_sayisi INTEGER DEFAULT 0,
      sonuc_yuklendi INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Mevcut sinavlar tablosuna yeni kolonları ekle (eğer yoksa)
  db.run(`ALTER TABLE sinavlar ADD COLUMN durum TEXT DEFAULT 'taslak'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ durum kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN katilimci_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ katilimci_sayisi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuc_yuklendi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ sonuc_yuklendi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN cevap_anahtari_pdf TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ cevap_anahtari_pdf kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sinav_durumu TEXT DEFAULT 'Başvuru aşamasında'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ sinav_durumu kolonu zaten var veya hata:', err.message);
  });
  
  // Sınav Katılımcıları Tablosu (Sınav-Öğrenci İlişkisi + PDF Sonuçları)
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_katilimcilari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_id INTEGER NOT NULL,
      ogrenci_id INTEGER NOT NULL,
      ogrenci_kaynak TEXT DEFAULT 'kurum',
      pdf_path TEXT,
      sonuc_durumu TEXT DEFAULT 'beklemede',
      whatsapp_gonderim_tarihi DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sinav_id) REFERENCES sinavlar(id) ON DELETE CASCADE
    )
  `);
  
  // Mevcut sinav_katilimcilari tablosuna ogrenci_kaynak kolonu ekle
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN ogrenci_kaynak TEXT DEFAULT 'kurum'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ ogrenci_kaynak kolonu zaten var veya hata:', err.message);
  });
  
  // PDF görüntülenme takibi için kolonlar ekle
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_goruldu INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ pdf_goruldu kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_gorunme_tarihi DATETIME`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ pdf_gorunme_tarihi kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_indirilme_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ pdf_indirilme_sayisi kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_sonuclari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_id INTEGER NOT NULL,
      ogrenci_id INTEGER NOT NULL,
      sayfa_no INTEGER NOT NULL,
      sonuc_verisi TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sinav_id) REFERENCES sinavlar(id),
      FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler(id)
    )
  `);
  
  // Sınav Talepleri Tablosu (Satın alma sistemi kaldırıldı)
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_talepleri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      veli_id INTEGER NOT NULL,
      sinav_id INTEGER NOT NULL,
      durum TEXT DEFAULT 'beklemede',
      aciklama TEXT,
      yanit TEXT,
      talep_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      yanitlanma_tarihi DATETIME,
      FOREIGN KEY (veli_id) REFERENCES users(id),
      FOREIGN KEY (sinav_id) REFERENCES sinavlar(id)
    )
  `);
  
  // PayTR Ayarları Tablosu - KALDIRILDİ (Talep sistemi kullanılıyor)
  
  // ============ SINAV PAKETLERİ SİSTEMİ ============
  
  // Sınav Paketleri Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_paketleri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad TEXT NOT NULL,
      aciklama TEXT,
      sinif TEXT,
      toplam_sinav_sayisi INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      olusturulma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      kurum_id INTEGER
    )
  `);
  
  // Paket-Sınav İlişkisi (Many-to-Many)
  db.run(`
    CREATE TABLE IF NOT EXISTS paket_sinavlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL,
      sinav_id INTEGER NOT NULL,
      sira INTEGER DEFAULT 0,
      FOREIGN KEY (paket_id) REFERENCES sinav_paketleri(id) ON DELETE CASCADE,
      FOREIGN KEY (sinav_id) REFERENCES sinavlar(id) ON DELETE CASCADE
    )
  `);
  
  // Paket-Öğrenci Atamaları
  db.run(`
    CREATE TABLE IF NOT EXISTS paket_atamalari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL,
      ogrenci_id INTEGER NOT NULL,
      ogrenci_kaynak TEXT DEFAULT 'kurum',
      atama_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      durum TEXT DEFAULT 'aktif',
      FOREIGN KEY (paket_id) REFERENCES sinav_paketleri(id) ON DELETE CASCADE
    )
  `);
  
  console.log('✅ Sınav Paketleri tabloları oluşturuldu');
  
  // Öğrenci Kayıtları Tablosu (Kurum için)
  db.run(`
    CREATE TABLE IF NOT EXISTS ogrenci_kayitlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinif TEXT NOT NULL,
      ogrenci_adi_soyadi TEXT NOT NULL,
      telefon TEXT,
      tc_kimlik_no TEXT,
      veli_adi TEXT,
      veli_telefon TEXT,
      tutar TEXT,
      odeme_durumu TEXT DEFAULT 'BEKLİYOR',
      odeme_turu TEXT,
      edessis_kaydi TEXT,
      taksit TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // WhatsApp API Ayarları Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_ayarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_url TEXT,
      api_token TEXT,
      phone_number TEXT,
      aktif INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Bildirim Geçmişi Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS bildirim_gecmisi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bildirim_tipi TEXT,
      alici_telefon TEXT,
      mesaj TEXT,
      durum TEXT DEFAULT 'gonderildi',
      hata_mesaji TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Slider tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS slider (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baslik TEXT,
      aciklama TEXT,
      resim_yolu TEXT,
      link TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Duyurular tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS duyurular (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baslik TEXT NOT NULL,
      icerik TEXT,
      resim_yolu TEXT,
      tarih DATE,
      aktif INTEGER DEFAULT 1,
      sira INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Satın alınabilir sınavlar tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS satin_alinabilir_sinavlar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baslik TEXT NOT NULL,
      aciklama TEXT,
      kategori TEXT NOT NULL,
      sinav_sayisi INTEGER,
      tyt_sayisi INTEGER,
      ayt_sayisi INTEGER,
      fiyat REAL NOT NULL,
      resim_yolu TEXT,
      ozellikler TEXT,
      aktif INTEGER DEFAULT 1,
      sira INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Hakkımızda ve site ayarları
  db.run(`
    CREATE TABLE IF NOT EXISTS site_ayarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anahtar TEXT UNIQUE NOT NULL,
      deger TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Kurumsal Sayfalar Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS kurumsal_sayfalar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sayfa_slug TEXT UNIQUE NOT NULL,
      sayfa_adi TEXT NOT NULL,
      baslik TEXT NOT NULL,
      icerik TEXT,
      seo_baslik TEXT,
      seo_aciklama TEXT,
      aktif INTEGER DEFAULT 1,
      sira INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Varsayılan kurumsal sayfaları ekle (eğer yoksa)
  db.run(`
    INSERT OR IGNORE INTO kurumsal_sayfalar (sayfa_slug, sayfa_adi, baslik, icerik, sira)
    VALUES 
    ('hakkimizda', 'Hakkımızda', 'Hakkımızda', '<p>Sınav Merkezi olarak 30 yıllık eğitim tecrübesiyle öğrencilerimizi geleceğe hazırlıyoruz.</p>', 1),
    ('iletisim', 'İletişim', 'İletişim', '<p><strong>Adres:</strong> İstanbul, Türkiye</p><p><strong>Email:</strong> info@sinavmerkezi.com</p><p><strong>Telefon:</strong> 0 (505) 354 12 30</p>', 2),
    ('sinav-merkezleri', 'Sınav Merkezleri', 'Sınav Merkezlerimiz', '<p>Tüm Türkiye genelinde sınav merkezlerimiz bulunmaktadır.</p>', 3)
  `);
  
  // Eski sınav_takvimi tablosu kaldırıldı - yeni yapı aşağıda
  
  db.run(`
    CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT NOT NULL,
      sinif TEXT NOT NULL,
      sinav_tarihi DATETIME NOT NULL,
      durum TEXT DEFAULT 'Sonuç açıklandı',
      cevap_anahtari_url TEXT,
      sonuc_url TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Sınav sonuçları tablosu (PDF'ler)
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_sonuclari_pdf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ogrenci_id INTEGER NOT NULL,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT,
      sinav_tarihi DATE NOT NULL,
      pdf_path TEXT NOT NULL,
      ogrenci_adi TEXT NOT NULL,
      numara TEXT,
      sinif TEXT,
      puan TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler(id)
    )
  `);
  
  // Öğrenci ekleme talepleri tablosu (Rehber -> Veli talep sistemi)
  db.run(`
    CREATE TABLE IF NOT EXISTS ogrenci_talepleri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ogrenci_no TEXT,
      ad_soyad TEXT,
      sinif TEXT,
      okul TEXT,
      veli_id INTEGER NOT NULL,
      rehber_id INTEGER,
      rehber_ogretmen_id INTEGER,
      ogrenci_id INTEGER,
      durum TEXT DEFAULT 'beklemede',
      mesaj TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (veli_id) REFERENCES users (id),
      FOREIGN KEY (rehber_id) REFERENCES users (id),
      FOREIGN KEY (rehber_ogretmen_id) REFERENCES users (id),
      FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler (id)
    )
  `);
  
  // Sınav takvimi tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_takvimi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinif TEXT,
      tarih DATE NOT NULL,
      saat TEXT,
      sure TEXT,
      ders TEXT,
      konu TEXT,
      aciklama TEXT,
      durum TEXT DEFAULT 'yaklasan',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Cevap anahtarları tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinif TEXT,
      dosya_yolu TEXT NOT NULL,
      dosya_adi TEXT,
      aciklama TEXT,
      tarih DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Eksik kolonları ekle (ALTER TABLE)
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN rehber_ogretmen_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log('⚠️ rehber_ogretmen_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('✅ ogrenci_talepleri.rehber_ogretmen_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN ogrenci_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log('⚠️ ogrenci_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('✅ ogrenci_talepleri.ogrenci_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN pdf_isim TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN sayfa_no INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sütun zaten var, sorun yok
    }
  });
  
  // Sınav paketlerine fiyat kolonu ekle
  db.run(`ALTER TABLE sinav_paketleri ADD COLUMN fiyat REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('⚠️ sinav_paketleri.fiyat kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('✅ sinav_paketleri.fiyat kolonu eklendi');
    }
  });
});

// Veritabanı yardımcı fonksiyonları (Promise wrapper)
// Öğrenci Numarası Oluşturma Fonksiyonu
async function generateOgrenciNo() {
  const yil = new Date().getFullYear();
  
  // Bu yıl eklenen son öğrenci numarasını bul
  const sonOgrenci = await dbGet(
    `SELECT ogrenci_no FROM ogrenciler 
     WHERE ogrenci_no LIKE ? 
     ORDER BY ogrenci_no DESC LIMIT 1`,
    [`${yil}%`]
  );
  
  let sira = 1;
  if (sonOgrenci && sonOgrenci.ogrenci_no) {
    // Son 4 haneyi al ve 1 artır
    const sonSira = parseInt(sonOgrenci.ogrenci_no.substring(4));
    sira = sonSira + 1;
  }
  
  // Yıl + 4 haneli sıra numarası
  const ogrenciNo = `${yil}${sira.toString().padStart(4, '0')}`;
  return ogrenciNo;
}

function dbGet(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads')); // PDF dosyalarına erişim için
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// EJS cache'i devre dışı bırak (development için)
app.set('view cache', false);

app.use(session({
  secret: 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 saat
}));

// Upload klasörü
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer yapılandırması
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `${timestamp}_${file.originalname}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Sadece Excel ve CSV dosyaları yüklenebilir!'));
    }
  }
});

// Yardımcı fonksiyonlar
function requireAuth(req, res, next) {
  console.log('🔒 requireAuth middleware:');
  console.log('   Session ID:', req.session.userId);
  console.log('   User Type:', req.session.userType);
  
  if (req.session.userId) {
    console.log('   ✅ Kimlik doğrulandı\n');
    next();
  } else {
    console.log('   ❌ Kimlik doğrulanamadı, login\'e yönlendiriliyor\n');
    res.redirect('/login');
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.userType === role) {
      next();
    } else {
      req.session.error = 'Bu sayfaya erişim yetkiniz yok!';
      res.redirect('/');
    }
  };
}

function normalizeIsim(isim) {
  if (!isim) return "";
  let normalized = String(isim).trim();
  while (normalized.includes('  ')) {
    normalized = normalized.replace('  ', ' ');
  }
  return normalized;
}

function dataframeSayfalaraAyir(data, sayfaBoyutu = 50) {
  const sayfalar = [];
  const toplamSatir = data.length;
  const sayfaSayisi = Math.ceil(toplamSatir / sayfaBoyutu);
  
  for (let i = 0; i < sayfaSayisi; i++) {
    const baslangic = i * sayfaBoyutu;
    const bitis = Math.min((i + 1) * sayfaBoyutu, toplamSatir);
    const sayfaVerisi = data.slice(baslangic, bitis);
    
    sayfalar.push({
      sayfa_no: i + 1,
      veri: sayfaVerisi
    });
  }
  
  return sayfalar;
}

async function ogrenciEslestir(data, ogrenciAdiKolonu = null) {
  if (!data || data.length === 0) return [];
  
  // Öğrenci adı kolonunu bul
  if (!ogrenciAdiKolonu) {
    const keys = Object.keys(data[0]);
    ogrenciAdiKolonu = keys.find(key => {
      const keyLower = String(key).toLowerCase();
      return ['ad', 'isim', 'name', 'öğrenci', 'student', 'ad soyad', 'ad_soyad'].some(kelime => 
        keyLower.includes(kelime)
      );
    });
  }
  
  if (!ogrenciAdiKolonu) return [];
  
  // Tüm öğrencileri çek
  const tumOgrenciler = await dbAll('SELECT * FROM ogrenciler');
  const ogrenciMap = {};
  tumOgrenciler.forEach(ogr => {
    const normalized = normalizeIsim(ogr.ad_soyad).toLowerCase();
    ogrenciMap[normalized] = ogr;
  });
  
  // Eşleştirme yap
  const eslesmeler = [];
  data.forEach((row, idx) => {
    const ogrenciAdi = normalizeIsim(row[ogrenciAdiKolonu]);
    const ogrenciAdiLower = ogrenciAdi.toLowerCase();
    const ogrenci = ogrenciMap[ogrenciAdiLower];
    
    eslesmeler.push({
      satir_no: idx + 1,
      ogrenci_id: ogrenci ? ogrenci.id : null,
      ogrenci_adi: ogrenciAdi,
      eslesme: !!ogrenci
    });
  });
  
  return eslesmeler;
}

async function readExcelFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  
  const data = [];
  const headers = [];
  
  // İlk satırı başlık olarak al
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = cell.value;
  });
  
  // Diğer satırları oku
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Başlık satırını atla
    
    const rowData = {};
    row.eachCell((cell, colNumber) => {
      rowData[headers[colNumber]] = cell.value;
    });
    data.push(rowData);
  });
  
  return data;
}

function readCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Routes
app.get('/', async (req, res) => {
  // Eğer giriş yapmışsa ve force parametresi yoksa dashboard'a yönlendir
  if (req.session.userId && !req.query.force) {
    if (req.session.userType === 'veli') {
      return res.redirect('/veli/dashboard');
    } else if (req.session.userType === 'rehber_ogretmen') {
      return res.redirect('/rehber/dashboard');
    } else if (req.session.userType === 'admin') {
      return res.redirect('/admin/dashboard');
    }
  }
  
  // Anasayfa verilerini çek
  try {
    let slider = [];
    let duyurular = [];
    let satinAlinabilirSinavlar = [];
    let toplamOgrenci = { sayi: 0 };
    let toplamSinav = { sayi: 0 };
    
    try {
      slider = await dbAll('SELECT * FROM slider WHERE aktif = 1 ORDER BY sira ASC');
    } catch (e) {
      console.log('Slider hatası:', e.message);
    }
    
    try {
      duyurular = await dbAll('SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC LIMIT 6');
    } catch (e) {
      console.log('Duyurular hatası:', e.message);
    }
    
    try {
      // Yeni sınavlar tablosundan çek (fiyat > 0 olanlar satılık)
      const sinavlarRaw = await dbAll('SELECT * FROM sinavlar WHERE fiyat > 0 ORDER BY tarih ASC LIMIT 6');
      // ozellikler JSON string ise parse et
      satinAlinabilirSinavlar = sinavlarRaw.map(sinav => {
        let ozellikler_parsed = [];
        if (sinav.ozellikler) {
          if (Array.isArray(sinav.ozellikler)) {
            ozellikler_parsed = sinav.ozellikler;
          } else if (typeof sinav.ozellikler === 'string') {
            try {
              const parsed = JSON.parse(sinav.ozellikler);
              if (Array.isArray(parsed)) {
                ozellikler_parsed = parsed;
              }
            } catch(e) {
              ozellikler_parsed = [];
            }
          }
        }
        return { ...sinav, ozellikler_parsed };
      });
    } catch (e) {
      console.log('Sınavlar hatası:', e.message);
      satinAlinabilirSinavlar = [];
    }
    
    let sinavPaketleri = [];
    try {
      // Aktif sınav paketlerini çek
      sinavPaketleri = await dbAll(`
        SELECT 
          sp.*,
          COUNT(DISTINCT ps.sinav_id) as sinav_sayisi
        FROM sinav_paketleri sp
        LEFT JOIN paket_sinavlari ps ON sp.id = ps.paket_id
        WHERE sp.aktif = 1
        GROUP BY sp.id
        ORDER BY sp.olusturulma_tarihi DESC
        LIMIT 6
      `);
    } catch (e) {
      console.log('Sınav paketleri hatası:', e.message);
    }
    
    // İstatistikler
    try {
      toplamOgrenci = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler') || { sayi: 0 };
    } catch (e) {
      console.log('Öğrenci sayısı hatası:', e.message);
    }
    
    try {
      toplamSinav = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar') || { sayi: 0 };
    } catch (e) {
      console.log('Sınav sayısı hatası:', e.message);
    }
    
    res.render('index', {
      slider: slider || [],
      duyurular: duyurular || [],
      satinAlinabilirSinavlar: satinAlinabilirSinavlar || [],
      sinavPaketleri: sinavPaketleri || [],
      istatistikler: {
        ogrenci: toplamOgrenci.sayi || 0,
        sinav: toplamSinav.sayi || 0
      },
      user: req.session.userId ? { username: req.session.username, type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Anasayfa hatası:', error);
    // Hata olsa bile anasayfayı göster
    try {
      res.render('index', {
        slider: [],
        duyurular: [],
        satinAlinabilirSinavlar: [],
        sinavPaketleri: [],
        istatistikler: { ogrenci: 0, sinav: 0 },
        user: null
      });
    } catch (renderError) {
      console.error('Template render hatası:', renderError);
      res.send('Anasayfa yüklenirken bir hata oluştu: ' + renderError.message);
    }
  }
});

// Panel Redirect Routes
app.get('/veli', requireAuth, (req, res) => {
  res.redirect('/veli/dashboard');
});

app.get('/rehber', requireAuth, (req, res) => {
  res.redirect('/rehber/dashboard');
});

app.get('/kurum', requireAuth, (req, res) => {
  res.redirect('/kurum/dashboard');
});

// Sınav Paketleri Sayfası
app.get('/sinav-paketleri', async (req, res) => {
  try {
    // Tekil sınavlar (fiyat > 0 olanlar)
    const sinavlar = await dbAll('SELECT * FROM sinavlar WHERE fiyat > 0 ORDER BY tarih ASC');
    
    // Sınav paketleri (aktif olanlar)
    const paketler = await dbAll(`
      SELECT 
        sp.*,
        COUNT(DISTINCT ps.sinav_id) as sinav_sayisi
      FROM sinav_paketleri sp
      LEFT JOIN paket_sinavlari ps ON sp.id = ps.paket_id
      WHERE sp.aktif = 1
      GROUP BY sp.id
      ORDER BY sp.olusturulma_tarihi DESC
    `);
    
    res.render('sinav-paketleri', {
      sinavlar: sinavlar || [],
      paketler: paketler || [],
      user: req.session.userId ? { 
        username: req.session.username, 
        type: req.session.userType,
        id: req.session.userId
      } : null
    });
  } catch (error) {
    console.error('Sınav paketleri hatası:', error);
    res.render('sinav-paketleri', {
      sinavlar: [],
      paketler: [],
      user: req.session.userId ? { 
        username: req.session.username, 
        type: req.session.userType,
        id: req.session.userId
      } : null
    });
  }
});

// Sınav Talep Gönderme - Giriş Zorunlu Değil
app.post('/sinav-talep-gonder', async (req, res) => {
  try {
    const { sinav_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // Eğer giriş yapılmışsa
    
    // Sınavı kontrol et
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.json({ success: false, message: 'Sınav bulunamadı!' });
    }
    
    // DURUM 1: Giriş yapılmamış - Yeni hesap oluştur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolü (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'Lütfen tüm bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik oluştur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha önce kullanılmış mı?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // Şifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username oluştur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabı oluştur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(`✅ Yeni veli hesabı oluşturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
      
      // Otomatik giriş yapma (session oluşturma)
      // req.session.userId = veli_id;
      // req.session.username = username;
      // req.session.userType = 'veli';
    }
    
    // DURUM 2: Daha önce talep gönderilmiş mi kontrol et
    const mevcutTalep = await dbGet(
      'SELECT * FROM sinav_talepleri WHERE veli_id = ? AND sinav_id = ? AND durum != "reddedildi"',
      [veli_id, sinav_id]
    );
    
    if (mevcutTalep) {
      return res.json({ success: false, message: 'Bu sınav için zaten bir talebiniz bulunmaktadır!' });
    }
    
    // Talep kaydet
    await dbRun(
      `INSERT INTO sinav_talepleri (veli_id, sinav_id, durum, aciklama, talep_tarihi) 
       VALUES (?, ?, 'beklemede', ?, datetime('now'))`,
      [veli_id, sinav_id, aciklama || '']
    );
    
    // Veli bilgilerini al (WhatsApp bildirimi için)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarını kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesajı oluştur
      const mesaj = talepBildirimMesaji(veliDetay, sinav);
      
      // WhatsApp bildirimi gönder (arka planda, hata olsa bile kullanıcıya başarılı dön)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'yeni_talep')
        .then(result => {
          console.log('✅ WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error('❌ WhatsApp bildirimi hatası (arka plan):', error);
        });
    } else {
      console.log('⚠️  WhatsApp ayarları yapılmamış, bildirim gönderilmedi');
    }
    
    res.json({ 
      success: true, 
      message: `${sinav.ad} için talebiniz başarıyla gönderildi! En kısa sürede değerlendirilecektir.`,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Talep gönderme hatası:', error);
    res.json({ success: false, message: 'Talep gönderilirken bir hata oluştu: ' + error.message });
  }
});

// Paket Talebi Gönder
app.post('/paket-talep-gonder', async (req, res) => {
  try {
    const { paket_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // Eğer giriş yapılmışsa
    
    // Paketi kontrol et
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ? AND aktif = 1', [paket_id]);
    if (!paket) {
      return res.json({ success: false, message: 'Paket bulunamadı!' });
    }
    
    // DURUM 1: Giriş yapılmamış - Yeni hesap oluştur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolü (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'Lütfen tüm bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik oluştur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha önce kullanılmış mı?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // Şifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username oluştur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabı oluştur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(`✅ Yeni veli hesabı oluşturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
    }
    
    // Paket içindeki sınavları al
    const paketSinavlari = await dbAll(
      'SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?',
      [paket_id]
    );
    
    if (paketSinavlari.length === 0) {
      return res.json({ success: false, message: 'Paket içinde sınav bulunamadı!' });
    }
    
    // Her sınav için talep oluştur
    let olusturulanTalep = 0;
    for (const ps of paketSinavlari) {
      // Daha önce talep gönderilmiş mi kontrol et
      const mevcutTalep = await dbGet(
        'SELECT * FROM sinav_talepleri WHERE veli_id = ? AND sinav_id = ? AND durum != "reddedildi"',
        [veli_id, ps.sinav_id]
      );
      
      if (!mevcutTalep) {
        // Talep kaydet (paket bilgisini aciklama'ya ekle)
        const paketAciklama = `[PAKET: ${paket.ad}] ${aciklama || ''}`;
        await dbRun(
          `INSERT INTO sinav_talepleri (veli_id, sinav_id, durum, aciklama, talep_tarihi) 
           VALUES (?, ?, 'beklemede', ?, datetime('now'))`,
          [veli_id, ps.sinav_id, paketAciklama]
        );
        olusturulanTalep++;
      }
    }
    
    if (olusturulanTalep === 0) {
      return res.json({ success: false, message: 'Bu paket için zaten tüm sınavlara talebiniz bulunmaktadır!' });
    }
    
    // Veli bilgilerini al (WhatsApp bildirimi için)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarını kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesajı oluştur
      const mesaj = `📦 YENİ PAKET TALEBİ\n\n` +
        `Merhaba,\n\n` +
        `${veliDetay.ad_soyad || veliDetay.username} adlı veli "${paket.ad}" paketi için talep gönderdi.\n\n` +
        `📦 Paket: ${paket.ad}\n` +
        `📚 Sınıf: ${paket.sinif || 'Belirtilmemiş'}\n` +
        `📝 Sınav Sayısı: ${paketSinavlari.length}\n` +
        `${aciklama ? `💬 Açıklama: ${aciklama}\n` : ''}\n` +
        `📞 Telefon: ${veliDetay.telefon || 'Belirtilmemiş'}\n` +
        `📧 Email: ${veliDetay.email || 'Belirtilmemiş'}\n\n` +
        `Lütfen kurum panelinden talebi değerlendirin.`;
      
      // WhatsApp bildirimi gönder (arka planda, hata olsa bile kullanıcıya başarılı dön)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'paket_talebi')
        .then(result => {
          console.log('✅ WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error('❌ WhatsApp bildirimi hatası (arka plan):', error);
        });
    } else {
      console.log('⚠️  WhatsApp ayarları yapılmamış, bildirim gönderilmedi');
    }
    
    res.json({ 
      success: true, 
      message: `${paket.ad} paketi için ${olusturulanTalep} sınav talebi başarıyla gönderildi! En kısa sürede değerlendirilecektir.`,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Paket talep gönderme hatası:', error);
    res.json({ success: false, message: 'Talep gönderilirken bir hata oluştu: ' + error.message });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: req.session.error, success: req.session.success });
  req.session.error = null;
  req.session.success = null;
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    
    console.log('\n🔐 GİRİŞ DENEMESİ:');
    console.log('   Kullanıcı Adı:', username);
    console.log('   Veritabanında Bulundu:', user ? 'Evet' : 'Hayır');
    if (user) {
      console.log('   Kullanıcı Tipi:', user.user_type);
      console.log('   Hash Karşılaştırma:', await bcrypt.compare(password, user.password_hash) ? 'Başarılı' : 'Başarısız');
    }
    
    if (user && await bcrypt.compare(password, user.password_hash)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.userType = user.user_type;
      
      console.log('   ✅ GİRİŞ BAŞARILI!');
      console.log('   Session ID:', req.session.userId);
      console.log('   Yönlendirme:', user.user_type + ' dashboard\n');
      
      if (user.user_type === 'veli') {
        return res.redirect('/veli/dashboard');
      } else if (user.user_type === 'rehber_ogretmen') {
        return res.redirect('/rehber/dashboard');
      } else if (user.user_type === 'kurum_yonetici') {
        return res.redirect('/kurum/dashboard');
      }
    }
    
    console.log('   ❌ GİRİŞ BAŞARISIZ!\n');
    req.session.error = 'Kullanıcı adı veya şifre hatalı!';
    res.redirect('/login');
  } catch (error) {
    console.error('Login hatası:', error);
    req.session.error = 'Giriş sırasında bir hata oluştu!';
    res.redirect('/login');
  }
});

app.get('/register', (req, res) => {
  res.render('register', { error: req.session.error, success: req.session.success });
  req.session.error = null;
  req.session.success = null;
});

app.post('/register', async (req, res) => {
  const { username, email, password, user_type } = req.body;
  
  try {
    // Kullanıcı adı kontrolü
    const existingUser = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existingUser) {
      req.session.error = existingUser.username === username 
        ? 'Bu kullanıcı adı zaten kullanılıyor!'
        : 'Bu e-posta adresi zaten kullanılıyor!';
      return res.redirect('/register');
    }
    
    // Şifreyi hashle
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Kullanıcıyı kaydet
    await dbRun('INSERT INTO users (username, email, password_hash, user_type) VALUES (?, ?, ?, ?)', 
      [username, email, passwordHash, user_type]);
    
    req.session.success = 'Kayıt başarılı! Giriş yapabilirsiniz.';
    res.redirect('/login');
  } catch (error) {
    console.error('Register hatası:', error);
    req.session.error = 'Kayıt sırasında bir hata oluştu!';
    res.redirect('/register');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ÖNEMLİ: Bu endpoint'i production'da kaldırın veya şifreleyin!
app.get('/reset-admin-password-secret-endpoint-12345', async (req, res) => {
  try {
    const password_hash = await bcrypt.hash('Admin2024!', 10);
    await dbRun(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [password_hash, 'kurum_admin']
    );
    res.send('✅ Admin şifresi sıfırlandı! Username: kurum_admin, Password: Admin2024!');
  } catch (error) {
    res.status(500).send('❌ Hata: ' + error.message);
  }
});

// Kurum Dashboard
app.get('/kurum/dashboard', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // İstatistikler
    const sinavSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar');
    const sinavAktif = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 0 AND katilimci_sayisi > 0');
    const sinavTamamlandi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 1');
    const sinavTaslak = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE katilimci_sayisi = 0');
    const toplamKatilimci = await dbGet('SELECT SUM(katilimci_sayisi) as toplam FROM sinavlar');
    const takvimSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar'); // Düzeltildi: sinav_takvimi → sinavlar
    const veliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM users WHERE user_type = "veli"');
    
    // Tüm öğrenci sayısı (kurum + veli kayıtları)
    const ogrenciKurumSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    const ogrenciVeliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler');
    const ogrenciSayisi = { sayi: (ogrenciKurumSayisi.sayi || 0) + (ogrenciVeliSayisi.sayi || 0) };
    const ogrenciKayitSayisi = ogrenciKurumSayisi; // Kurum kayıtları için ayrı
    
    const talepBeklemede = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "beklemede"');
    const talepOnaylandi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "onaylandi"');
    const talepReddedildi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "reddedildi"');
    const talepToplam = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri');
    
    // Paket İstatistikleri
    const paketSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_paketleri WHERE aktif = 1');
    const paketToplamOgrenci = await dbGet('SELECT COUNT(DISTINCT ogrenci_id) as sayi FROM paket_atamalari WHERE durum = "aktif"');
    
    res.render('kurum_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
      istatistikler: {
        sinav: sinavSayisi.sayi,
        sinavAktif: sinavAktif.sayi,
        sinavTamamlandi: sinavTamamlandi.sayi,
        sinavTaslak: sinavTaslak.sayi,
        toplamKatilimci: toplamKatilimci.toplam || 0,
        takvim: takvimSayisi.sayi,
        veli: veliSayisi.sayi,
        ogrenci: ogrenciSayisi.sayi,
        ogrenciKayit: ogrenciKayitSayisi.sayi,
        talepBeklemede: talepBeklemede.sayi,
        talepOnaylandi: talepOnaylandi.sayi,
        talepReddedildi: talepReddedildi.sayi,
        talepToplam: talepToplam.sayi,
        paket: paketSayisi.sayi,
        paketOgrenci: paketToplamOgrenci.sayi
      }
    });
  } catch (error) {
    console.error('Kurum dashboard hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// PayTR Entegrasyon Sayfası - KALDIRILDI (Gerek yok)

// Kurum - WhatsApp Ayarları (GET)
app.get('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    let ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE id = 1');
    
    if (!ayarlar) {
      ayarlar = {
        api_url: '',
        api_token: '',
        phone_number: '',
        aktif: 0
      };
    }
    
    res.render('kurum/whatsapp-ayarlari', {
      user: { username: req.session.username, type: req.session.userType },
      ayarlar: ayarlar,
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('WhatsApp ayarları hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - WhatsApp Ayarları (POST)
app.post('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const { api_url, api_token, phone_number, aktif } = req.body;
    
    const mevcutAyar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE id = 1');
    
    if (mevcutAyar) {
      await dbRun(
        `UPDATE whatsapp_ayarlari 
         SET api_url = ?, api_token = ?, phone_number = ?, aktif = ?, updated_at = datetime('now')
         WHERE id = 1`,
        [api_url || '', api_token || '', phone_number || '', aktif ? 1 : 0]
      );
    } else {
      await dbRun(
        `INSERT INTO whatsapp_ayarlari (api_url, api_token, phone_number, aktif) 
         VALUES (?, ?, ?, ?)`,
        [api_url || '', api_token || '', phone_number || '', aktif ? 1 : 0]
      );
    }
    
    req.session.success = 'WhatsApp ayarları başarıyla kaydedildi!';
    res.redirect('/kurum/whatsapp-ayarlari');
  } catch (error) {
    console.error('WhatsApp ayarları kaydetme hatası:', error);
    req.session.error = 'Ayarlar kaydedilirken bir hata oluştu!';
    res.redirect('/kurum/whatsapp-ayarlari');
  }
});

// Kurum - WhatsApp Test Bildirimi
// Test için manuel endpoint (GEÇİCİ - üretimde kaldırılmalı)
app.post('/test-whatsapp-mesaj', async (req, res) => {
  try {
    const { telefon, mesaj } = req.body;
    
    if (!telefon || !mesaj) {
      return res.json({ success: false, message: 'Telefon ve mesaj gerekli!' });
    }
    
    console.log('\n🧪 ═══════════════════════════════════');
    console.log('🧪 MANUEL TEST MESAJI GÖNDERİLİYOR');
    console.log('🧪 ═══════════════════════════════════');
    console.log(`📞 Telefon: ${telefon}`);
    console.log(`📝 Mesaj: ${mesaj}`);
    console.log('🧪 ═══════════════════════════════════\n');
    
    const result = await whatsappBildirimGonder(telefon, mesaj, 'test_manuel');
    
    res.json(result);
  } catch (error) {
    console.error('❌ Test mesajı hatası:', error);
    res.json({ success: false, message: error.message });
  }
});

app.post('/kurum/whatsapp-test', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.phone_number) {
      return res.json({ 
        success: false, 
        message: 'WhatsApp ayarları yapılmamış veya telefon numarası eksik!' 
      });
    }
    
    const testMesaj = `🧪 TEST BİLDİRİMİ

Bu bir test mesajıdır.

✅ WhatsApp API entegrasyonunuz başarıyla çalışıyor!

📅 Test Zamanı: ${new Date().toLocaleString('tr-TR')}`;
    
    const result = await whatsappBildirimGonder(ayarlar.phone_number, testMesaj, 'test');
    
    if (result.success) {
      return res.json({ 
        success: true, 
        message: 'Test mesajı başarıyla gönderildi! Console logları kontrol edin.' 
      });
    } else {
      return res.json({ 
        success: false, 
        message: 'Test mesajı gönderilemedi: ' + result.message 
      });
    }
  } catch (error) {
    console.error('Test bildirimi hatası:', error);
    res.json({ success: false, message: 'Test sırasında bir hata oluştu: ' + error.message });
  }
});

// Kurum - Talep Yönetimi
app.get('/kurum/talepler', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // Sınav Talepleri (Veli -> Kurum)
    const sinavTalepleri = await dbAll(`
      SELECT 
        st.*,
        s.ad as sinav_adi,
        s.fiyat,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        u.username as veli_username,
        u.email as veli_email,
        u.telefon as veli_telefon,
        u.ad_soyad as veli_ad_soyad,
        'sinav' as talep_tipi
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      INNER JOIN users u ON st.veli_id = u.id
    `);
    
    // Rehber Öğretmen Talepleri (Hem kurum hem veli öğrencileri)
    const rehberTalepleri = await dbAll(`
      SELECT 
        ot.*,
        ot.ad_soyad as sinav_adi,
        0 as fiyat,
        NULL as sinav_tarihi,
        ot.sinif,
        NULL as ders,
        v.username as veli_username,
        v.email as veli_email,
        v.telefon as veli_telefon,
        v.ad_soyad as veli_ad_soyad,
        r.ad_soyad as rehber_ad_soyad,
        r.brans as rehber_brans,
        'rehber' as talep_tipi
      FROM ogrenci_talepleri ot
      INNER JOIN users v ON ot.veli_id = v.id
      LEFT JOIN users r ON ot.rehber_ogretmen_id = r.id
      WHERE ot.durum IN ('beklemede', 'onaylandi', 'reddedildi')
    `);
    
    // İki listeyi birleştir
    const talepler = [...sinavTalepleri, ...rehberTalepleri].sort((a, b) => {
      // Önce duruma göre sırala
      const durumOrder = { 'beklemede': 1, 'onaylandi': 2, 'reddedildi': 3 };
      const durumDiff = durumOrder[a.durum] - durumOrder[b.durum];
      if (durumDiff !== 0) return durumDiff;
      
      // Sonra tarihe göre sırala (en yeni en üstte)
      return new Date(b.talep_tarihi || b.created_at) - new Date(a.talep_tarihi || a.created_at);
    });
    
    res.render('kurum/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talep listesi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Talep Yönetimi (Alias - /kurum/talepler ile aynı)
app.get('/kurum/talep-yonetimi', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const talepler = await dbAll(`
      SELECT 
        st.*,
        s.ad as sinav_adi,
        s.fiyat,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        u.username as veli_username,
        u.email as veli_email,
        u.telefon as veli_telefon,
        u.ad_soyad as veli_ad_soyad
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      INNER JOIN users u ON st.veli_id = u.id
      ORDER BY 
        CASE st.durum
          WHEN 'beklemede' THEN 1
          WHEN 'onaylandi' THEN 2
          WHEN 'reddedildi' THEN 3
        END,
        st.talep_tarihi DESC
    `);
    
    res.render('kurum/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talep listesi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Talep Yanıtla (Onayla/Reddet)
app.post('/kurum/talep-yanitla', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { talep_id, durum, yanit, talep_tipi } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'Geçersiz parametreler!' });
    }
    
    // Talep tipine göre farklı tablolardan güncelle
    if (talep_tipi === 'rehber') {
      // Rehber öğretmen talebi
      await dbRun(
        `UPDATE ogrenci_talepleri 
         SET durum = ?, mesaj = ?
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al
      const talep = await dbGet(`
        SELECT 
          ot.*,
          ot.ad_soyad as ogrenci_adi,
          v.ad_soyad as veli_ad_soyad,
          v.telefon as veli_telefon,
          r.ad_soyad as rehber_ad_soyad
        FROM ogrenci_talepleri ot
        INNER JOIN users v ON ot.veli_id = v.id
        LEFT JOIN users r ON ot.rehber_ogretmen_id = r.id
        WHERE ot.id = ?
      `, [talep_id]);
      
      // WhatsApp bildirimi gönder
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `✅ REHBER ÖĞRETMEN TALEBİNİZ ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
            `👨‍🏫 Öğrenci: ${talep.ogrenci_adi}\n` +
            `📚 Rehber: ${talep.rehber_ad_soyad || 'Rehber Öğretmen'}\n` +
            `✅ Durum: Onaylandı\n\n` +
            (yanit ? `💬 Kurum Yanıtı: ${yanit}\n\n` : '') +
            `Rehber öğretmen yetkisi aktif hale getirilmiştir.`
          : `❌ REHBER ÖĞRETMEN TALEBİNİZ REDDEDİLDİ\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
            `👨‍🏫 Öğrenci: ${talep.ogrenci_adi}\n` +
            `❌ Durum: Reddedildi\n\n` +
            (yanit ? `💬 Kurum Yanıtı: ${yanit}\n\n` : '') +
            `Daha fazla bilgi için lütfen bizimle iletişime geçiniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
          .then(result => console.log('✅ WhatsApp bildirimi gönderildi:', result))
          .catch(error => console.error('❌ WhatsApp bildirimi hatası:', error));
      }
      
    } else {
      // Sınav talebi (eski kod)
      await dbRun(
        `UPDATE sinav_talepleri 
         SET durum = ?, yanit = ?, yanitlanma_tarihi = datetime('now')
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al (WhatsApp bildirimi için)
      const talep = await dbGet(`
        SELECT 
          st.*,
          s.ad as sinav_adi,
          u.ad_soyad as veli_ad_soyad,
          u.telefon as veli_telefon
        FROM sinav_talepleri st
        INNER JOIN sinavlar s ON st.sinav_id = s.id
        INNER JOIN users u ON st.veli_id = u.id
        WHERE st.id = ?
      `, [talep_id]);
      
      // WhatsApp bildirimi gönder (arka planda)
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `✅ TALEBİNİZ ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
            `📚 Sınav: ${talep.sinav_adi}\n` +
            `✅ Durum: Onaylandı\n\n` +
            (yanit ? `💬 Kurum Yanıtı: ${yanit}\n\n` : '') +
            `Sınav erişiminiz aktif hale getirilmiştir. İyi sınavlar dileriz! 🎓`
          : `❌ TALEBİNİZ REDDEDİLDİ\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
            `📚 Sınav: ${talep.sinav_adi}\n` +
            `❌ Durum: Reddedildi\n\n` +
            (yanit ? `💬 Kurum Yanıtı: ${yanit}\n\n` : '') +
            `Daha fazla bilgi için lütfen bizimle iletişime geçiniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `talep_${durum}`)
          .then(result => console.log('✅ WhatsApp bildirimi gönderildi:', result))
          .catch(error => console.error('❌ WhatsApp bildirimi hatası:', error));
      }
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep başarıyla onaylandı!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Talep yanıtlama hatası:', error);
    res.json({ success: false, message: 'Talep işlenirken bir hata oluştu!' });
  }
});

// Kurum - Veli Listesi API (Rehber Talep için)
app.get('/kurum/veliler-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('📡 Veli listesi API çağrıldı');
    const veliler = await dbAll(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE user_type = 'veli'
      ORDER BY ad_soyad ASC, username ASC
    `);
    
    console.log(`✅ ${veliler.length} veli bulundu`);
    res.json(veliler);
  } catch (error) {
    console.error('❌ Veli listesi hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber Öğretmen Listesi API
app.get('/kurum/rehberler-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const rehberler = await dbAll(`
      SELECT 
        id,
        username,
        ad_soyad,
        brans,
        email,
        telefon
      FROM users
      WHERE user_type = 'rehber_ogretmen'
      ORDER BY ad_soyad ASC, username ASC
    `);
    
    res.json(rehberler);
  } catch (error) {
    console.error('Rehber listesi hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Tüm Öğrenciler API (Kurum + Veli öğrencileri)
app.get('/kurum/tum-ogrenciler-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('📡 Tüm öğrenciler API çağrıldı');
    
    // Veli öğrencileri
    let veliOgrencileri = [];
    try {
      veliOgrencileri = await dbAll(`
        SELECT 
          o.id,
          o.ad_soyad,
          o.tc_no,
          o.sinif,
          o.okul,
          o.telefon,
          o.ogrenci_no,
          o.veli_id,
          'veli' as kaynak
        FROM ogrenciler o
        WHERE o.veli_id IS NOT NULL
        ORDER BY o.ad_soyad ASC
      `);
      console.log(`✅ ${veliOgrencileri.length} veli öğrencisi bulundu`);
    } catch (error) {
      console.error('❌ Veli öğrencileri yükleme hatası:', error);
    }
    
    // Kurum öğrencileri
    let kurumOgrencileri = [];
    try {
      kurumOgrencileri = await dbAll(`
        SELECT 
          ok.id,
          ok.ogrenci_adi_soyadi as ad_soyad,
          ok.tc_kimlik_no as tc_no,
          ok.sinif,
          '' as okul,
          ok.telefon,
          '' as ogrenci_no,
          NULL as veli_id,
          ok.veli_adi,
          ok.veli_telefon,
          'kurum' as kaynak
        FROM ogrenci_kayitlari ok
        ORDER BY ok.ogrenci_adi_soyadi ASC
      `);
      console.log(`✅ ${kurumOgrencileri.length} kurum öğrencisi bulundu`);
    } catch (error) {
      console.error('❌ Kurum öğrencileri yükleme hatası:', error);
    }
    
    // Birleştir
    const tumOgrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    console.log(`✅ Toplam ${tumOgrenciler.length} öğrenci döndürülüyor`);
    
    res.json(tumOgrenciler);
  } catch (error) {
    console.error('❌ Tüm öğrenci listesi hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Veli Bilgisi API
app.get('/kurum/veli-bilgi-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id } = req.query;
    
    if (!veli_id) {
      return res.status(400).json({ success: false, message: 'Veli ID gerekli!' });
    }
    
    const veli = await dbGet(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE id = ? AND user_type = 'veli'
    `, [veli_id]);
    
    if (!veli) {
      return res.status(404).json({ success: false, message: 'Veli bulunamadı!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Veli bilgisi hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Telefon ile Veli Bul API
app.get('/kurum/veli-bul-telefon', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { telefon } = req.query;
    
    if (!telefon) {
      return res.status(400).json({ success: false, message: 'Telefon numarası gerekli!' });
    }
    
    // Telefon numarasını temizle (.0 gibi ekleri kaldır)
    let temizTelefon = telefon.toString().trim();
    if (temizTelefon.endsWith('.0')) {
      temizTelefon = temizTelefon.replace('.0', '');
    }
    const telefonNokta = temizTelefon + '.0';
    
    // Telefon numarası ile veli ara - hem temiz hem de .0 formatında ara
    const veli = await dbGet(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE user_type = 'veli' 
        AND (telefon = ? OR telefon = ? OR username = ? OR username = ?)
      LIMIT 1
    `, [temizTelefon, telefonNokta, temizTelefon, telefonNokta]);
    
    if (!veli) {
      return res.status(404).json({ success: false, message: 'Veli bulunamadı!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Telefon ile veli arama hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Veli Öğrencileri API
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id } = req.query;
    
    if (!veli_id) {
      return res.status(400).json({ success: false, message: 'Veli ID gerekli!' });
    }
    
    const ogrenciler = await dbAll(`
      SELECT 
        id,
        ad_soyad,
        tc_no,
        sinif,
        okul,
        telefon,
        ogrenci_no
      FROM ogrenciler
      WHERE veli_id = ?
      ORDER BY ad_soyad ASC
    `, [veli_id]);
    
    res.json(ogrenciler);
  } catch (error) {
    console.error('Öğrenci listesi hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber Öğretmene Talep Gönder
app.post('/kurum/rehber-talep-gonder', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id, ogrenci_id, rehber_ogretmen_id, ogrenci_no, ad_soyad, sinif, okul, mesaj, ogrenci_kaynak } = req.body;
    
    console.log('📥 Talep gönderme isteği:', { veli_id, ogrenci_id, rehber_ogretmen_id, ad_soyad, ogrenci_kaynak });
    
    if (!veli_id || !rehber_ogretmen_id || !ad_soyad) {
      return res.json({ success: false, message: 'Eksik bilgiler! (veli_id, rehber_ogretmen_id, ad_soyad gerekli)' });
    }
    
    // Kurum öğrencileri için ogrenci_id NULL olabilir
    const kullanilacakOgrenciId = (ogrenci_kaynak === 'kurum') ? null : ogrenci_id;
    
    // Aynı talep var mı kontrol et (ogrenci_id varsa) - Beklemede VEYA Onaylı talep kontrolü
    if (kullanilacakOgrenciId) {
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi')
      `, [kullanilacakOgrenciId, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu öğrenci için bu rehber öğretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu öğrenci için bu rehber öğretmene zaten onaylı bir talep var!' });
        }
      }
    } else {
      // Kurum öğrencileri için ad_soyad ve veli_id ile kontrol et
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ad_soyad = ? AND veli_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi') AND ogrenci_id IS NULL
      `, [ad_soyad, veli_id, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu öğrenci için bu rehber öğretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu öğrenci için bu rehber öğretmene zaten onaylı bir talep var!' });
        }
      }
    }
    
    // Talep oluştur
    // rehber_id ve rehber_ogretmen_id aynı değer (kurum tarafından gönderildiği için)
    await dbRun(`
      INSERT INTO ogrenci_talepleri 
      (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum, mesaj)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'beklemede', ?)
    `, [kullanilacakOgrenciId, ogrenci_no || '', ad_soyad, sinif || '', okul || '', veli_id, rehber_ogretmen_id, rehber_ogretmen_id, mesaj || '']);
    
    console.log('✅ Talep başarıyla oluşturuldu');
    
    // Veli ve rehber bilgilerini al
    const veli = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [veli_id]);
    const rehber = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [rehber_ogretmen_id]);
    
    // WhatsApp bildirimi gönder (arka planda)
    if (veli && veli.telefon) {
      const veliMesaj = `📩 YENİ REHBER ÖĞRETMEN TALEBİ\n\n` +
        `Merhaba ${veli.ad_soyad || 'Değerli Velimiz'},\n\n` +
        `Kurum tarafından sizin adınıza rehber öğretmen yetki talebi gönderilmiştir.\n\n` +
        `👤 Öğrenci: ${ad_soyad}\n` +
        `👨‍🏫 Rehber: ${rehber?.ad_soyad || 'Rehber Öğretmen'}\n\n` +
        `Talebiniz onaylandığında rehber öğretmen öğrenciniz hakkında bilgilere erişebilecektir.`;
      
      whatsappBildirimGonder(veli.telefon, veliMesaj, 'rehber_talep_kurum')
        .then(result => console.log('✅ Veli WhatsApp bildirimi gönderildi:', result))
        .catch(error => console.error('❌ Veli WhatsApp bildirimi hatası:', error));
    }
    
    if (rehber && rehber.telefon) {
      const rehberMesaj = `📩 YENİ ÖĞRENCİ YETKİ TALEBİ\n\n` +
        `Merhaba ${rehber.ad_soyad || 'Değerli Rehber Öğretmenimiz'},\n\n` +
        `Kurum tarafından size yeni bir öğrenci yetki talebi gönderilmiştir.\n\n` +
        `👤 Öğrenci: ${ad_soyad}\n` +
        `👨‍👩‍👧 Veli: ${veli?.ad_soyad || 'Veli'}\n` +
        `${sinif ? `📚 Sınıf: ${sinif}\n` : ''}` +
        `${okul ? `🏫 Okul: ${okul}\n` : ''}` +
        `${mesaj ? `\n💬 Mesaj: ${mesaj}\n` : ''}\n` +
        `Lütfen veli panelinden talebi inceleyip onaylayın veya reddedin.`;
      
      whatsappBildirimGonder(rehber.telefon, rehberMesaj, 'rehber_talep_kurum')
        .then(result => console.log('✅ Rehber WhatsApp bildirimi gönderildi:', result))
        .catch(error => console.error('❌ Rehber WhatsApp bildirimi hatası:', error));
    }
    
    res.json({ 
      success: true, 
      message: 'Rehber öğretmene talep başarıyla gönderildi!' 
    });
    
  } catch (error) {
    console.error('❌ Rehber talep gönderme hatası:', error);
    console.error('Hata detayı:', error.message);
    console.error('Stack trace:', error.stack);
    res.json({ 
      success: false, 
      message: `Talep gönderilirken bir hata oluştu: ${error.message}` 
    });
  }
});

// Kurum - Öğrenci Kayıtları Yönetimi
// API: Kurum Öğrenci Kayıtları (JSON)
app.get('/kurum/ogrenci-kayitlari-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY ogrenci_adi_soyadi ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API öğrenci kayıtları hatası:', error);
    res.json([]);
  }
});

// API: Veli Öğrencileri (JSON)
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler ORDER BY ad_soyad ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API veli öğrencileri hatası:', error);
    res.json([]);
  }
});

app.get('/kurum/ogrenci-kayitlari', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY created_at DESC');
    
    // Benzersiz sınıf listesi
    const siniflar = [...new Set(ogrenciler.map(o => o.sinif).filter(s => s))].sort();
    
    // Session mesajlarını al ve hemen temizle
    const errorMsg = req.session.error;
    const successMsg = req.session.success;
    req.session.error = null;
    req.session.success = null;
    
    res.render('kurum/ogrenci-kayitlari', {
      ogrenciler: ogrenciler,
      siniflar: siniflar,
      user: { username: req.session.username, type: req.session.userType },
      error: errorMsg,
      success: successMsg
    });
  } catch (error) {
    console.error('Öğrenci kayıtları listesi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Öğrenci Kayıt Ekle
app.post('/kurum/ogrenci-kayit-ekle', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const {
      sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
      veli_adi, veli_telefon, tutar, odeme_durumu,
      odeme_turu, edessis_kaydi, taksit
    } = req.body;
    
    await dbRun(
      `INSERT INTO ogrenci_kayitlari (
        sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
        veli_adi, veli_telefon, tutar, odeme_durumu,
        odeme_turu, edessis_kaydi, taksit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
       veli_adi, veli_telefon, tutar, odeme_durumu,
       odeme_turu, edessis_kaydi, taksit]
    );
    
    res.json({ success: true, message: 'Öğrenci kaydı başarıyla eklendi!' });
  } catch (error) {
    console.error('Öğrenci kayıt ekleme hatası:', error);
    res.json({ success: false, message: 'Kayıt eklenirken bir hata oluştu: ' + error.message });
  }
});

// Kurum - Hesapsız Velileri Kontrol Et
app.get('/kurum/kontrol-hesapsiz-veliler', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    // ogrenci_kayitlari'daki veli telefonlarını al
    const veriTabani = await dbAll(`
      SELECT veli_adi, veli_telefon, COUNT(*) as ogrenci_sayisi
      FROM ogrenci_kayitlari
      WHERE veli_telefon IS NOT NULL AND veli_telefon != ''
      GROUP BY veli_telefon
    `);
    
    console.log(`\n👥 HESAPSIZ VELİ KONTROLÜ`);
    console.log(`   Toplam farklı veli: ${veriTabani.length}`);
    
    // Sistemde hesabı olmayanları filtrele
    const hesapsizVeliler = [];
    for (const veli of veriTabani) {
      // Telefon formatını temizle
      let telefonTemiz = veli.veli_telefon.toString().trim();
      if (telefonTemiz.endsWith('.0')) {
        telefonTemiz = telefonTemiz.replace('.0', '');
      }
      const telefonNokta = telefonTemiz + '.0';
      
      // Hem temiz hem de .0 formatında ara
      const mevcutHesap = await dbGet(
        'SELECT id FROM users WHERE (telefon = ? OR telefon = ? OR username = ? OR username = ?)',
        [telefonTemiz, telefonNokta, telefonTemiz, telefonNokta]
      );
      
      if (!mevcutHesap) {
        hesapsizVeliler.push(veli);
        console.log(`   ❌ Hesapsız: ${veli.veli_telefon} (${veli.veli_adi || 'İsimsiz'})`);
      }
    }
    
    console.log(`   📊 Hesapsız veli: ${hesapsizVeliler.length}`);
    
    res.json({
      success: true,
      veliler: hesapsizVeliler
    });
  } catch (error) {
    console.error('Kontrol hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Toplu Veli Hesabı Oluştur
app.post('/kurum/toplu-veli-hesap-olustur', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    // Hesapsız velileri bul
    const veriTabani = await dbAll(`
      SELECT DISTINCT veli_adi, veli_telefon
      FROM ogrenci_kayitlari
      WHERE veli_telefon IS NOT NULL AND veli_telefon != ''
    `);
    
    console.log(`\n✨ TOPLU VELİ HESAP OLUŞTURMA`);
    console.log(`   Kontrol edilecek veli: ${veriTabani.length}`);
    
    let olusturulan = 0;
    const defaultPassword = await bcrypt.hash('Veli2024!', 10);
    
    for (const veli of veriTabani) {
      // Telefon formatını temizle
      let telefonTemiz = veli.veli_telefon.toString().trim();
      if (telefonTemiz.endsWith('.0')) {
        telefonTemiz = telefonTemiz.replace('.0', '');
      }
      const telefonNokta = telefonTemiz + '.0';
      
      // Hesap var mı kontrol et - hem temiz hem de .0 formatında ara
      const mevcutHesap = await dbGet(
        'SELECT id FROM users WHERE (telefon = ? OR telefon = ? OR username = ? OR username = ?)',
        [telefonTemiz, telefonNokta, telefonTemiz, telefonNokta]
      );
      
      if (!mevcutHesap) {
        // Yeni hesap oluştur - temiz telefon formatıyla
        await dbRun(`
          INSERT INTO users (username, password_hash, user_type, telefon, ad_soyad, email, created_at)
          VALUES (?, ?, 'veli', ?, ?, ?, datetime('now'))
        `, [
          telefonTemiz,
          defaultPassword,
          telefonTemiz,
          veli.veli_adi || 'Veli',
          telefonTemiz + '@temp.com'
        ]);
        olusturulan++;
        
        console.log(`   ✅ Veli hesabı oluşturuldu: ${telefonTemiz} (${veli.veli_adi})`);
      }
    }
    
    console.log(`   📊 Toplam oluşturulan: ${olusturulan}`);
    
    res.json({
      success: true,
      olusturulan: olusturulan,
      message: `${olusturulan} veli hesabı başarıyla oluşturuldu!`
    });
  } catch (error) {
    console.error('Toplu hesap oluşturma hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Veli Giriş Bilgisi Getir
app.get('/kurum/veli-giris-bilgisi', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    let { telefon } = req.query;
    
    if (!telefon) {
      return res.json({ success: false, message: 'Telefon numarası gerekli!' });
    }
    
    // Telefon formatını temizle (.0 ile biten)
    telefon = telefon.toString().trim();
    const telefonTemiz = telefon.endsWith('.0') ? telefon.replace('.0', '') : telefon;
    const telefonNokta = telefonTemiz + '.0';
    
    // Veli hesabını bul - hem temiz hem de .0 formatında ara
    const veli = await dbGet(
      'SELECT username, password_hash, created_at FROM users WHERE (telefon = ? OR telefon = ? OR username = ? OR username = ?) AND user_type = ?',
      [telefonTemiz, telefonNokta, telefonTemiz, telefonNokta, 'veli']
    );
    
    if (!veli) {
      return res.json({ 
        success: true, 
        hesapVar: false 
      });
    }
    
    // İlk şifre hash'i
    const ilkSifreHash = '$2b$10$';  // bcrypt başlangıcı
    const defaultPassword = 'Veli2024!';
    
    // Şifre değiştirilmiş mi kontrol et
    // (Basit kontrol: created_at ile password_hash hash'i aynı zamanda mı oluşturulmuş)
    // Daha güvenli: password_hash'i "Veli2024!" ile karşılaştır
    const sifreDegismis = !await bcrypt.compare(defaultPassword, veli.password_hash);
    
    // Username'deki .0 formatını temizle
    let usernameTemiz = veli.username.toString();
    if (usernameTemiz.endsWith('.0')) {
      usernameTemiz = usernameTemiz.replace('.0', '');
    }
    
    console.log(`\n👁️ VELİ BİLGİSİ GÖSTERİLDİ`);
    console.log(`   Telefon: ${telefon}`);
    console.log(`   Username (orijinal): ${veli.username}`);
    console.log(`   Username (temiz): ${usernameTemiz}`);
    console.log(`   Şifre değişmiş: ${sifreDegismis ? 'Evet' : 'Hayır'}`);
    
    res.json({
      success: true,
      hesapVar: true,
      username: usernameTemiz,
      sifre: defaultPassword,
      sifreDegismis: sifreDegismis
    });
  } catch (error) {
    console.error('Veli bilgi getirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Öğrenci Kayıt Güncelle
app.post('/kurum/ogrenci-kayit-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { id } = req.params;
    const {
      sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
      veli_adi, veli_telefon, tutar, odeme_durumu,
      odeme_turu, edessis_kaydi, taksit
    } = req.body;
    
    await dbRun(
      `UPDATE ogrenci_kayitlari SET
        sinif = ?, ogrenci_adi_soyadi = ?, telefon = ?, tc_kimlik_no = ?,
        veli_adi = ?, veli_telefon = ?, tutar = ?, odeme_durumu = ?,
        odeme_turu = ?, edessis_kaydi = ?, taksit = ?,
        updated_at = datetime('now')
      WHERE id = ?`,
      [sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
       veli_adi, veli_telefon, tutar, odeme_durumu,
       odeme_turu, edessis_kaydi, taksit, id]
    );
    
    res.json({ success: true, message: 'Öğrenci kaydı güncellendi!' });
  } catch (error) {
    console.error('Öğrenci kayıt güncelleme hatası:', error);
    res.json({ success: false, message: 'Güncelleme sırasında bir hata oluştu!' });
  }
});

// Kurum - Öğrenci Kayıt Sil
app.post('/kurum/ogrenci-kayit-sil/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM ogrenci_kayitlari WHERE id = ?', [id]);
    res.json({ success: true, message: 'Öğrenci kaydı silindi!' });
  } catch (error) {
    console.error('Öğrenci kayıt silme hatası:', error);
    res.json({ success: false, message: 'Silme sırasında bir hata oluştu!' });
  }
});

// Kurum - TÜM Öğrenci Kayıtlarını Sil
app.post('/kurum/ogrenci-kayitlari-tumunu-sil', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { onayKodu } = req.body;
    
    // Güvenlik kontrolü: "SİL" yazması gerekiyor
    if (onayKodu !== 'SİL') {
      return res.json({ success: false, message: 'Onay kodu hatalı! "SİL" yazmanız gerekiyor.' });
    }
    
    // Kaç kayıt var?
    const kayitSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    
    // Tüm kayıtları sil
    await dbRun('DELETE FROM ogrenci_kayitlari');
    
    console.log(`\n⚠️  TÜM ÖĞRENCİ KAYITLARI SİLİNDİ!`);
    console.log(`   Silinen kayıt sayısı: ${kayitSayisi.sayi}`);
    console.log(`   Yapan kullanıcı: ${req.session.username}\n`);
    
    res.json({ 
      success: true, 
      message: `${kayitSayisi.sayi} öğrenci kaydı başarıyla silindi!` 
    });
  } catch (error) {
    console.error('Toplu silme hatası:', error);
    res.json({ success: false, message: 'Silme işlemi sırasında bir hata oluştu!' });
  }
});

// Kurum - Excel Import
app.post('/kurum/ogrenci-import-excel', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    if (!req.file) {
      return res.json({ success: false, message: 'Excel dosyası seçilmedi!' });
    }
    
    const xlsx = require('xlsx');
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);
    
    console.log('\n📥 EXCEL IMPORT BAŞLADI');
    console.log(`📊 Toplam satır: ${data.length}`);
    
    if (data.length > 0) {
      console.log('📋 Excel başlıkları:', Object.keys(data[0]));
      console.log('🔍 İlk satır örneği:', data[0]);
    }
    
    let eklenenSayisi = 0;
    let hataliSayisi = 0;
    
    for (const row of data) {
      try {
        // Tüm olası başlık varyasyonlarını dene (boşluklar, büyük/küçük harf)
        const keys = Object.keys(row);
        
        // Sınıf bilgisini bul
        const sinifKey = keys.find(k => 
          k.includes('SINIF') || k.includes('Sınıf') || k.includes('sınıf') || k === 'sinif'
        );
        const sinif = sinifKey ? row[sinifKey] : '';
        
        // Öğrenci adını bul
        const isimKey = keys.find(k => 
          k.includes('ADI') || k.includes('SOYADI') || k.includes('Adı') || k.includes('Soyadı') || k === 'ogrenci_adi_soyadi'
        );
        const ogrenciAdi = isimKey ? row[isimKey] : '';
        
        if (!ogrenciAdi || !sinif) {
          console.log(`⚠️ Eksik veri: Sınıf="${sinif}" (key: ${sinifKey}), İsim="${ogrenciAdi}" (key: ${isimKey})`);
          console.log(`   Satır:`, row);
          hataliSayisi++;
          continue;
        }
        
        // Diğer alanları da dinamik bul
        const telefonKey = keys.find(k => k.includes('TELEFON') && !k.includes('VELİ'));
        const tcKey = keys.find(k => k.includes('T.C') || k.includes('TC') || k.includes('KİMLİK'));
        const veliAdiKey = keys.find(k => k.includes('VELİ') && (k.includes('ADI') || k === 'ÖĞRENCİ VELİ'));
        const veliTelKey = keys.find(k => k.includes('VELİ') && k.includes('TELEFON'));
        const tutarKey = keys.find(k => k.includes('TUTAR'));
        const odemeDurumKey = keys.find(k => k.includes('ÖDEME') && k.includes('DURUM'));
        const odemeTurKey = keys.find(k => k.includes('ÖDEME') && k.includes('TÜR'));
        const edesisKey = keys.find(k => k.includes('EDESIS') || k.includes('EDEŞİS') || k.includes('KAYDI'));
        const taksitKey = keys.find(k => k.includes('TAKSİT') || k.includes('TAKSIT'));
        
        await dbRun(
          `INSERT INTO ogrenci_kayitlari (
            sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
            veli_adi, veli_telefon, tutar, odeme_durumu,
            odeme_turu, edessis_kaydi, taksit
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sinif,
            ogrenciAdi,
            telefonKey ? row[telefonKey] : '',
            tcKey ? row[tcKey] : '',
            veliAdiKey ? row[veliAdiKey] : '',
            veliTelKey ? row[veliTelKey] : '',
            tutarKey ? row[tutarKey] : '',
            odemeDurumKey ? row[odemeDurumKey] : 'BEKLİYOR',
            odemeTurKey ? row[odemeTurKey] : '',
            edesisKey ? row[edesisKey] : '',
            taksitKey ? row[taksitKey] : ''
          ]
        );
        eklenenSayisi++;
      } catch (error) {
        console.error('❌ Satır ekleme hatası:', error.message);
        hataliSayisi++;
      }
    }
    
    console.log(`\n✅ Excel import tamamlandı: ${eklenenSayisi} eklendi, ${hataliSayisi} hata\n`);
    
    // Yüklenen dosyayı sil
    fs.unlinkSync(req.file.path);
    
    res.json({ 
      success: true, 
      message: `${eklenenSayisi} kayıt eklendi. ${hataliSayisi > 0 ? hataliSayisi + ' kayıt hatası.' : ''}` 
    });
  } catch (error) {
    console.error('Excel import hatası:', error);
    res.json({ success: false, message: 'Excel içeri aktarılırken bir hata oluştu: ' + error.message });
  }
});

// Kurum - Excel Şablon İndir
app.get('/kurum/ogrenci-sablon-indir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const xlsx = require('xlsx');
    
    // Şablon veri: Sadece başlıklar + 2 örnek satır
    const sablonData = [
      {
        'ÖĞRENCI SINIF BİLGİSİ': '3',
        'ÖĞRENCI ADI SOYADI': 'Örnek Öğrenci 1',
        'TELEFON KAYDI': '05321234567',
        'T.C KİMLİK NO': '12345678901',
        'ÖĞRENCİ VELİ': 'Örnek Veli 1',
        'VELİ TELEFON': '05321234567',
        'TUTAR': '4.000 TRY',
        'ÖDEME DURUMU': 'BEKLİYOR',
        'ÖDEME TÜRÜ': '',
        'EDESIS KAYDI': '',
        'TAKSİT': '2'
      },
      {
        'ÖĞRENCI SINIF BİLGİSİ': '5',
        'ÖĞRENCI ADI SOYADI': 'Örnek Öğrenci 2',
        'TELEFON KAYDI': '',
        'T.C KİMLİK NO': '',
        'ÖĞRENCİ VELİ': 'Örnek Veli 2',
        'VELİ TELEFON': '05329876543',
        'TUTAR': '5.000 TRY',
        'ÖDEME DURUMU': 'YAPILDI',
        'ÖDEME TÜRÜ': 'HAVALE',
        'EDESIS KAYDI': 'EVET',
        'TAKSİT': ''
      }
    ];
    
    const worksheet = xlsx.utils.json_to_sheet(sablonData);
    
    // Sütun genişliklerini ayarla
    worksheet['!cols'] = [
      { wch: 22 }, // ÖĞRENCI SINIF BİLGİSİ
      { wch: 25 }, // ÖĞRENCI ADI SOYADI
      { wch: 15 }, // TELEFON KAYDI
      { wch: 15 }, // T.C KİMLİK NO
      { wch: 20 }, // ÖĞRENCİ VELİ
      { wch: 15 }, // VELİ TELEFON
      { wch: 12 }, // TUTAR
      { wch: 15 }, // ÖDEME DURUMU
      { wch: 12 }, // ÖDEME TÜRÜ
      { wch: 15 }, // EDESIS KAYDI
      { wch: 10 }  // TAKSİT
    ];
    
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Öğrenci Kayıt Şablonu');
    
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename=ogrenci-kayit-sablonu.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Excel şablon oluşturma hatası:', error);
    res.status(500).send('Şablon oluşturulurken bir hata oluştu!');
  }
});

// Kurum - Excel Export
app.get('/kurum/ogrenci-export-excel', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const xlsx = require('xlsx');
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY sinif, ogrenci_adi_soyadi');
    
    // Excel için veri formatla
    const excelData = ogrenciler.map(o => ({
      'ÖĞRENCI SINIF BİLGİSİ': o.sinif,
      'ÖĞRENCI ADI SOYADI': o.ogrenci_adi_soyadi,
      'TELEFON KAYDI': o.telefon || '',
      'T.C KİMLİK NO': o.tc_kimlik_no || '',
      'ÖĞRENCİ VELİ': o.veli_adi || '',
      'VELİ TELEFON': o.veli_telefon || '',
      'TUTAR': o.tutar || '',
      'ÖDEME DURUMU': o.odeme_durumu || '',
      'ÖDEME TÜRÜ': o.odeme_turu || '',
      'EDESIS KAYDI': o.edessis_kaydi || '',
      'TAKSİT': o.taksit || ''
    }));
    
    const worksheet = xlsx.utils.json_to_sheet(excelData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Öğrenci Kayıtları');
    
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename=ogrenci-kayitlari.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Excel export hatası:', error);
    res.status(500).send('Excel dışarı aktarılırken bir hata oluştu!');
  }
});

// Kurum - Sınav Yönetimi
app.get('/kurum/sinavlar', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY tarih DESC');
    
    res.render('kurum/sinavlar', {
      sinavlar: sinavlar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sınav listesi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ============ SINAV PAKETLERİ YÖNETİMİ ============

// Kurum - Sınav Paketleri Listesi
app.get('/kurum/sinav-paketleri', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // Paketleri ve ilgili istatistikleri çek
    const paketler = await dbAll(`
      SELECT 
        sp.*,
        COUNT(DISTINCT ps.sinav_id) as sinav_sayisi,
        COUNT(DISTINCT pa.ogrenci_id) as ogrenci_sayisi
      FROM sinav_paketleri sp
      LEFT JOIN paket_sinavlari ps ON sp.id = ps.paket_id
      LEFT JOIN paket_atamalari pa ON sp.id = pa.paket_id AND pa.durum = 'aktif'
      GROUP BY sp.id
      ORDER BY sp.olusturulma_tarihi DESC
    `);
    
    res.render('kurum/sinav-paketleri', {
      paketler: paketler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sınav paketleri listesi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Yeni Paket Oluştur (GET - Form)
app.get('/kurum/sinav-paketi-olustur', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // Mevcut sınavları çek
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY tarih DESC');
    const siniflar = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'Mezun'];
    
    res.render('kurum/sinav-paketi-olustur', {
      sinavlar: sinavlar,
      siniflar: siniflar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Paket oluşturma sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Yeni Paket Kaydet (POST)
app.post('/kurum/sinav-paketi-kaydet', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const { ad, aciklama, sinif, sinav_ids, fiyat } = req.body;
    
    if (!ad || !sinif) {
      return res.json({ success: false, message: 'Paket adı ve sınıf zorunludur!' });
    }
    
    // Paket oluştur
    const result = await dbRun(
      'INSERT INTO sinav_paketleri (ad, aciklama, sinif, toplam_sinav_sayisi, fiyat, kurum_id) VALUES (?, ?, ?, ?, ?, ?)',
      [ad, aciklama, sinif, 0, fiyat || 0, req.session.userId]
    );
    
    const paketId = result.lastID;
    
    // Sınavları pakete ekle
    if (sinav_ids && Array.isArray(sinav_ids) && sinav_ids.length > 0) {
      for (let i = 0; i < sinav_ids.length; i++) {
        await dbRun(
          'INSERT INTO paket_sinavlari (paket_id, sinav_id, sira) VALUES (?, ?, ?)',
          [paketId, sinav_ids[i], i + 1]
        );
      }
      
      // Toplam sınav sayısını güncelle
      await dbRun(
        'UPDATE sinav_paketleri SET toplam_sinav_sayisi = ? WHERE id = ?',
        [sinav_ids.length, paketId]
      );
    }
    
    console.log(`\n✅ YENİ PAKET OLUŞTURULDU`);
    console.log(`   Paket ID: ${paketId}`);
    console.log(`   Ad: ${ad}`);
    console.log(`   Sınıf: ${sinif}`);
    console.log(`   Fiyat: ${fiyat || 0} ₺`);
    console.log(`   Sınav Sayısı: ${sinav_ids ? sinav_ids.length : 0}`);
    
    res.json({ success: true, paketId: paketId, message: 'Paket başarıyla oluşturuldu!' });
  } catch (error) {
    console.error('Paket kaydetme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Paket Düzenle (Form)
app.get('/kurum/sinav-paketi-duzenle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const paketId = req.params.id;
    
    // Paket bilgilerini al
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    
    if (!paket) {
      return res.status(404).send('Paket bulunamadı!');
    }
    
    // Tüm sınavları al
    const tumSinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY tarih DESC');
    
    // Paketteki sınav ID'lerini al
    const paketSinavlari = await dbAll(
      'SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?',
      [paketId]
    );
    const secilenSinavIds = paketSinavlari.map(ps => ps.sinav_id);
    
    // Sınıf listesi
    const siniflar = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    
    res.render('kurum/sinav-paketi-duzenle', {
      paket: paket,
      sinavlar: tumSinavlar,
      secilenSinavIds: secilenSinavIds,
      siniflar: siniflar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Paket düzenleme formu hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Paket Güncelle
app.post('/kurum/sinav-paketi-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const paketId = req.params.id;
    const { ad, aciklama, sinif, sinav_ids, fiyat } = req.body;
    
    if (!ad || !sinif) {
      return res.json({ success: false, message: 'Paket adı ve sınıf zorunludur!' });
    }
    
    // Paket bilgilerini güncelle
    await dbRun(
      'UPDATE sinav_paketleri SET ad = ?, aciklama = ?, sinif = ?, fiyat = ?, toplam_sinav_sayisi = ? WHERE id = ?',
      [ad, aciklama, sinif, fiyat || 0, sinav_ids ? sinav_ids.length : 0, paketId]
    );
    
    // Mevcut sınav ilişkilerini sil
    await dbRun('DELETE FROM paket_sinavlari WHERE paket_id = ?', [paketId]);
    
    // Yeni sınav ilişkilerini ekle
    if (sinav_ids && Array.isArray(sinav_ids) && sinav_ids.length > 0) {
      for (let i = 0; i < sinav_ids.length; i++) {
        await dbRun(
          'INSERT INTO paket_sinavlari (paket_id, sinav_id, sira) VALUES (?, ?, ?)',
          [paketId, sinav_ids[i], i + 1]
        );
      }
    }
    
    console.log(`\n✅ PAKET GÜNCELLENDİ`);
    console.log(`   Paket ID: ${paketId}`);
    console.log(`   Ad: ${ad}`);
    console.log(`   Sınıf: ${sinif}`);
    console.log(`   Fiyat: ${fiyat || 0} ₺`);
    console.log(`   Sınav Sayısı: ${sinav_ids ? sinav_ids.length : 0}`);
    
    res.json({ success: true, message: 'Paket başarıyla güncellendi!' });
  } catch (error) {
    console.error('Paket güncelleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Paket Detay
app.get('/kurum/sinav-paketi-detay/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const paketId = req.params.id;
    
    // Paket bilgilerini al
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    
    if (!paket) {
      return res.status(404).send('Paket bulunamadı!');
    }
    
    // Paketteki sınavları al
    const sinavlar = await dbAll(`
      SELECT s.*, ps.sira
      FROM sinavlar s
      INNER JOIN paket_sinavlari ps ON s.id = ps.sinav_id
      WHERE ps.paket_id = ?
      ORDER BY ps.sira ASC
    `, [paketId]);
    
    // Atanan öğrencileri al (hem kurum hem veli kayıtları)
    const ogrenciler = await dbAll(`
      SELECT 
        pa.id as atama_id,
        pa.ogrenci_id,
        pa.ogrenci_kaynak,
        pa.atama_tarihi,
        pa.durum,
        CASE 
          WHEN pa.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          ELSE o.ad_soyad
        END as ogrenci_adi,
        CASE 
          WHEN pa.ogrenci_kaynak = 'kurum' THEN ok.sinif
          ELSE o.sinif
        END as sinif
      FROM paket_atamalari pa
      LEFT JOIN ogrenci_kayitlari ok ON pa.ogrenci_id = ok.id AND pa.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON pa.ogrenci_id = o.id AND pa.ogrenci_kaynak = 'veli'
      WHERE pa.paket_id = ? AND pa.durum = 'aktif'
      ORDER BY pa.atama_tarihi DESC
    `, [paketId]);
    
    res.render('kurum/sinav-paketi-detay', {
      paket: paket,
      sinavlar: sinavlar,
      ogrenciler: ogrenciler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Paket detay hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Pakete Öğrenci Ata
app.post('/kurum/paket-ogrenci-ata', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const { paket_id, ogrenci_ids } = req.body;
    
    if (!paket_id || !ogrenci_ids || ogrenci_ids.length === 0) {
      return res.json({ success: false, message: 'Paket ve öğrenci seçimi zorunludur!' });
    }
    
    // Paketteki sınavları al
    const paketSinavlari = await dbAll(
      'SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?',
      [paket_id]
    );
    
    let atananSayi = 0;
    
    for (const ogrenci of ogrenci_ids) {
      const [ogrenci_id, kaynak] = ogrenci.split('_');
      
      // Paket ataması yap
      const mevcutAtama = await dbGet(
        'SELECT id FROM paket_atamalari WHERE paket_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?',
        [paket_id, ogrenci_id, kaynak]
      );
      
      if (!mevcutAtama) {
        await dbRun(
          'INSERT INTO paket_atamalari (paket_id, ogrenci_id, ogrenci_kaynak, durum) VALUES (?, ?, ?, ?)',
          [paket_id, ogrenci_id, kaynak, 'aktif']
        );
        
        // Her sınav için sinav_katilimcilari tablosuna ekle
        for (const sinav of paketSinavlari) {
          const mevcutKatilim = await dbGet(
            'SELECT id FROM sinav_katilimcilari WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?',
            [sinav.sinav_id, ogrenci_id, kaynak]
          );
          
          if (!mevcutKatilim) {
            await dbRun(
              'INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak) VALUES (?, ?, ?)',
              [sinav.sinav_id, ogrenci_id, kaynak]
            );
          }
        }
        
        atananSayi++;
      }
    }
    
    console.log(`\n✅ PAKET ATAMASI YAPILDI`);
    console.log(`   Paket ID: ${paket_id}`);
    console.log(`   Atanan Öğrenci: ${atananSayi}`);
    
    res.json({ success: true, message: `${atananSayi} öğrenci pakete atandı ve sınavlara kaydedildi!` });
  } catch (error) {
    console.error('Paket atama hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Paket Sil
app.post('/kurum/sinav-paketi-sil/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const paketId = req.params.id;
    
    // Paketi pasif yap (silme yerine)
    await dbRun('UPDATE sinav_paketleri SET aktif = 0 WHERE id = ?', [paketId]);
    
    // Atamaları iptal et
    await dbRun('UPDATE paket_atamalari SET durum = "iptal" WHERE paket_id = ?', [paketId]);
    
    console.log(`\n❌ PAKET SİLİNDİ (Pasif yapıldı)`);
    console.log(`   Paket ID: ${paketId}`);
    
    res.json({ success: true, message: 'Paket başarıyla silindi!' });
  } catch (error) {
    console.error('Paket silme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Sınav Ekle
app.post('/kurum/sinav-ekle', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const { ad, tarih, fiyat, aciklama, sinif, ders } = req.body;
    
    await dbRun(
      `INSERT INTO sinavlar (ad, tarih, fiyat, aciklama, sinif, ders, sinav_durumu) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ad, tarih, fiyat || 0, aciklama || '', sinif || '', ders || '', 'Başvuru aşamasında']
    );
    
    req.session.success = 'Sınav başarıyla eklendi!';
    res.redirect('/kurum/sinavlar');
  } catch (error) {
    console.error('Sınav ekleme hatası:', error);
    req.session.error = 'Sınav eklenirken bir hata oluştu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sınav Sil
app.post('/kurum/sinav-sil/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    await dbRun('DELETE FROM sinavlar WHERE id = ?', [req.params.id]);
    
    req.session.success = 'Sınav başarıyla silindi!';
    res.redirect('/kurum/sinavlar');
  } catch (error) {
    console.error('Sınav silme hatası:', error);
    req.session.error = 'Sınav silinirken bir hata oluştu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sınav Detay (Katılımcı Yönetimi)
app.get('/kurum/sinav-detay/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      req.session.error = 'Sınav bulunamadı!';
      return res.redirect('/kurum/sinavlar');
    }
    
    // Katılımcıları al (hem kurum hem veli kayıtlarından)
    const kurumKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        'kurum' as kaynak,
        ok.ogrenci_adi_soyadi as ad_soyad,
        ok.sinif,
        ok.telefon,
        ok.veli_adi,
        ok.veli_telefon
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
      ORDER BY ok.sinif, ok.ogrenci_adi_soyadi
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        'veli' as kaynak,
        o.ad_soyad,
        o.sinif,
        o.telefon,
        u.username as veli_adi,
        o.telefon as veli_telefon
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE sk.sinav_id = ?
      ORDER BY o.sinif, o.ad_soyad
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    // Tüm öğrencileri al (hem kurum kayıtları hem veli öğrencileri)
    const kurumOgrencileri = await dbAll(`
      SELECT 
        'kurum_' || id as unique_id,
        id as original_id,
        'kurum' as kaynak,
        ogrenci_adi_soyadi as ad_soyad,
        sinif,
        telefon,
        tc_kimlik_no as tc_no,
        veli_adi,
        veli_telefon
      FROM ogrenci_kayitlari
      ORDER BY sinif, ogrenci_adi_soyadi
    `);
    
    const veliOgrencileri = await dbAll(`
      SELECT 
        'veli_' || o.id as unique_id,
        o.id as original_id,
        'veli' as kaynak,
        o.ad_soyad,
        o.sinif,
        o.telefon,
        o.tc_no,
        u.username as veli_adi,
        o.telefon as veli_telefon
      FROM ogrenciler o
      LEFT JOIN users u ON o.veli_id = u.id
      ORDER BY o.sinif, o.ad_soyad
    `);
    
    // İki listeyi birleştir
    const tumOgrenciler = [...kurumOgrencileri, ...veliOgrencileri];
    
    console.log(`\n📊 Öğrenci Listesi (${tumOgrenciler.length} öğrenci):`);
    console.log(`  - Kurum kayıtları: ${kurumOgrencileri.length}`);
    console.log(`  - Veli öğrencileri: ${veliOgrencileri.length}`);
    if (tumOgrenciler.length > 0) {
      console.log('İlk 3 öğrenci örneği:');
      tumOgrenciler.slice(0, 3).forEach(o => {
        console.log(`  - [${o.kaynak}] ID: ${o.original_id}, İsim: "${o.ad_soyad}", Sınıf: "${o.sinif}"`);
      });
    } else {
      console.log('❌ Hiç öğrenci bulunamadı!');
    }
    
    // Benzersiz sınıf listesi
    const siniflar = [...new Set(tumOgrenciler.map(o => o.sinif).filter(s => s))].sort();
    
    // Session mesajlarını al ve hemen temizle
    const errorMsg = req.session.error;
    const successMsg = req.session.success;
    req.session.error = null;
    req.session.success = null;
    
    res.render('kurum/sinav-detay', {
      sinav: sinav,
      katilimcilar: katilimcilar,
      tumOgrenciler: tumOgrenciler,
      siniflar: siniflar,
      user: { username: req.session.username, type: req.session.userType },
      error: errorMsg,
      success: successMsg
    });
  } catch (error) {
    console.error('Sınav detay hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Katılımcı Ekle
app.post('/kurum/sinav-katilimci-ekle', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_ids } = req.body;
    
    if (!sinav_id || !ogrenci_ids || ogrenci_ids.length === 0) {
      return res.json({ success: false, message: 'Sınav ID veya öğrenci seçimi eksik!' });
    }
    
    let eklenenSayisi = 0;
    let mevcutSayisi = 0;
    
    for (const uniqueId of ogrenci_ids) {
      // unique_id'yi parse et (örn: "kurum_123" veya "veli_456")
      const parts = uniqueId.split('_');
      const kaynak = parts[0]; // 'kurum' veya 'veli'
      const ogrenciId = parts[1]; // gerçek ID
      
      // Zaten katılımcı mı kontrol et
      const mevcut = await dbGet(
        'SELECT * FROM sinav_katilimcilari WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?',
        [sinav_id, ogrenciId, kaynak]
      );
      
      if (mevcut) {
        mevcutSayisi++;
      } else {
        await dbRun(
          'INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak) VALUES (?, ?, ?)',
          [sinav_id, ogrenciId, kaynak]
        );
        eklenenSayisi++;
      }
    }
    
    // Katılımcı sayısını güncelle
    const yeniSayi = await dbGet(
      'SELECT COUNT(*) as sayi FROM sinav_katilimcilari WHERE sinav_id = ?',
      [sinav_id]
    );
    await dbRun(
      'UPDATE sinavlar SET katilimci_sayisi = ? WHERE id = ?',
      [yeniSayi.sayi, sinav_id]
    );
    
    res.json({ 
      success: true, 
      message: `${eklenenSayisi} öğrenci eklendi${mevcutSayisi > 0 ? `, ${mevcutSayisi} öğrenci zaten ekli` : ''}!` 
    });
  } catch (error) {
    console.error('Katılımcı ekleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Katılımcı Sil
app.post('/kurum/sinav-katilimci-sil/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const katilimciId = req.params.id;
    
    // Sınav ID'sini al (katılımcı sayısını güncellemek için)
    const katilimci = await dbGet('SELECT sinav_id FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    if (!katilimci) {
      return res.json({ success: false, message: 'Katılımcı bulunamadı!' });
    }
    
    // Katılımcıyı sil
    await dbRun('DELETE FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    // Katılımcı sayısını güncelle
    const yeniSayi = await dbGet(
      'SELECT COUNT(*) as sayi FROM sinav_katilimcilari WHERE sinav_id = ?',
      [katilimci.sinav_id]
    );
    await dbRun(
      'UPDATE sinavlar SET katilimci_sayisi = ? WHERE id = ?',
      [yeniSayi.sayi, katilimci.sinav_id]
    );
    
    res.json({ success: true, message: 'Katılımcı başarıyla çıkarıldı!' });
  } catch (error) {
    console.error('Katılımcı silme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Cevap Anahtarı Yükleme
app.post('/kurum/cevap-anahtari-yukle/:id', requireAuth, pdfUpload.single('cevapAnahtari'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    if (!req.file) {
      return res.json({ success: false, message: 'PDF dosyası yüklenmedi!' });
    }
    
    const pdfPath = req.file.path;
    
    // Sınav bilgilerini güncelle
    await dbRun(
      'UPDATE sinavlar SET cevap_anahtari_pdf = ? WHERE id = ?',
      [pdfPath, sinavId]
    );
    
    console.log(`✅ Cevap anahtarı yüklendi: ${pdfPath}`);
    
    res.json({ success: true, message: 'Cevap anahtarı başarıyla yüklendi!' });
  } catch (error) {
    console.error('Cevap anahtarı yükleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Sınav Durumu Güncelleme
app.post('/kurum/sinav-durumu-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    const { sinav_durumu } = req.body;
    
    if (!sinav_durumu) {
      return res.json({ success: false, message: 'Sınav durumu seçilmedi!' });
    }
    
    // Sınav durumunu güncelle
    await dbRun(
      'UPDATE sinavlar SET sinav_durumu = ? WHERE id = ?',
      [sinav_durumu, sinavId]
    );
    
    console.log(`✅ Sınav durumu güncellendi: ${sinav_durumu}`);
    
    res.json({ success: true, message: 'Sınav durumu başarıyla güncellendi!' });
  } catch (error) {
    console.error('Sınav durumu güncelleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// API - Öğrenci Ara (Autocomplete için - Sonuç yüklerken manuel eşleştirmede kullanılacak)
app.get('/api/ogrenci-ara', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { q, sinav_id } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }
    
    // Sınıfa kayıtlı öğrencileri ara
    let query = `
      SELECT 
        ok.id,
        ok.ogrenci_adi_soyadi,
        ok.sinif,
        ok.telefon,
        ok.veli_adi,
        ok.veli_telefon
      FROM ogrenci_kayitlari ok
      WHERE ok.ogrenci_adi_soyadi LIKE ?
    `;
    
    const params = [`%${q}%`];
    
    // Eğer sinav_id verilmişse, sınava katılımcı olarak eklenenlerden filtrele
    if (sinav_id) {
      query += ` AND ok.id IN (SELECT ogrenci_id FROM sinav_katilimcilari WHERE sinav_id = ?)`;
      params.push(sinav_id);
    }
    
    query += ` ORDER BY ok.ogrenci_adi_soyadi LIMIT 10`;
    
    const sonuclar = await dbAll(query, params);
    
    res.json(sonuclar);
  } catch (error) {
    console.error('Öğrenci arama hatası:', error);
    res.json([]);
  }
});

// Kurum - Sonuç Yükleme Sayfası
app.get('/kurum/sinav-sonuc-yukle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      req.session.error = 'Sınav bulunamadı!';
      return res.redirect('/kurum/sinavlar');
    }
    
    // Katılımcıları al (hem kurum hem veli kayıtlarından)
    const kurumKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        'kurum' as kaynak,
        ok.ogrenci_adi_soyadi as ad_soyad,
        ok.sinif,
        ok.telefon,
        ok.veli_adi,
        ok.veli_telefon
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
      ORDER BY ok.sinif, ok.ogrenci_adi_soyadi
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        'veli' as kaynak,
        o.ad_soyad,
        o.sinif,
        o.telefon,
        u.username as veli_adi,
        o.telefon as veli_telefon
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE sk.sinav_id = ?
      ORDER BY o.sinif, o.ad_soyad
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    if (katilimcilar.length === 0) {
      req.session.error = 'Bu sınava henüz katılımcı eklenmemiş! Önce öğrenci ekleyin.';
      return res.redirect(`/kurum/sinav-detay/${sinavId}`);
    }
    
    res.render('kurum/sinav-sonuc-yukle', {
      sinav: sinav,
      katilimcilar: katilimcilar,
      katilimciSayisi: katilimcilar.length,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sonuç yükleme sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Sonuç PDF Analiz (İlk sayfayı analiz et, isim pattern'i bul)
app.post('/kurum/sinav-sonuc-yukle-analiz', requireAuth, pdfUpload.single('pdfFile'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF dosyası seçilmedi!' });
    }
    
    const { sinav_id } = req.body;
    
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sınav ID eksik!' });
    }
    
    console.log('\n🔍 SINAV SONUCU ANALİZ EDİLİYOR:', req.file.originalname);
    console.log('📚 Sınav ID:', sinav_id);
    
    // PDF'i yükle
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`📊 Toplam sayfa: ${totalPages}`);
    
    // Sadece ilk sayfayı analiz et
    const singlePagePdf = await PDFDocument.create();
    const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [0]);
    singlePagePdf.addPage(copiedPage);
    const singlePageBytes = await singlePagePdf.save();
    
    // Geçici dosya oluştur
    const tempFileName = `temp_analyze_sinav_${Date.now()}.pdf`;
    const tempFilePath = path.join('uploads', tempFileName);
    fs.writeFileSync(tempFilePath, singlePageBytes);
    
    // Text çıkar - HİBRİT YÖNTEM
    const extractionResult = await extractTextHybrid(tempFilePath);
    const text = extractionResult.text;
    
    console.log(`📄 İlk sayfa text uzunluğu: ${text.length} (Yöntem: ${extractionResult.method})`);
    
    if (extractionResult.garbled) {
      console.log('⚠️ İlk sayfada encoding sorunu tespit edildi!');
      console.log('💡 Manuel giriş önerilir.');
    }
    
    // Potansiyel isim adaylarını bul (aynı mantık)
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const potansiyelIsimler = [];
    
    // 1. AKILLI FİLTRELEME: Sadece isim gibi görünenleri göster
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      const line = lines[i];
      
      // Temel kontroller
      const words = line.split(/\s+/);
      const wordCount = words.length;
      
      // 1. Kelime sayısı: 2-5 kelime (isim formatı)
      if (wordCount < 2 || wordCount > 5) continue;
      
      // 2. Uzunluk: 5-40 karakter (isim uzunluğu)
      if (line.length < 5 || line.length > 40) continue;
      
      // 3. Büyük harf kontrolü (rakam ve boşluk da olabilir)
      const isAllCaps = line.match(/^[A-ZÇĞİÖŞÜ\s\d]+$/);
      if (!isAllCaps) continue;
      
      // 4. BLACKLIST: Açık başlık kelimeleri
      const hasObviousTitle = line.match(/BELGESİ|SINAV|SONUÇ|SÜREÇ|FENOMEN|İZLEME|PUAN|OKUL|İLÇE|KARNES|YÜZDE|ORTALAMA|SIRA|DİLİM|DOĞRU|YANLIŞ|BOŞ|NET|DERS/);
      if (hasObviousTitle) continue;
      
      // 5. BLACKLIST: Tam okul/kurum isimleri
      const hasInstitution = line.match(/ORTAOKUL|LİSE|İLKOKUL|ANAOKUL|KOLEJİ|ANADOLU|İMAM|HATİP/);
      if (hasInstitution) continue;
      
      // GEÇERLI İSİM ADAYI!
      
      // Temizleme: Rakamla başlayan kısmı kes
      // "ENES AL34912B" → "ENES AL"
      let cleanLine = line;
      const cleanMatch = line.match(/^([A-ZÇĞİÖŞÜ\s]+?)(?=\d|$)/);
      if (cleanMatch && cleanMatch[1].trim().length >= 5) {
        cleanLine = cleanMatch[1].trim();
      }
      
      // Temizlenmiş isimdeki kelime sayısını kontrol et
      const cleanWords = cleanLine.split(/\s+/);
      const cleanWordCount = cleanWords.length;
      
      // Güven seviyesi hesapla
      let confidence = 'medium';
      
      // Sadece harf ve boşluk + 2-3 kelime = yüksek güven
      const onlyLetters = cleanLine.match(/^[A-ZÇĞİÖŞÜ\s]+$/);
      if (onlyLetters && (cleanWordCount === 2 || cleanWordCount === 3)) {
        confidence = 'high';
      }
      // 4-5 kelime = düşük güven
      else if (cleanWordCount > 3) {
        confidence = 'low';
      }
      
      potansiyelIsimler.push({
        text: cleanLine,
        lineNumber: i,
        confidence: confidence
      });
    }
    
    // Geçici dosyaları temizle
    fs.unlinkSync(tempFilePath);
    
    console.log(`✅ ${potansiyelIsimler.length} potansiyel isim bulundu`);
    potansiyelIsimler.forEach(p => console.log(`   - ${p.text} (satır ${p.lineNumber}, güven: ${p.confidence})`));
    
    res.json({
      success: true,
      data: {
        totalPages: totalPages,
        uploadPath: req.file.path,
        originalName: req.file.originalname,
        sinavId: sinav_id,
        potansiyelIsimler: potansiyelIsimler.slice(0, 15), // İlk 15 aday
        ornekText: text.substring(0, 500), // Kullanıcıya göster
        allLines: lines // Tüm satırları da gönder (frontend için)
      }
    });
    
  } catch (error) {
    console.error('Sonuç analiz hatası:', error);
    
    // Dosyayı temizle
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Analiz sırasında bir hata oluştu: ' + error.message 
    });
  }
});

// Kurum - Sonuç PDF Kaydet (Tüm sayfaları işle, eşleştir, kaydet)
app.post('/kurum/sinav-sonuc-yukle-kaydet', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath, selectedPattern, selectedLineNumber, manuelEslesmeler } = req.body;
    
    if (!sinav_id || !pdfPath) {
      return res.status(400).json({ success: false, error: 'Sınav ID veya PDF dosya yolu eksik!' });
    }
    
    if (!selectedPattern) {
      return res.status(400).json({ success: false, error: 'İsim pattern seçilmedi!' });
    }
    
    console.log('\n📚 SINAV SONUÇLARI KAYDEDILIYOR');
    console.log('✅ Sınav ID:', sinav_id);
    console.log('✅ Seçilen pattern:', selectedPattern);
    console.log('✅ Seçilen satır no:', selectedLineNumber);
    console.log('✅ PDF Path:', pdfPath);
    
    const results = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let savedCount = 0;
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'Sınav bulunamadı!' });
    }
    
    // Sonuç klasörünü oluştur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // PDF'i yükle
    if (!fs.existsSync(pdfPath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyası bulunamadı!' });
    }
    
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`📊 Toplam sayfa: ${totalPages}`);
    console.log(`📂 Sonuç klasörü: ${sonucKlasoru}`);
    
    // Manuel eşleşmeleri map'e çevir (sayfa numarası → öğrenci ID)
    const manuelMap = {};
    if (manuelEslesmeler && Array.isArray(manuelEslesmeler)) {
      manuelEslesmeler.forEach(m => {
        if (m.sayfaNo && m.ogrenciId) {
          manuelMap[m.sayfaNo] = m.ogrenciId;
        }
      });
      console.log(`📝 ${Object.keys(manuelMap).length} manuel eşleşme alındı`);
    }
    
    // Her sayfayı işle
    for (let i = 0; i < totalPages; i++) {
      try {
        const sayfaNo = i + 1;
        console.log(`\n📄 Sayfa ${sayfaNo}/${totalPages} işleniyor...`);
        
        // Bu sayfayı ayrı bir PDF olarak oluştur
        const singlePagePdf = await PDFDocument.create();
        const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
        singlePagePdf.addPage(copiedPage);
        const singlePageBytes = await singlePagePdf.save();
        
        // Geçici dosya adı oluştur
        const tempFileName = `temp_sinav_page_${sayfaNo}_${Date.now()}.pdf`;
        const tempFilePath = path.join('uploads', tempFileName);
        fs.writeFileSync(tempFilePath, singlePageBytes);
        
        // Bu sayfadan text çıkar
        const extractionResult = await extractTextHybrid(tempFilePath);
        const text = extractionResult.text;
        const isGarbled = extractionResult.garbled || false;
        
        // Text'ten isim çıkar (kullanıcının seçtiği satır numarasından)
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let extractedName = '';
        
        if (selectedLineNumber !== null && selectedLineNumber !== undefined) {
          extractedName = lines[selectedLineNumber] || '';
        } else {
          extractedName = selectedPattern;
        }
        
        // İsmi temizle (rakamları kes)
        const cleanMatch = extractedName.match(/^([A-ZÇĞİÖŞÜ\s]+?)(?=\d|$)/);
        if (cleanMatch && cleanMatch[1].trim().length >= 5) {
          extractedName = cleanMatch[1].trim();
        }
        
        console.log(`📝 Text'ten çıkarılan isim: "${extractedName}"`);
        
        // Manuel eşleşme var mı kontrol et
        let eslesmeSonuc = null;
        let ogrenciId = null;
        let ogrenciAdi = 'BİLİNMEYEN';
        
        if (manuelMap[sayfaNo]) {
          // Manuel eşleşme var
          ogrenciId = manuelMap[sayfaNo];
          const ogrenci = await dbGet('SELECT * FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          if (ogrenci) {
            ogrenciAdi = ogrenci.ogrenci_adi_soyadi;
            console.log(`✅ Manuel eşleşme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            eslesmeSonuc = ogrenci;
            matchedCount++;
          } else {
            console.log(`⚠️ Manuel eşleşme geçersiz! Öğrenci ID ${ogrenciId} bulunamadı.`);
            unmatchedCount++;
          }
        } else if (extractedName) {
          // Otomatik eşleştirme yap (sadece sınava katılanlarla)
          eslesmeSonuc = await sinavKatilimciEslestir(extractedName, sinav_id);
          
          if (eslesmeSonuc) {
            ogrenciId = eslesmeSonuc.id;
            ogrenciAdi = eslesmeSonuc.ogrenci_adi_soyadi;
            console.log(`✅ Otomatik eşleşme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            matchedCount++;
          } else {
            console.log(`❌ Eşleşme bulunamadı`);
            unmatchedCount++;
          }
        } else {
          console.log(`⚠️ İsim çıkarılamadı (encoding sorunu olabilir)`);
          unmatchedCount++;
        }
        
        // PDF'i kaydet
        const sanitizedName = ogrenciAdi.replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ\s]/g, '').replace(/\s+/g, '_');
        const finalFileName = ogrenciId 
          ? `${sayfaNo}_${sanitizedName}_${ogrenciId}.pdf`
          : `${sayfaNo}_BILINMEYEN_${sanitizedName}.pdf`;
        
        const finalFilePath = path.join(sonucKlasoru, finalFileName);
        fs.writeFileSync(finalFilePath, singlePageBytes);
        
        console.log(`💾 PDF kaydedildi: ${finalFileName}`);
        
        // Veritabanına kaydet (eğer eşleşme varsa)
        if (ogrenciId) {
          try {
            // sinav_katilimcilari tablosunu güncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi' 
              WHERE sinav_id = ? AND ogrenci_id = ?
            `, [finalFilePath, sinav_id, ogrenciId]);
            
            savedCount++;
            console.log(`✅ Veritabanına kaydedildi`);
          } catch (dbError) {
            console.error(`❌ Veritabanı kayıt hatası:`, dbError);
          }
        }
        
        // Sonuç listesine ekle
        results.push({
          sayfaNo: sayfaNo,
          ogrenciId: ogrenciId,
          ogrenciAdi: ogrenciAdi,
          pdfYolu: finalFilePath,
          eslesti: !!ogrenciId,
          extractedName: extractedName,
          isGarbled: isGarbled
        });
        
        // Geçici dosyayı temizle
        fs.unlinkSync(tempFilePath);
        
      } catch (pageError) {
        console.error(`❌ Sayfa ${i + 1} işlenirken hata:`, pageError);
        results.push({
          sayfaNo: i + 1,
          ogrenciId: null,
          ogrenciAdi: 'HATA',
          pdfYolu: null,
          eslesti: false,
          error: pageError.message
        });
        unmatchedCount++;
      }
    }
    
    // Sınavı güncelle (sonuc_yuklendi = 1)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    // Yüklenen PDF dosyasını temizle
    try {
      fs.unlinkSync(pdfPath);
    } catch (cleanError) {
      console.error('⚠️ Geçici PDF temizlenemedi:', cleanError);
    }
    
    console.log('\n✅ İŞLEM TAMAMLANDI!');
    console.log(`   Toplam sayfa: ${totalPages}`);
    console.log(`   Eşleşen: ${matchedCount}`);
    console.log(`   Eşleşmeyen: ${unmatchedCount}`);
    console.log(`   Kaydedilen: ${savedCount}`);
    
    res.json({
      success: true,
      message: `${totalPages} sayfa işlendi. ${matchedCount} eşleşme, ${unmatchedCount} eşleşmedi.`,
      data: {
        totalPages: totalPages,
        matchedCount: matchedCount,
        unmatchedCount: unmatchedCount,
        savedCount: savedCount,
        results: results
      }
    });
    
  } catch (error) {
    console.error('❌ Sonuç kaydetme hatası:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Kaydetme sırasında bir hata oluştu: ' + error.message 
    });
  }
});

// Kurum - Manuel Sınav Sonuç Eşleştirme
app.post('/kurum/sinav-manuel-eslestir/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    const { eslesmeler } = req.body;
    
    if (!eslesmeler || eslesmeler.length === 0) {
      return res.json({ success: false, message: 'Eşleştirme bilgisi eksik!' });
    }
    
    console.log(`\n🔗 MANUEL EŞLEŞTIRME (Sınav ID: ${sinavId})`);
    console.log(`   ${eslesmeler.length} adet eşleştirme yapılacak`);
    
    let basarili = 0;
    let hatali = 0;
    
    for (const eslesme of eslesmeler) {
      try {
        const { sayfaNo, pdfYolu, ogrenciId, kaynak } = eslesme;
        
        console.log(`   📄 Sayfa ${sayfaNo}:`);
        console.log(`      - Öğrenci ID: ${ogrenciId}`);
        console.log(`      - Kaynak: ${kaynak}`);
        console.log(`      - PDF Yolu: ${pdfYolu}`);
        console.log(`      - Dosya var mı: ${pdfYolu ? fs.existsSync(pdfYolu) : 'PDF yolu boş'}`);
        
        // PDF dosyasını yeni isimle kaydet
        if (pdfYolu && fs.existsSync(pdfYolu)) {
          // Öğrenci bilgilerini al
          let ogrenci;
          if (kaynak === 'veli') {
            ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenciId]);
          } else {
            ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          }
          
          if (ogrenci) {
            // Yeni dosya adı oluştur
            const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
            if (!fs.existsSync(sonucKlasoru)) {
              fs.mkdirSync(sonucKlasoru, { recursive: true });
            }
            
            const timestamp = Date.now();
            const safeIsim = ogrenci.ad_soyad.replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ\s]/g, '').replace(/\s+/g, '_');
            const yeniDosyaAdi = `${safeIsim}_${timestamp}.pdf`;
            const yeniDosyaYolu = path.join(sonucKlasoru, yeniDosyaAdi);
            
            // Dosyayı kopyala
            fs.copyFileSync(pdfYolu, yeniDosyaYolu);
            
            // sinav_katilimcilari tablosunu güncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi'
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [yeniDosyaYolu, sinavId, ogrenciId, kaynak]);
            
            console.log(`   ✅ Başarılı: ${ogrenci.ad_soyad}`);
            basarili++;
          } else {
            console.log(`   ❌ Öğrenci bulunamadı: ${ogrenciId}`);
            hatali++;
          }
        } else {
          console.log(`   ❌ PDF dosyası bulunamadı: ${pdfYolu}`);
          hatali++;
        }
      } catch (error) {
        console.error(`   ❌ Eşleştirme hatası:`, error);
        hatali++;
      }
    }
    
    // Sınavın sonuc_yuklendi durumunu güncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinavId]);
    
    console.log(`\n📊 MANUEL EŞLEŞTIRME TAMAMLANDI:`);
    console.log(`   ✅ Başarılı: ${basarili}`);
    console.log(`   ❌ Hatalı: ${hatali}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} öğrenci eşleştirildi! ${hatali > 0 ? `(${hatali} hata)` : ''}`
    });
  } catch (error) {
    console.error('❌ Manuel eşleştirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Sınav Sonuç WhatsApp Bildirim Gönder
app.post('/kurum/sinav-sonuc-whatsapp-gonder/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'Sınav bulunamadı!' });
    }
    
    // Sonucu yüklenmiş katılımcıları al (hem kurum hem veli öğrencileri)
    const kurumKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        ok.ogrenci_adi_soyadi as ogrenci_adi,
        ok.veli_adi,
        ok.veli_telefon,
        ok.telefon as ogrenci_telefon,
        'kurum' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ? AND sk.sonuc_durumu IN ('yuklendi', 'bildirildi') AND sk.pdf_path IS NOT NULL
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        o.ad_soyad as ogrenci_adi,
        u.ad_soyad as veli_adi,
        u.telefon as veli_telefon,
        o.telefon as ogrenci_telefon,
        'veli' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE sk.sinav_id = ? AND sk.sonuc_durumu IN ('yuklendi', 'bildirildi') AND sk.pdf_path IS NOT NULL
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    if (katilimcilar.length === 0) {
      return res.json({ success: false, message: 'Sonucu yüklenmiş öğrenci bulunamadı!' });
    }
    
    console.log(`\n📱 WHATSAPP BİLDİRİMLERİ GÖNDERİLİYOR`);
    console.log(`   Sınav: ${sinav.ad}`);
    console.log(`   Toplam katılımcı: ${katilimcilar.length}\n`);
    
    let basarili = 0;
    let basarisiz = 0;
    
    // Her öğrenci için veli telefonuna bildirim gönder
    for (const katilimci of katilimcilar) {
      // Veli telefonu öncelikli, yoksa öğrenci telefonu
      const telefon = katilimci.veli_telefon || katilimci.ogrenci_telefon;
      
      console.log(`   📞 ${katilimci.ogrenci_adi} (Veli: ${katilimci.veli_adi || 'Bilinmiyor'}) → ${telefon || 'TELEFON YOK'}`);
      
      if (!telefon) {
        console.log(`   ⚠️ ${katilimci.ogrenci_adi} - Telefon numarası yok!`);
        basarisiz++;
        continue;
      }
      
      // WhatsApp mesajını oluştur
      const mesaj = `🎓 Sınav Sonucu Açıklandı

Sayın ${katilimci.veli_adi || 'Veli'},

${katilimci.ogrenci_adi} öğrencinizin sınav sonucu açıklanmıştır.

📚 Sınav: ${sinav.ad}
📅 Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

📥 Sonucu görüntülemek için sisteme giriş yapın:
👉 ${req.protocol}://${req.get('host')}/login

─────────────────
🏫 Sınav Merkezi`;
      
      // WhatsApp gönder
      const result = await whatsappBildirimGonder(
        telefon,
        mesaj,
        'sinav_sonuc'
      );
      
      if (result.success) {
        console.log(`   ✅ ${katilimci.ogrenci_adi} - ${telefon}`);
        basarili++;
        
        // Bildirim durumunu güncelle
        await dbRun(
          'UPDATE sinav_katilimcilari SET sonuc_durumu = ?, whatsapp_gonderim_tarihi = datetime("now") WHERE id = ?',
          ['bildirildi', katilimci.id]
        );
      } else {
        console.log(`   ❌ ${katilimci.ogrenci_adi} - ${telefon} - ${result.message}`);
        basarisiz++;
      }
      
      // API rate limit için küçük gecikme
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\n✅ Bildirim gönderimi tamamlandı!`);
    console.log(`   Başarılı: ${basarili}`);
    console.log(`   Başarısız: ${basarisiz}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} bildirim gönderildi, ${basarisiz} başarısız.`,
      basarili: basarili,
      basarisiz: basarisiz
    });
    
  } catch (error) {
    console.error('WhatsApp bildirim hatası:', error);
    res.json({ success: false, message: 'Bildirim gönderilirken bir hata oluştu!' });
  }
});

// Veli - Sınav Sonuçları
app.get('/veli/sinav-sonuclari', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    // Velinin öğrencilerini al
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    
    if (!ogrenciler || ogrenciler.length === 0) {
      return res.render('veli/sinav-sonuclari', {
        user: { username: req.session.username, type: req.session.userType },
        sonuclar: [],
        ogrenciler: [],
        error: 'Henüz öğrenci kaydınız bulunmuyor.',
        success: req.session.success
      });
    }
    
    console.log(`\n📋 SINAV SONUÇLARI (Veli ID: ${req.session.userId})`);
    console.log(`   ${ogrenciler.length} öğrenci bulundu`);
    
    // Veli'nin kendi eklediği öğrencilerin sonuçları (ogrenciler tablosu)
    const veliSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.sinav_id,
        sk.ogrenci_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        'veli' as kaynak,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        s.sinav_durumu,
        o.ad_soyad as ogrenci_adi_soyadi,
        o.sinif as ogrenci_sinif
      FROM sinav_katilimcilari sk
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id
      WHERE sk.ogrenci_kaynak = 'veli'
        AND o.veli_id = ?
        AND s.sinav_durumu = 'Sonuç açıklandı'
        AND sk.pdf_path IS NOT NULL
    `, [req.session.userId]);
    
    console.log(`   ✅ Veli ekledi: ${veliSonuclari.length} sonuç`);
    
    // Kurum tarafından eklenen öğrencilerin sonuçları (ogrenci_kayitlari tablosu)
    const kurumSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.sinav_id,
        sk.ogrenci_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        'kurum' as kaynak,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        s.sinav_durumu,
        ok.ogrenci_adi_soyadi,
        ok.sinif as ogrenci_sinif
      FROM sinav_katilimcilari sk
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id
      WHERE sk.ogrenci_kaynak = 'kurum'
        AND ok.veli_telefon = (SELECT telefon FROM users WHERE id = ?)
        AND s.sinav_durumu = 'Sonuç açıklandı'
        AND sk.pdf_path IS NOT NULL
    `, [req.session.userId]);
    
    console.log(`   ✅ Kurum ekledi: ${kurumSonuclari.length} sonuç`);
    
    // İki kaynağı birleştir
    const sonuclar = [...veliSonuclari, ...kurumSonuclari].sort((a, b) => {
      return new Date(b.sinav_tarihi) - new Date(a.sinav_tarihi);
    });
    
    console.log(`   📊 Toplam: ${sonuclar.length} sonuç`);
    
    res.render('veli/sinav-sonuclari', {
      user: { username: req.session.username, type: req.session.userType },
      sonuclar: sonuclar,
      ogrenciler: ogrenciler,
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sınav sonuçları hatası:', error);
    req.session.error = 'Sınav sonuçları yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sınav Sonuç PDF İndir
app.get('/veli/sinav-sonuc-indir/:katilimciId', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const katilimciId = req.params.katilimciId;
    
    // Önce ogrenci_kaynak'a bak
    const katilimciBilgi = await dbGet('SELECT ogrenci_kaynak, ogrenci_id, pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    if (!katilimciBilgi) {
      return res.status(404).send('Sonuç bulunamadı!');
    }
    
    let yetkiVar = false;
    
    // Kaynak'a göre yetki kontrolü
    if (katilimciBilgi.ogrenci_kaynak === 'veli') {
      // Veli'nin kendi eklediği öğrenci
      const ogrenci = await dbGet('SELECT veli_id FROM ogrenciler WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && ogrenci.veli_id === req.session.userId;
    } else {
      // Kurum ekledi, veli telefonuyla kontrol
      const user = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      const ogrenci = await dbGet('SELECT veli_telefon FROM ogrenci_kayitlari WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && user && user.telefon === ogrenci.veli_telefon;
    }
    
    if (!yetkiVar) {
      return res.status(403).send('Bu sonuca erişim yetkiniz yok!');
    }
    
    // PDF var mı kontrol et
    if (!katilimciBilgi.pdf_path || !fs.existsSync(katilimciBilgi.pdf_path)) {
      return res.status(404).send('PDF dosyası bulunamadı!');
    }
    
    // PDF indirme kaydını güncelle
    const simdi = new Date().toISOString();
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET 
        pdf_goruldu = 1,
        pdf_gorunme_tarihi = ?,
        pdf_indirilme_sayisi = COALESCE(pdf_indirilme_sayisi, 0) + 1
      WHERE id = ?
    `, [simdi, katilimciId]);
    
    console.log(`\n📥 PDF İNDİRME KAYDI`);
    console.log(`   Katılımcı ID: ${katilimciId}`);
    console.log(`   Tarih: ${simdi}`);
    console.log(`   Veli ID: ${req.session.userId}`);
    
    // PDF'i indir
    res.download(katilimciBilgi.pdf_path, path.basename(katilimciBilgi.pdf_path), (err) => {
      if (err) {
        console.error('PDF indirme hatası:', err);
        res.status(500).send('PDF indirilemedi!');
      }
    });
    
  } catch (error) {
    console.error('PDF indirme hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Veli Profil
app.get('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Talep edilen sınavları getir
    const talepEdilenSinavlar = await dbAll(`
      SELECT 
        s.*,
        st.durum,
        st.talep_tarihi,
        st.yanitlanma_tarihi,
        st.yanit,
        COUNT(DISTINCT o.id) as ogrenci_sayisi
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      LEFT JOIN ogrenciler o ON o.veli_id = ?
      WHERE st.veli_id = ?
      GROUP BY s.id, st.id
      ORDER BY st.talep_tarihi DESC
    `, [req.session.userId, req.session.userId]);
    
    // Login hatalarını filtrele - sadece profil ile ilgili hataları göster
    let error = req.session.error;
    if (error && (error.includes('Kullanıcı adı veya şifre') || error.includes('şifre hatalı'))) {
      error = null; // Login hatalarını gösterme
    }
    
    res.render('veli_profil', {
      user: { username: req.session.username, type: req.session.userType },
      kullanici: kullanici,
      talepEdilenSinavlar: talepEdilenSinavlar,
      error: error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Profil hatası:', error);
    req.session.error = 'Profil yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli Profil Güncelleme
app.post('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, telefon, current_password, new_password } = req.body;
    
    if (!ad_soyad) {
      req.session.error = 'Ad Soyad alanı zorunludur';
      res.redirect('/veli/profil');
      return;
    }
    
    // Şifre değiştirme kontrolü
    if (new_password && new_password.trim() !== '') {
      if (!current_password || current_password.trim() === '') {
        req.session.error = 'Şifre değiştirmek için mevcut şifrenizi girmelisiniz!';
        res.redirect('/veli/profil');
        return;
      }
      
      if (new_password.length < 6) {
        req.session.error = 'Yeni şifre en az 6 karakter olmalıdır!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Mevcut şifreyi kontrol et
      const kullanici = await dbGet('SELECT password_hash FROM users WHERE id = ?', [req.session.userId]);
      const sifreDogruMu = await bcrypt.compare(current_password, kullanici.password_hash);
      
      if (!sifreDogruMu) {
        req.session.error = 'Mevcut şifreniz yanlış!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Yeni şifreyi hashle
      const yeniSifreHash = await bcrypt.hash(new_password, 10);
      
      // Profil ve şifreyi güncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ?, password_hash = ? WHERE id = ?',
        [ad_soyad, telefon, yeniSifreHash, req.session.userId]
      );
      
      console.log(`✅ Veli şifre değiştirdi: User ID ${req.session.userId}`);
      req.session.success = 'Profil bilgileriniz ve şifreniz başarıyla güncellendi!';
    } else {
      // Sadece profil bilgilerini güncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ? WHERE id = ?',
        [ad_soyad, telefon, req.session.userId]
      );
      
      req.session.success = 'Profil bilgileriniz başarıyla güncellendi!';
    }
    
    res.redirect('/veli/profil');
  } catch (error) {
    console.error('Profil güncelleme hatası:', error);
    req.session.error = 'Profil güncellenirken bir hata oluştu!';
    res.redirect('/veli/profil');
  }
});

// Veli - Öğrenci Ekle (GET)
app.get('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    res.render('veli_ogrenci_ekle', {
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Öğrenci ekle sayfası hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Öğrenci Ekle (POST)
app.post('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    
    console.log('Öğrenci ekleme isteği:', { ad_soyad, tc_no, telefon, okul, sinif, veli_id: req.session.userId });
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Öğrenci adı soyadı, okul ve sınıf zorunludur!';
      res.redirect('/veli/ogrenci-ekle');
      return;
    }
    
    // Öğrenci numarası oluştur
    const ogrenciNo = await generateOgrenciNo();
    
    // Öğrenci ekle
    const result = await dbRun(
      'INSERT INTO ogrenciler (ad_soyad, tc_no, telefon, okul, sinif, veli_id, ogrenci_no) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ad_soyad, tc_no, telefon, okul, sinif, req.session.userId, ogrenciNo]
    );
    
    console.log('Öğrenci eklendi! ID:', result.lastID, 'Öğrenci No:', ogrenciNo);
    
    req.session.success = `${ad_soyad} başarıyla eklendi! Öğrenci No: ${ogrenciNo}`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Öğrenci ekleme hatası:', error);
    req.session.error = 'Öğrenci eklenirken bir hata oluştu: ' + error.message;
    res.redirect('/veli/ogrenci-ekle');
  }
});

// Veli - Öğrenci Düzenle (GET)
app.get('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [req.params.id, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Bu öğrenciye yetki verilmiş rehber öğretmenleri getir
    const rehberOgretmenler = await dbAll(`
      SELECT t.id as talep_id, t.created_at, u.id as ogretmen_id, u.ad_soyad, u.kurum, u.brans, u.telefon
      FROM ogrenci_talepleri t
      INNER JOIN users u ON t.rehber_ogretmen_id = u.id
      WHERE t.ogrenci_id = ? AND t.durum = 'onaylandi'
      ORDER BY t.created_at DESC
    `, [req.params.id]);
    
    res.render('veli_ogrenci_duzenle', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenci: ogrenci,
      rehberOgretmenler: rehberOgretmenler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Öğrenci düzenle sayfası hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Öğrenci Düzenle (POST)
app.post('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    const ogrenciId = req.params.id;
    
    // Öğrencinin bu veliye ait olduğunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait değil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Öğrenci adı soyadı, okul ve sınıf zorunludur!';
      res.redirect(`/veli/ogrenci-duzenle/${ogrenciId}`);
      return;
    }
    
    // Öğrenci güncelle
    await dbRun(
      'UPDATE ogrenciler SET ad_soyad = ?, tc_no = ?, telefon = ?, okul = ?, sinif = ? WHERE id = ? AND veli_id = ?',
      [ad_soyad, tc_no, telefon, okul, sinif, ogrenciId, req.session.userId]
    );
    
    req.session.success = `${ad_soyad} başarıyla güncellendi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Öğrenci güncelleme hatası:', error);
    req.session.error = 'Öğrenci güncellenirken bir hata oluştu!';
    res.redirect(`/veli/ogrenci-duzenle/${req.params.id}`);
  }
});

// Veli - Rehber Öğretmen Yetkisini Kaldır
app.post('/veli/rehber-yetki-kaldir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    console.log('🗑️  Yetki kaldırma isteği:', { talepId, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduğunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    console.log('📋 Talep bulundu:', talep);
    
    if (!talep || talep.veli_id !== req.session.userId) {
      console.log('❌ Yetki kontrolü başarısız');
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Talebi sil (yetkiyi kaldır)
    await dbRun('DELETE FROM ogrenci_talepleri WHERE id = ?', [talepId]);
    console.log('✅ Yetki başarıyla kaldırıldı');
    
    res.json({ success: true, message: 'Rehber öğretmen yetkisi kaldırıldı!' });
  } catch (error) {
    console.error('❌ Yetki kaldırma hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Veli - Öğrenci Sil
app.post('/veli/ogrenci-sil/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.id;
    
    // Öğrencinin bu veliye ait olduğunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait değil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Öğrenciyi sil
    await dbRun('DELETE FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    req.session.success = `${ogrenci.ad_soyad} başarıyla silindi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Öğrenci silme hatası:', error);
    req.session.error = 'Öğrenci silinirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Tüm Sınav Takvimi (Tüm Öğrenciler)
app.get('/veli/tum-sinav-takvimi', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    // Velinin tüm öğrencilerini getir
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    
    // Her öğrenci için sınav takvimini getir (yeni sistem)
    let tumTakvim = [];
    try {
      tumTakvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          o.ad_soyad as ogrenci_ad_soyad,
          o.ogrenci_no,
          o.id as ogrenci_id,
          sk.sonuc_durumu,
          sk.pdf_path
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
        WHERE o.veli_id = ? 
        ORDER BY s.tarih ASC
      `, [req.session.userId]);
      
      console.log(`\n📅 Veli Sınav Takvimi (User ID: ${req.session.userId}):`);
      console.log(`   Toplam ${tumTakvim.length} sınav bulundu`);
      if (tumTakvim.length > 0) {
        tumTakvim.forEach(t => {
          console.log(`   - ${t.sinav_adi} | ${t.ogrenci_ad_soyad} | ${t.tarih}`);
        });
      }
    } catch (error) {
      console.log('❌ Sınav takvimi sorgusu hatası:', error);
      tumTakvim = [];
    }
    
    res.render('veli_tum_sinav_takvimi', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenciler: ogrenciler,
      tumTakvim: tumTakvim,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('❌ Sınav takvimi sayfası hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sınav Takvimi (Tek Öğrenci)
app.get('/veli/sinav-takvimi/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.ogrenci_id;
    
    // Öğrencinin bu veliye ait olduğunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait değil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Sınav takvimini getir (yeni sistem)
    let takvim = [];
    try {
      takvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          sk.sonuc_durumu,
          sk.pdf_path
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        WHERE sk.ogrenci_id = ? AND sk.ogrenci_kaynak = 'veli'
        ORDER BY s.tarih ASC
      `, [ogrenciId]);
      
      console.log(`\n📅 Öğrenci Sınav Takvimi (Öğrenci ID: ${ogrenciId}):`);
      console.log(`   Toplam ${takvim.length} sınav bulundu`);
    } catch (error) {
      console.log('❌ Sınav takvimi sorgusu hatası:', error);
      takvim = [];
    }
    
    res.render('veli_sinav_takvimi', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenci: ogrenci,
      takvim: takvim,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('❌ Sınav takvimi sayfası hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Bekleyen Talepler
app.get('/veli/talepler', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepler = await dbAll(`
      SELECT 
        t.*, 
        u.ad_soyad as rehber_adi, 
        u.kurum,
        o.ad_soyad as ogrenci_adi,
        o.ogrenci_no,
        o.okul,
        o.sinif
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.rehber_ogretmen_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      WHERE t.veli_id = ? AND t.durum = 'beklemede'
      ORDER BY t.created_at DESC
    `, [req.session.userId]);
    
    res.render('veli_talepler', {
      user: { username: req.session.username, type: req.session.userType },
      talepler: talepler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talepler hatası:', error);
    req.session.error = 'Talepler yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Talep Onayla/Reddet
app.post('/veli/talep/:id/:islem', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { id, islem } = req.params;
    
    const talep = await dbGet('SELECT * FROM ogrenci_talepleri WHERE id = ? AND veli_id = ?', [id, req.session.userId]);
    
    if (!talep) {
      req.session.error = 'Talep bulunamadı!';
      res.redirect('/veli/talepler');
      return;
    }
    
    if (islem === 'onayla') {
      // Talebi onayla - İlişki ogrenci_talepleri tablosunda durum='onaylandi' ile saklanır
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['onaylandi', id]);
      
      // Öğrenci bilgisini al
      const ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [talep.ogrenci_id]);
      
      // Rehber öğretmen bilgisini al
      const rehber = await dbGet('SELECT ad_soyad, brans FROM users WHERE id = ?', [talep.rehber_ogretmen_id]);
      
      req.session.success = `${ogrenci.ad_soyad} için ${rehber.ad_soyad} (${rehber.brans}) rehber öğretmen talebi onaylandı!`;
    } else if (islem === 'reddet') {
      // Talebi reddet
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['reddedildi', id]);
      
      req.session.success = 'Talep reddedildi!';
    }
    
    res.redirect('/veli/talepler');
  } catch (error) {
    console.error('Talep işleme hatası:', error);
    req.session.error = 'Talep işlenirken bir hata oluştu!';
    res.redirect('/veli/talepler');
  }
});

// Veli Dashboard
app.get('/veli/dashboard', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log('===========================================');
    console.log('📊 DASHBOARD YÜKLEME');
    console.log('Session User ID:', req.session.userId);
    console.log('Session Username:', req.session.username);
    console.log('Session UserType:', req.session.userType);
    console.log('===========================================');
    
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    
    console.log(`✅ ${ogrenciler.length} öğrenci bulundu:`, ogrenciler);
    
    // Tüm öğrencileri de kontrol et
    const tumOgrenciler = await dbAll('SELECT id, ad_soyad, veli_id FROM ogrenciler');
    console.log('📋 Veritabanındaki TÜM öğrenciler:', tumOgrenciler);
    
    // Her öğrenci için istatistikleri al
    for (let ogrenci of ogrenciler) {
      const pdfCount = await dbGet(
        'SELECT COUNT(*) as sayi FROM sinav_sonuclari_pdf WHERE ogrenci_id = ?',
        [ogrenci.id]
      );
      ogrenci.pdf_sonuc_sayisi = pdfCount ? pdfCount.sayi : 0;
      
      const excelCount = await dbGet(
        'SELECT COUNT(DISTINCT sinav_id) as sayi FROM sinav_sonuclari WHERE ogrenci_id = ?',
        [ogrenci.id]
      );
      ogrenci.excel_sonuc_sayisi = excelCount ? excelCount.sayi : 0;
    }
    
    // Bekleyen talep sayısını al
    const bekleyenTalepler = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE veli_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    // Yaklaşan sınavlar (sınav takvimi henüz kullanılmıyor, boş liste gönder)
    let yaklasanSinavlar = [];
    try {
      yaklasanSinavlar = await dbAll(`
        SELECT * FROM sinav_takvimi 
        WHERE tarih >= date('now') 
        ORDER BY tarih ASC 
        LIMIT 5
      `);
    } catch (sinavErr) {
      console.log('⚠️ Sınav takvimi sorgulanamadı (henüz kullanılmıyor)');
      yaklasanSinavlar = [];
    }
    
    console.log('🎉 Dashboard render ediliyor!');
    res.render('veli_dashboard', { 
      user: { username: req.session.username, type: req.session.userType },
      ogrenciler: ogrenciler,
      bekleyenTalepSayisi: bekleyenTalepler ? bekleyenTalepler.sayi : 0,
      yaklasanSinavlar: yaklasanSinavlar
    });
  } catch (error) {
    console.error('❌ Dashboard HATA:', error);
    // Hata durumunda boş listelerle render et (redirect döngüsünü önlemek için)
    res.render('veli_dashboard', { 
      user: { username: req.session.username, type: req.session.userType },
      ogrenciler: [],
      bekleyenTalepSayisi: 0,
      yaklasanSinavlar: []
    });
  }
});

// Rehber Dashboard
app.get('/rehber/dashboard', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY tarih DESC');
    
    // İstatistikler - ONAYLANMIŞ ÖĞRENCİLER
    const ogrenciSayisi = await dbGet(
      'SELECT COUNT(DISTINCT ogrenci_id) as sayi FROM ogrenci_talepleri WHERE rehber_ogretmen_id = ? AND durum = ?',
      [req.session.userId, 'onaylandi']
    );
    const veliSayisi = await dbGet(`
      SELECT COUNT(DISTINCT o.veli_id) as sayi 
      FROM ogrenciler o
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? AND t.durum = ?
    `, [req.session.userId, 'onaylandi']);
    
    // Sınav sonuçları sayısı (onaylı öğrencilerin PDF sonuçları)
    const sinavSonucSayisi = await dbGet(`
      SELECT COUNT(DISTINCT sk.id) as sayi 
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_talepleri t ON sk.ogrenci_id = t.ogrenci_id AND sk.ogrenci_kaynak = 'veli'
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
    `, [req.session.userId]);
    
    // Bekleyen talepler sayısı
    const bekleyenTalepSayisi = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE rehber_ogretmen_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    res.render('rehber_dashboard', { 
      user: { username: req.session.username },
      sinavlar: sinavlar,
      istatistikler: {
        ogrenci: ogrenciSayisi?.sayi || 0,
        veli: veliSayisi?.sayi || 0,
        sinavSonucSayisi: sinavSonucSayisi?.sayi || 0,
        bekleyenTalep: bekleyenTalepSayisi?.sayi || 0
      }
    });
  } catch (error) {
    console.error('Dashboard hatası:', error);
    // Sonsuz döngüyü önlemek için boş veri ile render et
    res.render('rehber_dashboard', { 
      user: { username: req.session.username },
      sinavlar: [],
      istatistikler: {
        ogrenci: 0,
        veli: 0,
        sinavSonucSayisi: 0,
        bekleyenTalep: 0
      }
    });
  }
});

// Sınav Yükleme
// Rehber - Sınav Yükleme Route'ları KALDIRILDI (Sadece kurum yapabilir)

// Rehber Öğretmen - Sınav Sonuçları
app.get('/rehber/sinav-sonuclari', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Onaylı öğrencilerin sınav sonuçlarını getir
    // Veli öğrencileri
    const veliSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.ogrenci_id,
        sk.sinav_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        o.ad_soyad as ogrenci_ad_soyad,
        o.sinif as ogrenci_sinif,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif as sinav_sinif,
        'veli' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
      ORDER BY s.tarih DESC, o.ad_soyad ASC
    `, [req.session.userId]);
    
    // Kurum öğrencileri için (ogrenci_kaynak = 'kurum' olanlar)
    // Not: Kurum öğrencileri için ogrenci_id NULL olabilir, bu durumda ad_soyad ile eşleştirme yapılmalı
    // Şimdilik sadece veli öğrencilerini gösteriyoruz
    // TODO: Kurum öğrencileri için sinav_katilimcilari tablosuna ogrenci_ad_soyad kolonu eklenebilir
    
    const sonuclar = veliSonuclari;
    
    res.render('rehber/sinav-sonuclari', {
      sonuclar: sonuclar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sınav sonuçları hatası:', error);
    req.session.error = 'Sınav sonuçları yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Öğrenci Listesi
app.get('/rehber/ogrenciler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // VELİ ÖĞRENCİLERİ (ogrenciler tablosundan)
    const veliOgrencileri = await dbAll(`
      SELECT 
        o.*,
        u.username as veli_username,
        u.email as veli_email,
        u.ad_soyad as veli_ad_soyad,
        u.telefon as veli_telefon,
        (SELECT COUNT(*) FROM sinav_sonuclari_pdf WHERE ogrenci_id = o.id) as pdf_sonuc_sayisi,
        (SELECT COUNT(*) FROM sinav_sonuclari WHERE ogrenci_id = o.id) as excel_sonuc_sayisi,
        'veli' as kaynak
      FROM ogrenciler o
      LEFT JOIN users u ON o.veli_id = u.id
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? AND t.durum = 'onaylandi'
      ORDER BY o.ad_soyad ASC
    `, [req.session.userId]);
    
    // KURUM ÖĞRENCİLERİ (ogrenci_kayitlari tablosundan - ogrenci_id NULL olanlar)
    const kurumTalepleri = await dbAll(`
      SELECT DISTINCT
        t.ad_soyad,
        t.veli_id,
        t.sinif,
        t.okul
      FROM ogrenci_talepleri t
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi' 
        AND t.ogrenci_id IS NULL
    `, [req.session.userId]);
    
    const kurumOgrencileri = [];
    for (const talep of kurumTalepleri) {
      // Veli bilgisini al
      const veli = talep.veli_id ? await dbGet('SELECT ad_soyad, telefon, email, username FROM users WHERE id = ?', [talep.veli_id]) : null;
      
      kurumOgrencileri.push({
        id: null,
        ad_soyad: talep.ad_soyad,
        tc_no: null,
        sinif: talep.sinif,
        okul: talep.okul || '',
        telefon: null,
        ogrenci_no: '',
        veli_id: talep.veli_id,
        veli_ad_soyad: veli?.ad_soyad || null,
        veli_telefon: veli?.telefon || null,
        veli_username: veli?.username || null,
        veli_email: veli?.email || null,
        pdf_sonuc_sayisi: 0,
        excel_sonuc_sayisi: 0,
        kaynak: 'kurum'
      });
    }
    
    // Birleştir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    res.render('ogrenci_listesi', { 
      user: { username: req.session.username },
      ogrenciler: ogrenciler
    });
  } catch (error) {
    console.error('Öğrenci listesi hatası:', error);
    req.session.error = 'Öğrenci listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Öğrenci Detay/Profil
app.get('/rehber/ogrenci/:ogrenci_id', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci bilgileri - VELİ TARAFINDAN ONAYLANMIŞ MI KONTROL ET
    const onay = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenciId, req.session.userId, 'onaylandi']
    );
    
    if (!onay) {
      req.session.error = 'Öğrenci bulunamadı veya size ait değil!';
      return res.redirect('/rehber/ogrenciler');
    }
    
    const ogrenci = await dbGet(`
      SELECT 
        o.*,
        u.username as veli_username,
        u.email as veli_email
      FROM ogrenciler o
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE o.id = ?
    `, [ogrenciId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı!';
      return res.redirect('/rehber/ogrenciler');
    }
    
    // PDF sınav sonuçları
    const pdfSonuclari = await dbAll(`
      SELECT * FROM sinav_sonuclari_pdf
      WHERE ogrenci_id = ?
      ORDER BY sinav_tarihi DESC, created_at DESC
    `, [ogrenciId]);
    
    // Excel/CSV sınav sonuçları
    const excelSonuclari = await dbAll(`
      SELECT 
        ss.*,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY s.tarih DESC
    `, [ogrenciId]);
    
    res.render('ogrenci_detay', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      pdf_sonuclari: pdfSonuclari,
      excel_sonuclari: excelSonuclari
    });
  } catch (error) {
    console.error('Öğrenci detay hatası:', error);
    req.session.error = 'Öğrenci bilgileri yüklenirken bir hata oluştu!';
    res.redirect('/rehber/ogrenciler');
  }
});

// Rehber Öğretmen Profili
app.get('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Başka sayfalardan gelen hataları filtrele - sadece profil ile ilgili hataları göster
    let error = req.session.error;
    if (error && (
      error.includes('Kullanıcı adı veya şifre') || 
      error.includes('şifre hatalı') ||
      error.includes('Veli listesi yüklenirken') ||
      error.includes('Öğrenci listesi yüklenirken') ||
      error.includes('Sınav sonuçları yüklenirken')
    )) {
      error = null; // Başka sayfalardan gelen hataları gösterme
    }
    
    res.render('rehber_profil', {
      user: { username: req.session.username },
      kullanici: kullanici,
      error: error,
      success: req.session.success
    });
    
    // Session'daki error ve success'i temizle
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Profil hatası:', error);
    req.session.error = 'Profil yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Profil Güncelleme
app.post('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { ad_soyad, kurum, telefon, brans, mezuniyet } = req.body;
    
    // Zorunlu alanları kontrol et
    if (!ad_soyad || !kurum || !telefon || !brans) {
      req.session.error = 'Lütfen tüm zorunlu alanları doldurun (Ad Soyad, Kurum, Telefon, Branş)';
      res.redirect('/rehber/profil');
      return;
    }
    
    await dbRun(
      'UPDATE users SET ad_soyad = ?, kurum = ?, telefon = ?, brans = ?, mezuniyet = ? WHERE id = ?',
      [ad_soyad, kurum, telefon, brans, mezuniyet, req.session.userId]
    );
    
    req.session.success = 'Profil bilgileriniz başarıyla güncellendi!';
    res.redirect('/rehber/profil');
  } catch (error) {
    console.error('Profil güncelleme hatası:', error);
    req.session.error = 'Profil güncellenirken bir hata oluştu!';
    res.redirect('/rehber/profil');
  }
});

// Veli İletişim Listesi
app.get('/rehber/veliler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Sadece onaylanmış öğrencilerin velilerini göster
    // Önce veli ID'lerini al
    const veliIds = await dbAll(`
      SELECT DISTINCT t.veli_id
      FROM ogrenci_talepleri t
      WHERE t.rehber_ogretmen_id = ?
        AND t.durum = 'onaylandi'
        AND t.veli_id IS NOT NULL
    `, [req.session.userId]);
    
    if (veliIds.length === 0) {
      return res.render('veli_listesi', {
        user: { username: req.session.username },
        veliler: []
      });
    }
    
    // Her veli için bilgileri ve öğrenci sayısını al
    const veliler = [];
    for (const veliIdRow of veliIds) {
      const veliId = veliIdRow.veli_id;
      
      // Veli bilgilerini al
      const veli = await dbGet('SELECT id, username, ad_soyad, email, telefon, created_at FROM users WHERE id = ? AND user_type = ?', [veliId, 'veli']);
      
      if (!veli) continue;
      
      // Öğrenci sayısını al
      const ogrenciSayisi = await dbGet(`
        SELECT COUNT(DISTINCT CASE WHEN t.ogrenci_id IS NOT NULL THEN t.ogrenci_id ELSE NULL END) as sayi
        FROM ogrenci_talepleri t
        WHERE t.veli_id = ?
          AND t.rehber_ogretmen_id = ?
          AND t.durum = 'onaylandi'
      `, [veliId, req.session.userId]);
      
      // Öğrenci isimlerini al
      const ogrenciIsimleri = await dbAll(`
        SELECT DISTINCT CASE 
          WHEN t.ogrenci_id IS NOT NULL THEN o.ad_soyad 
          ELSE t.ad_soyad 
        END as isim
        FROM ogrenci_talepleri t
        LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
        WHERE t.veli_id = ?
          AND t.rehber_ogretmen_id = ?
          AND t.durum = 'onaylandi'
      `, [veliId, req.session.userId]);
      
      // Geçersiz email ve telefon formatlarını filtrele
      let email = veli.email;
      if (email && (email.includes('@temp.com') || email.includes('.0@') || email.match(/^\d+\.0@/))) {
        email = null; // Geçersiz email'leri gösterme
      }
      
      let telefon = veli.telefon;
      if (telefon && (telefon.toString().endsWith('.0') || telefon.toString().includes('.0@'))) {
        telefon = null; // Geçersiz telefon formatlarını gösterme
      }
      
      veliler.push({
        id: veli.id,
        username: veli.username,
        ad_soyad: veli.ad_soyad,
        email: email,
        telefon: telefon,
        created_at: veli.created_at,
        ogrenci_sayisi: ogrenciSayisi?.sayi || 0,
        ogrenci_isimleri: ogrenciIsimleri.map(o => o.isim).filter(Boolean).join(', ')
      });
    }
    
    // Ad soyad'a göre sırala
    veliler.sort((a, b) => {
      const aAd = (a.ad_soyad || a.username || '').toLowerCase();
      const bAd = (b.ad_soyad || b.username || '').toLowerCase();
      return aAd.localeCompare(bAd);
    });
    
    res.render('veli_listesi', {
      user: { username: req.session.username },
      veliler: veliler || []
    });
  } catch (error) {
    console.error('Veli listesi hatası:', error);
    req.session.error = 'Veli listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber Öğretmen - Gelen Talepler
app.get('/rehber/talepler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const talepler = await dbAll(`
      SELECT 
        t.*,
        u.ad_soyad as veli_ad_soyad,
        u.telefon as veli_telefon,
        u.email as veli_email,
        o.ad_soyad as ogrenci_ad_soyad,
        o.sinif as ogrenci_sinif,
        o.okul as ogrenci_okul
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ?
      ORDER BY 
        CASE t.durum
          WHEN 'beklemede' THEN 1
          WHEN 'onaylandi' THEN 2
          WHEN 'reddedildi' THEN 3
        END,
        t.created_at DESC
    `, [req.session.userId]);
    
    res.render('rehber/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Rehber talep listesi hatası:', error);
    req.session.error = 'Talep listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber Öğretmen - Talep Yanıtla (Onayla/Reddet)
app.post('/rehber/talep-yanitla', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { talep_id, durum, yanit } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'Geçersiz parametreler!' });
    }
    
    // Talebin bu rehber öğretmene ait olduğunu kontrol et
    const talep = await dbGet(`
      SELECT t.*, u.telefon as veli_telefon, u.ad_soyad as veli_ad_soyad
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      WHERE t.id = ? AND t.rehber_ogretmen_id = ?
    `, [talep_id, req.session.userId]);
    
    if (!talep) {
      return res.json({ success: false, message: 'Talep bulunamadı veya size ait değil!' });
    }
    
    // Talebi güncelle
    await dbRun(`
      UPDATE ogrenci_talepleri 
      SET durum = ?, mesaj = ?
      WHERE id = ? AND rehber_ogretmen_id = ?
    `, [durum, yanit || '', talep_id, req.session.userId]);
    
    // WhatsApp bildirimi gönder (arka planda)
    if (talep.veli_telefon) {
      const mesaj = durum === 'onaylandi' 
        ? `✅ TALEBİNİZ ONAYLANDI!\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
          `Rehber öğretmen talebinizi onayladı.\n\n` +
          `👤 Öğrenci: ${talep.ad_soyad}\n` +
          (yanit ? `💬 Rehber Öğretmen Yanıtı: ${yanit}\n\n` : '') +
          `Artık rehber öğretmen öğrenciniz hakkında bilgilere erişebilecektir.`
        : `❌ TALEBİNİZ REDDEDİLDİ\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'Değerli Velimiz'},\n\n` +
          `Rehber öğretmen talebinizi reddetti.\n\n` +
          `👤 Öğrenci: ${talep.ad_soyad}\n` +
          (yanit ? `💬 Rehber Öğretmen Yanıtı: ${yanit}\n\n` : '') +
          `Daha fazla bilgi için lütfen rehber öğretmen ile iletişime geçiniz.`;
      
      whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
        .then(result => console.log('✅ Veli WhatsApp bildirimi gönderildi:', result))
        .catch(error => console.error('❌ Veli WhatsApp bildirimi hatası:', error));
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep başarıyla onaylandı!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Rehber talep yanıtlama hatası:', error);
    res.json({ success: false, message: 'Talep işlenirken bir hata oluştu!' });
  }
});

// Öğrenci Ekleme - KALDIRILDI (Rehber öğretmen artık direkt öğrenci ekleyemez, sadece talep gönderebilir)
// app.get('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Öğrenci Arama API - KALDIRILDI (Öğrenci ekleme özelliği kaldırıldı)
// app.post('/rehber/ogrenci-ara', ...) - KALDIRILDI

// Öğrenci Ekleme Talebi Gönder (Rehber -> Veli) - YENİ SİSTEM
app.post('/rehber/ogrenci-talep', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    console.log('\n📨 TALEP GÖNDERME İSTEĞİ:', {
      userId: req.session.userId,
      ogrenci_id: req.body.ogrenci_id
    });
    
    // Profil kontrolü
    const kullanici = await dbGet('SELECT ad_soyad, kurum, telefon, brans FROM users WHERE id = ?', [req.session.userId]);
    console.log('👤 Kullanıcı Profili:', kullanici);
    
    if (!kullanici.ad_soyad || !kullanici.kurum || !kullanici.telefon || !kullanici.brans) {
      console.log('❌ Profil eksik!');
      return res.json({ success: false, message: 'Önce profil bilgilerinizi eksiksiz doldurmalısınız!' });
    }
    
    const { ogrenci_id } = req.body;
    
    if (!ogrenci_id) {
      console.log('❌ Öğrenci ID eksik!');
      return res.json({ success: false, message: 'Öğrenci ID eksik' });
    }
    
    // Öğrenciyi bul
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    console.log('👨‍🎓 Öğrenci:', ogrenci);
    
    if (!ogrenci) {
      console.log('❌ Öğrenci bulunamadı!');
      return res.json({ success: false, message: 'Öğrenci bulunamadı' });
    }
    
    // Zaten onaylanmış mı?
    const onayliTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'onaylandi']
    );
    console.log('✅ Onaylı talep kontrolü:', onayliTalep);
    
    if (onayliTalep) {
      console.log('❌ Zaten kayıtlı!');
      return res.json({ success: false, message: 'Bu öğrenci zaten size kayıtlı' });
    }
    
    // Bekleyen talep var mı kontrol et
    const bekleyenTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'beklemede']
    );
    console.log('⏳ Bekleyen talep kontrolü:', bekleyenTalep);
    
    if (bekleyenTalep) {
      console.log('❌ Zaten bekleyen talep var!');
      return res.json({ success: false, message: 'Bu öğrenci için zaten bekleyen bir talebiniz var' });
    }
    
    // Talep oluştur (Veli onaylayacak) - Başka branşta atanmış olsa bile talep gönderilebilir
    console.log('💾 Talep oluşturuluyor:', {
      ogrenci_id,
      ogrenci_no: ogrenci.ogrenci_no,
      ad_soyad: ogrenci.ad_soyad,
      veli_id: ogrenci.veli_id,
      rehber_ogretmen_id: req.session.userId
    });
    
    await dbRun(
      'INSERT INTO ogrenci_talepleri (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ogrenci_id, ogrenci.ogrenci_no, ogrenci.ad_soyad, ogrenci.sinif, ogrenci.okul, ogrenci.veli_id, req.session.userId, req.session.userId, 'beklemede']
    );
    
    console.log('✅ Talep başarıyla oluşturuldu!\n');
    
    res.json({ 
      success: true, 
      message: `${ogrenci.ad_soyad} için talep veliye gönderildi! Veli onayladığında bu öğrenciyi görebilirsiniz.`
    });
  } catch (error) {
    console.error('❌ Talep gönderme hatası:', error);
    res.json({ success: false, message: `Talep hatası: ${error.message}` });
  }
});

// Öğrenci Ekleme POST - KALDIRILDI (Rehber öğretmen artık direkt öğrenci ekleyemez, sadece talep gönderebilir)
// app.post('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Sınav Sonuçları (Excel/CSV)
app.get('/veli/sinav-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci kontrolü
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu öğrencinin sonuçlarına erişim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // Sınav sonuçlarını çek
    const sonuclar = await dbAll(`
      SELECT ss.*, s.ad as sinav_adi, s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY ss.created_at DESC
    `, [ogrenciId]);
    
    // Sonuçları sınav bazında grupla ve JSON parse et
    const sinavSonuclari = {};
    sonuclar.forEach(sonuc => {
      if (!sinavSonuclari[sonuc.sinav_id]) {
        sinavSonuclari[sonuc.sinav_id] = {
          sinav: {
            id: sonuc.sinav_id,
            ad: sonuc.sinav_adi,
            tarih: sonuc.sinav_tarihi
          },
          sonuclar: []
        };
      }
      // JSON parse - backend'de yap
      let sonucVerisiParsed = {};
      if (sonuc.sonuc_verisi) {
        try {
          sonucVerisiParsed = JSON.parse(sonuc.sonuc_verisi);
        } catch(e) {
          sonucVerisiParsed = {};
        }
      }
      sinavSonuclari[sonuc.sinav_id].sonuclar.push({
        ...sonuc,
        sonuc_verisi_parsed: sonucVerisiParsed
      });
    });
    
    res.render('sinav_sonuclari', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      sinav_sonuclari: sinavSonuclari
    });
  } catch (error) {
    console.error('Sonuç görüntüleme hatası:', error);
    req.session.error = 'Bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// PDF Sınav Sonuçları
app.get('/veli/pdf-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci kontrolü
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu öğrencinin sonuçlarına erişim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // PDF sınav sonuçlarını çek
    const pdfSonuclari = await dbAll(`
      SELECT * FROM sinav_sonuclari_pdf
      WHERE ogrenci_id = ?
      ORDER BY sinav_tarihi DESC, created_at DESC
    `, [ogrenciId]);
    
    res.render('pdf-sonuclari', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      pdf_sonuclari: pdfSonuclari
    });
  } catch (error) {
    console.error('PDF sonuç görüntüleme hatası:', error);
    req.session.error = 'Bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Sınav Takvimi Sayfası
app.get('/sinav-takvimi', async (req, res) => {
  try {
    // Tüm sınavları getir (hem tekil hem paket sınavları)
    const sinavlar = await dbAll(
      `SELECT 
        s.*,
        sp.ad as paket_adi,
        ps.paket_id
       FROM sinavlar s
       LEFT JOIN paket_sinavlari ps ON s.id = ps.sinav_id
       LEFT JOIN sinav_paketleri sp ON ps.paket_id = sp.id AND sp.aktif = 1
       ORDER BY s.tarih ASC`,
      []
    );
    
    console.log(`\n📅 SINAV TAKVİMİ YÜKLEME`);
    console.log(`   Toplam Sınav: ${sinavlar.length}`);
    console.log(`   Paket Sınavları: ${sinavlar.filter(s => s.paket_id).length}`);
    console.log(`   Tekil Sınavlar: ${sinavlar.filter(s => !s.paket_id).length}`);
    
    res.render('sinav-takvimi', {
      title: 'Sınav Takvimi',
      user: req.session.userId ? { 
        username: req.session.username,
        type: req.session.userType 
      } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Sınav takvimi hatası:', error);
    res.status(500).send('Bir hata oluştu: ' + error.message);
  }
});

// ESKİ Sınav Paketleri Route - KALDIRILDI (Yeni route satır 729'da)

// ============ DUYURU YÖNETİMİ (KURUM) ============

// Kurum - Duyuru Yönetimi Sayfası
app.get('/kurum/duyurular', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const duyurular = await dbAll('SELECT * FROM duyurular ORDER BY sira ASC, tarih DESC');
    
    res.render('kurum/duyurular', {
      duyurular: duyurular,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Duyuru yönetimi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Duyuru Ekle (POST)
app.post('/kurum/duyuru-ekle', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'Başlık zorunludur!' });
    }
    
    await dbRun(
      'INSERT INTO duyurular (baslik, icerik, tarih, sira, aktif) VALUES (?, ?, ?, ?, ?)',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0]
    );
    
    console.log(`\n✅ YENİ DUYURU EKLENDİ`);
    console.log(`   Başlık: ${baslik}`);
    
    req.session.success = 'Duyuru başarıyla eklendi!';
    res.json({ success: true, message: 'Duyuru başarıyla eklendi!' });
  } catch (error) {
    console.error('Duyuru ekleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Duyuru Güncelle (POST)
app.post('/kurum/duyuru-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const duyuruId = req.params.id;
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'Başlık zorunludur!' });
    }
    
    await dbRun(
      'UPDATE duyurular SET baslik = ?, icerik = ?, tarih = ?, sira = ?, aktif = ? WHERE id = ?',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0, duyuruId]
    );
    
    console.log(`\n✅ DUYURU GÜNCELLENDİ`);
    console.log(`   ID: ${duyuruId}`);
    console.log(`   Başlık: ${baslik}`);
    
    req.session.success = 'Duyuru başarıyla güncellendi!';
    res.json({ success: true, message: 'Duyuru başarıyla güncellendi!' });
  } catch (error) {
    console.error('Duyuru güncelleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Duyuru Sil (POST)
app.post('/kurum/duyuru-sil/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const duyuruId = req.params.id;
    
    await dbRun('DELETE FROM duyurular WHERE id = ?', [duyuruId]);
    
    console.log(`\n❌ DUYURU SİLİNDİ`);
    console.log(`   ID: ${duyuruId}`);
    
    req.session.success = 'Duyuru başarıyla silindi!';
    res.json({ success: true, message: 'Duyuru başarıyla silindi!' });
  } catch (error) {
    console.error('Duyuru silme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Duyurular Route (Genel - Herkes görebilir)
app.get('/duyurular', async (req, res) => {
  try {
    const duyurular = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    res.render('duyurular', {
      title: 'Duyurular',
      user: req.session.userId ? { type: req.session.userType } : null,
      duyurular: duyurular
    });
  } catch (error) {
    console.error('Duyurular hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ============ KURUMSAL SAYFALAR YÖNETİMİ ============

// API - Kurumsal Sayfalar Listesi (Auth gerektirmiyor - dashboard zaten korumalı)
app.get('/api/kurumsal-sayfalar', async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    res.json({ success: true, sayfalar: sayfalar });
  } catch (error) {
    console.error('API kurumsal sayfalar hatası:', error);
    res.status(500).json({ success: false, message: 'Sayfalar yüklenemedi!', error: error.message });
  }
});

// Kurum - Kurumsal Sayfalar Yönetimi
app.get('/kurum/kurumsal-sayfalar', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    
    res.render('kurum/kurumsal-sayfalar', {
      sayfalar: sayfalar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Kurumsal sayfalar yönetimi hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Kurumsal Sayfa Güncelle
app.post('/kurum/kurumsal-sayfa-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const sayfaId = req.params.id;
    const { sayfa_adi, baslik, icerik, seo_baslik, seo_aciklama, sira, aktif } = req.body;
    
    if (!sayfa_adi || !baslik) {
      return res.json({ success: false, message: 'Sayfa adı ve başlık zorunludur!' });
    }
    
    await dbRun(
      `UPDATE kurumsal_sayfalar 
       SET sayfa_adi = ?, baslik = ?, icerik = ?, seo_baslik = ?, seo_aciklama = ?, 
           sira = ?, aktif = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [sayfa_adi, baslik, icerik || '', seo_baslik || '', seo_aciklama || '', sira || 0, aktif ? 1 : 0, sayfaId]
    );
    
    console.log(`\n✅ KURUMSAL SAYFA GÜNCELLENDİ`);
    console.log(`   ID: ${sayfaId}`);
    console.log(`   Sayfa: ${sayfa_adi}`);
    
    res.json({ success: true, message: 'Sayfa başarıyla güncellendi!' });
  } catch (error) {
    console.error('Kurumsal sayfa güncelleme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Genel - Kurumsal Sayfalar (Frontend - Dinamik)
app.get('/hakkimizda', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['hakkimizda']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadı!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Hakkımızda hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

app.get('/iletisim', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['iletisim']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadı!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('İletişim hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

app.get('/sinav-merkezleri', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['sinav-merkezleri']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadı!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Sınav merkezleri hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// PDF Test Route (Geliştirme/Test için)
app.get('/test-pdf', (req, res) => {
  res.render('test-pdf', {
    title: 'PDF Test - Sınav Sonucu Parse',
    user: req.session.userId ? { type: req.session.userType } : null
  });
});

// Test PDF Upload Route
app.post('/test-pdf-upload', pdfUpload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Lütfen bir PDF dosyası yükleyin!' });
    }

    // PDF'i oku
    const dataBuffer = fs.readFileSync(req.file.path);
    
    // PDF'i parse et
    const pdfData = await pdfParse(dataBuffer);
    
    // Text içeriğini al
    const text = pdfData.text;
    
    // Öğrenci bilgilerini çıkar (regex ile)
    const ogrenciMatch = text.match(/Öğrenci\s+Numara\s+Sınıf\s+([^\n]+)\s+(\d+)\s+(\w+)/);
    const puanMatch = text.match(/▼\s*([\d,]+)/);
    
    // Ders detaylarını çıkar
    const dersler = [];
    const dersRegex = /(Türkçe|Tarih-1|Coğrafya-1|Felsefe|Din Kül\. ve Ahl\. Bil\.|Fizik|Kimya|Biyoloji|TYT Fen)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+)/g;
    let dersMatch;
    
    while ((dersMatch = dersRegex.exec(text)) !== null) {
      dersler.push({
        ders: dersMatch[1],
        soru: dersMatch[2],
        dogru: dersMatch[3],
        yanlis: dersMatch[4],
        net: dersMatch[5]
      });
    }
    
    const result = {
      filename: req.file.originalname,
      filepath: req.file.path,
      pageCount: pdfData.numpages,
      ogrenciBilgi: ogrenciMatch ? {
        ad: ogrenciMatch[1].trim(),
        numara: ogrenciMatch[2],
        sinif: ogrenciMatch[3]
      } : null,
      puan: puanMatch ? puanMatch[1] : null,
      dersler: dersler,
      rawText: text.substring(0, 2000) // İlk 2000 karakter
    };
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('PDF parse hatası:', error);
    res.status(500).json({ 
      success: false, 
      error: 'PDF parse edilirken hata oluştu: ' + error.message 
    });
  }
});

// Cevap Anahtarları Route
app.get('/cevap-anahtarlari', async (req, res) => {
  try {
    // Cevap anahtarı yüklenmiş TÜM sınavları al
    const sinavlar = await dbAll(
      `SELECT * FROM sinavlar 
       WHERE cevap_anahtari_pdf IS NOT NULL 
       AND cevap_anahtari_pdf != '' 
       ORDER BY tarih DESC`,
      []
    );
    
    res.render('cevap-anahtarlari', {
      title: 'Cevap Anahtarları',
      user: req.session.userId ? { type: req.session.userType, username: req.session.username } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Cevap anahtarları hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Rehber - Toplu Sınav Yükleme KALDIRILDI (Sadece kurum yapabilir)

// Gelişmiş öğrenci isim eşleştirme fonksiyonu
function eslesmeSkoru(isim1, isim2) {
  if (!isim1 || !isim2) return 0;
  
  // İsimleri normalize et
  const normalize = (str) => {
    return str
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c');
  };
  
  const n1 = normalize(isim1);
  const n2 = normalize(isim2);
  
  // Tam eşleşme
  if (n1 === n2) return 100;
  
  // Kelime kelime karşılaştır
  const kelimeler1 = n1.split(' ');
  const kelimeler2 = n2.split(' ');
  
  let eslesenKelimeSayisi = 0;
  kelimeler1.forEach(k1 => {
    if (kelimeler2.some(k2 => k2 === k1)) {
      eslesenKelimeSayisi++;
    }
  });
  
  // Skor hesapla
  const maxKelimeSayisi = Math.max(kelimeler1.length, kelimeler2.length);
  const skor = (eslesenKelimeSayisi / maxKelimeSayisi) * 100;
  
  // Levenshtein mesafesi ile ince ayar (basit yaklaşım)
  if (skor > 50) {
    const uzunlukFarki = Math.abs(n1.length - n2.length);
    return Math.max(0, skor - uzunlukFarki * 2);
  }
  
  return skor;
}

// Sınav katılımcıları için özel eşleştirme fonksiyonu
async function sinavKatilimciEslestir(pdfOgrenciAdi, sinavId) {
  if (!pdfOgrenciAdi || !sinavId) return null;
  
  // Sadece bu sınava katılan öğrencileri çek
  const katilimcilar = await dbAll(`
    SELECT ok.* 
    FROM ogrenci_kayitlari ok
    INNER JOIN sinav_katilimcilari sk ON ok.id = sk.ogrenci_id
    WHERE sk.sinav_id = ?
  `, [sinavId]);
  
  if (!katilimcilar || katilimcilar.length === 0) return null;
  
  let enIyiEslesme = null;
  let enIyiSkor = 0;
  
  // İsim varyasyonları oluştur (Ad Soyad / Soyad Ad)
  const nameVariations = [pdfOgrenciAdi];
  const parts = pdfOgrenciAdi.trim().split(/\s+/);
  
  if (parts.length === 2) {
    // "BEREN ÖZCAN" → ["BEREN ÖZCAN", "ÖZCAN BEREN"]
    nameVariations.push(`${parts[1]} ${parts[0]}`);
  } else if (parts.length === 3) {
    // "AHMED N AR" → ["AHMED N AR", "AR AHMED N", "N AR AHMED"]
    nameVariations.push(`${parts[2]} ${parts[0]} ${parts[1]}`);
    nameVariations.push(`${parts[1]} ${parts[2]} ${parts[0]}`);
  }
  
  console.log(`🔍 "${pdfOgrenciAdi}" için eşleştirme yapılıyor...`);
  console.log(`   İsim varyasyonları:`, nameVariations);
  
  // Her katılımcı için skor hesapla
  for (const katilimci of katilimcilar) {
    const dbName = (katilimci.ogrenci_adi_soyadi || '').trim().toUpperCase();
    
    for (const variation of nameVariations) {
      const variationUpper = variation.toUpperCase();
      let skor = 0;
      
      // 1. Tam eşleşme (100 puan)
      if (dbName === variationUpper) {
        skor = 100;
      }
      // 2. Başlangıç eşleşmesi (80 puan)
      else if (dbName.startsWith(variationUpper) || variationUpper.startsWith(dbName)) {
        skor = 80;
      }
      // 3. İçerik eşleşmesi (60 puan)
      else if (dbName.includes(variationUpper) || variationUpper.includes(dbName)) {
        skor = 60;
      }
      // 4. Kelime bazlı eşleşme (40 puan)
      else {
        const dbWords = dbName.split(/\s+/);
        const pdfWords = variationUpper.split(/\s+/);
        const matchingWords = dbWords.filter(w => pdfWords.includes(w));
        if (matchingWords.length > 0) {
          skor = 40 + (matchingWords.length * 10);
        }
      }
      
      if (skor > enIyiSkor) {
        enIyiSkor = skor;
        enIyiEslesme = katilimci;
        console.log(`   → Yeni en iyi eşleşme: "${dbName}" (Skor: ${skor})`);
      }
    }
  }
  
  // Minimum %55 eşleşme gerekli
  if (enIyiSkor >= 55) {
    console.log(`✅ En iyi eşleşme (${enIyiSkor} puan): "${enIyiEslesme.ogrenci_adi_soyadi}"`);
    return enIyiEslesme;
  } else {
    console.log(`❌ Yeterli eşleşme bulunamadı (en yüksek: ${enIyiSkor})`);
    return null;
  }
}

async function enIyiOgrenciEslestir(pdfOgrenciAdi) {
  if (!pdfOgrenciAdi) return null;
  
  const tumOgrenciler = await dbAll('SELECT * FROM ogrenciler');
  
  let enIyiEslesme = null;
  let enYuksekSkor = 0;
  
  tumOgrenciler.forEach(ogrenci => {
    const skor = eslesmeSkoru(pdfOgrenciAdi, ogrenci.ad_soyad);
    if (skor > enYuksekSkor && skor >= 60) { // Minimum %60 eşleşme gerekli
      enYuksekSkor = skor;
      enIyiEslesme = ogrenci;
    }
  });
  
  return enIyiEslesme;
}

// YENİ: İlk Sayfa Analizi - Potansiyel İsim Adayları
// Rehber - Toplu Sınav Analiz KALDIRILDI (Sadece kurum yapabilir)

// Rehber - Toplu Sınav Yükleme KALDIRILDI (Sadece kurum yapabilir)

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`🚀 Sunucu çalışıyor: http://localhost:${PORT}`);
  console.log(`📁 Veritabanı: sinav_merkezi.db`);
});

// Graceful shutdown
// Rehber - Manuel Eşleştirme KALDIRILDI (Sadece kurum yapabilir)

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('Veritabanı kapatma hatası:', err);
    } else {
      console.log('✅ Veritabanı bağlantısı kapatıldı');
    }
    process.exit(0);
  });
});
