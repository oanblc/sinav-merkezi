const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
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
// RAILWAY PROXY CONFIGURATION
// ============================================
// Railway Metal Edge proxy kullanıyor, Express'e güvenmesini söyle
app.set('trust proxy', 1);

// ============================================
// RATE LIMITING - DDoS KORUMASI
// ============================================

// Genel rate limit (tüm istekler için)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 1000, // IP başına maksimum 1000 istek
  message: 'Çok fazla istek gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Login rate limit (brute force koruması)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 5, // IP başına maksimum 5 deneme
  message: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.',
  skipSuccessfulRequests: true,
});

// File upload rate limit
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 50, // IP başına maksimum 50 upload
  message: 'Çok fazla dosya yükleme isteği. Lütfen 1 saat sonra tekrar deneyin.',
});

app.use(generalLimiter);

// ============================================
// INPUT VALIDATION & SANITIZATION
// ============================================

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/<script[^>]*>.*?<\/script>/gi, '').replace(/<[^>]+>/g, '');
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function validatePhone(phone) {
  const re = /^[0-9]{10,11}$/;
  return re.test(String(phone).replace(/\D/g, ''));
}

function validateRequired(fields, data) {
  const missing = [];
  for (const field of fields) {
    if (!data[field] || String(data[field]).trim() === '') {
      missing.push(field);
    }
  }
  return missing.length > 0 ? missing : null;
}

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
// AKILLI EŞLEŞTİRME SİSTEMİ - YARDIMCI FONKSİYONLAR
// ============================================

/**
 * İsim gibi görünüyor mu kontrol et
 */
function looksLikeName(line) {
  // Önce ismi rakamlardan ayır (örn: "ALİ OSMAN ÇÖZELİ08-A" → "ALİ OSMAN ÇÖZELİ")
  const cleanedLine = line.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  const words = cleanedLine.split(/\s+/);
  const wordCount = words.length;
  
  // Kelime sayısı kontrolü (daha esnek)
  if (wordCount < 2 || wordCount > 6) return false;
  
  // Uzunluk kontrolü (daha esnek)
  if (cleanedLine.length < 5 || cleanedLine.length > 60) return false;
  
  // Türkçe harfler kontrolü
  if (!cleanedLine.match(/^[A-ZÇĞİÖŞÜa-zçğıöşü\s]+$/)) return false;
  
  // Blacklist: Başlık kelimeleri (daha kapsamlı)
  if (cleanedLine.match(/BELGESİ|SINAV|SONUÇ|PUAN|OKUL|DERS|NET|DOĞRU|YANLIŞ|BOŞ|SIRA|ORTALAMA|İLÇE|KURUM|LİSE|ORTAOKUL|DENEME|NUMARA|GENEL|DERECE|KATILIM|BAŞARI|ANALİZ|CEVAP|SORU/i)) return false;
  
  // En az bir boşluk olmalı (ad-soyad)
  if (!cleanedLine.includes(' ')) return false;
  
  return true;
}

/**
 * İsmi temizle (rakamları ve özel karakterleri kaldır)
 */
function cleanExtractedName(name) {
  if (!name) return '';
  
  // 1. Önce sondaki rakam-harf kombinasyonlarını temizle (08-A, 123, vs)
  let clean = name.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  // 2. Tüm rakamları temizle
  clean = clean.replace(/\d+/g, '');
  
  // 3. Özel karakterleri temizle (Türkçe harfler hariç)
  clean = clean.replace(/[^\wÇĞİÖŞÜçğıöşü\s]/g, '');
  
  // 4. Başındaki/sonundaki gereksiz kelimeleri temizle
  clean = clean.replace(/^(Öğrenci|ÖĞRENCİ|Ogrenci|OGRENCI|Ad|AD|Adı|ADI|Soyad|SOYAD|Soyadı|SOYADI)\s*/gi, '');
  clean = clean.replace(/\s*(Numara|NUMARA|Sınıf|SINIF|Sınıfı|SINIFI)$/gi, '');
  
  // 5. Fazla boşlukları temizle
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // 6. Büyük harfe çevir
  clean = clean.toUpperCase();
  
  // 7. Çok kısa veya çok uzunsa geçersiz
  if (clean.length < 5 || clean.length > 50) return '';
  
  return clean;
}

/**
 * Levenshtein Distance hesapla
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

/**
 * String benzerliği hesapla (0-1 arası, 1 = tam eşleşme)
 */
function stringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const s1 = str1.toUpperCase().trim();
  const s2 = str2.toUpperCase().trim();
  
  if (s1 === s2) return 1.0;
  
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * En iyi eşleşmeyi bul
 */
function findBestMatch(extractedName, katilimcilar) {
  if (!extractedName || !katilimcilar || katilimcilar.length === 0) {
    return null;
  }
  
  let bestMatch = null;
  let bestSimilarity = 0;
  
  for (const katilimci of katilimcilar) {
    if (!katilimci.ad_soyad) continue;
    
    const similarity = stringSimilarity(extractedName, katilimci.ad_soyad);
    
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = katilimci;
    }
  }
  
  return bestMatch && bestSimilarity >= 0.65 ? { ogrenci: bestMatch, similarity: bestSimilarity } : null;
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
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
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
  
  // Veli ilk giriş kontrolü için password_changed kolonu
  db.run(`ALTER TABLE users ADD COLUMN password_changed INTEGER DEFAULT 0`, (err) => {
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
      sonuclar_aciklandi INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Mevcut sinavlar tablosuna yeni kolonları ekle (eğer yoksa)
  db.run(`ALTER TABLE sinavlar ADD COLUMN durum TEXT DEFAULT 'taslak'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ durum kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuclar_aciklandi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('⚠️ sonuclar_aciklandi kolonu zaten var veya hata:', err.message);
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
  
  // Kurumsal İçerik Yönetimi Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS kurumsal_icerik (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sayfa_adi TEXT NOT NULL UNIQUE,
      baslik TEXT NOT NULL,
      alt_baslik TEXT,
      icerik TEXT,
      meta_description TEXT,
      meta_keywords TEXT,
      aktif INTEGER DEFAULT 1,
      sira INTEGER DEFAULT 0,
      guncelleme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      olusturulma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Varsayılan kurumsal içerikleri ekle (eğer yoksa)
  db.get(`SELECT COUNT(*) as count FROM kurumsal_icerik`, (err, row) => {
    if (!err && row.count === 0) {
      const defaultPages = [
        {
          sayfa_adi: 'hakkimizda',
          baslik: 'Türkiye\'nin Simülasyon Sınav Merkezi',
          alt_baslik: '30 yıllık eğitim tecrübesiyle, gerçek sınav ortamında öğrencilerimizi geleceğe hazırlıyoruz.',
          icerik: 'Sınav Merkezi, Türkiye\'nin önde gelen simülasyon sınav organizasyonlarından biridir. 1995 yılından bu yana öğrencilerimize gerçek sınav deneyimi yaşatarak, onları en iyi şekilde geleceğe hazırlamaktayız.',
          meta_description: 'Türkiye\'nin önde gelen simülasyon sınav merkezi. 30 yıllık tecrübe ile LGS, YKS ve tüm sınavlar için profesyonel deneme sınavları.',
          meta_keywords: 'sınav merkezi, deneme sınavı, LGS, YKS, simülasyon sınavı',
          aktif: 1,
          sira: 1
        },
        {
          sayfa_adi: 'iletisim',
          baslik: 'İletişim',
          alt_baslik: 'Bizimle iletişime geçin',
          icerik: 'Sorularınız ve talepleriniz için bizimle iletişime geçebilirsiniz.',
          meta_description: 'Sınav Merkezi iletişim bilgileri',
          meta_keywords: 'iletişim, telefon, e-posta, adres',
          aktif: 1,
          sira: 2
        }
      ];
      
      defaultPages.forEach(page => {
        db.run(`
          INSERT INTO kurumsal_icerik (sayfa_adi, baslik, alt_baslik, icerik, meta_description, meta_keywords, aktif, sira)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [page.sayfa_adi, page.baslik, page.alt_baslik, page.icerik, page.meta_description, page.meta_keywords, page.aktif, page.sira]);
      });
      
      console.log('✅ Varsayılan kurumsal içerikler oluşturuldu');
    }
  });
  
  console.log('✅ Kurumsal İçerik Yönetimi tablosu oluşturuldu');
  
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
  
  // ============================================
  // AKILLI ÖĞRENME SİSTEMİ TABLOLARI
  // ============================================
  
  // PDF Pattern Öğrenme Tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS pdf_learning_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kurum_id INTEGER,
      sinav_tipi TEXT,
      name_line_number INTEGER,
      name_position_type TEXT,
      avg_font_size REAL,
      x_coordinate REAL,
      y_coordinate REAL,
      success_rate REAL DEFAULT 1.0,
      use_count INTEGER DEFAULT 1,
      last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Başarısız Eşleştirmeler Tablosu (Öğrenme için)
  db.run(`
    CREATE TABLE IF NOT EXISTS matching_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_id INTEGER,
      attempted_name TEXT,
      correct_name TEXT,
      failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // PDF Yapısı Hafızası
  db.run(`
    CREATE TABLE IF NOT EXISTS pdf_structure_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kurum_id INTEGER,
      file_hash TEXT,
      name_extraction_method TEXT,
      name_pattern TEXT,
      success_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  console.log('✅ Akıllı Öğrenme Sistemi tabloları hazır');
  
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
  
  // Varsayılan site ayarlarını ekle
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adi', 'Sınav Merkezi')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adres', 'Ankara, Türkiye')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_telefon', '+90 (312) 123 45 67')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_email', 'info@sinavmerkezi.com')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_aciklama', '30 yıllık eğitim tecrübesiyle öğrencilerimizi geleceğe hazırlıyoruz.')`);

  
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
    ('hakkimizda', 'Hakkımızda', 'Sınav Merkezi Hakkında', 
    '<div class="row mb-5">
      <div class="col-lg-6">
        <h3 class="mb-4">Misyonumuz</h3>
        <p class="lead">Sınav Merkezi olarak, öğrencilerin akademik başarılarını en üst düzeye çıkarmak ve onları geleceğe hazırlamak için kapsamlı sınav hizmetleri sunuyoruz.</p>
        <p>30 yıllık eğitim tecrübemizle, öğrencilerimize en kaliteli sınav deneyimini yaşatmayı hedefliyoruz.</p>
      </div>
      <div class="col-lg-6">
        <h3 class="mb-4">Vizyonumuz</h3>
        <p class="lead">Türkiye''nin en güvenilir ve yenilikçi sınav merkezi olmak.</p>
        <p>Modern teknoloji ve deneyimli kadromuzla, eğitim sektöründe fark yaratan hizmetler sunmaya devam ediyoruz.</p>
      </div>
    </div>
    <div class="row mb-5">
      <div class="col-12">
        <h3 class="mb-4">Neden Biz?</h3>
        <div class="row">
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-award-fill text-primary" style="font-size: 3rem;"></i>
              <h5 class="mt-3">30+ Yıl Tecrübe</h5>
              <p>Eğitim sektöründe köklü geçmiş</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-people-fill text-success" style="font-size: 3rem;"></i>
              <h5 class="mt-3">10,000+ Öğrenci</h5>
              <p>Binlerce öğrenciye hizmet</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-mortarboard-fill text-info" style="font-size: 3rem;"></i>
              <h5 class="mt-3">Uzman Kadro</h5>
              <p>Deneyimli eğitim ekibi</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-graph-up-arrow text-warning" style="font-size: 3rem;"></i>
              <h5 class="mt-3">Yüksek Başarı</h5>
              <p>Kanıtlanmış sonuçlar</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="col-12">
        <h3 class="mb-4">Hizmetlerimiz</h3>
        <ul class="list-unstyled">
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Deneme Sınavları (TYT, AYT, LGS)</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Dijital Sonuç Takibi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Kişiselleştirilmiş Performans Raporları</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Veli Bilgilendirme Sistemi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Online Sınav Platformu</li>
        </ul>
      </div>
    </div>', 1),
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
      sonuc_goruntuleme_aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (veli_id) REFERENCES users (id),
      FOREIGN KEY (rehber_id) REFERENCES users (id),
      FOREIGN KEY (rehber_ogretmen_id) REFERENCES users (id),
      FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler (id)
    )
  `);
  
  // Mevcut ogrenci_talepleri tablosuna sonuc_goruntuleme_aktif kolonu ekle (varsa hata vermesin)
  db.run(`
    ALTER TABLE ogrenci_talepleri ADD COLUMN sonuc_goruntuleme_aktif INTEGER DEFAULT 1
  `, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.error('❌ Kolon ekleme hatası:', err);
    } else if (!err) {
      console.log('✅ sonuc_goruntuleme_aktif kolonu eklendi');
    }
  });
  
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

/**
 * TC bazlı öğrenci tekrarlarını temizler
 * Aynı TC'ye sahip öğrenciler varsa, kurum kaydını öncelikli tutar
 * @param {Array} veliOgrencileri - Veli tarafından eklenen öğrenciler
 * @param {Array} kurumOgrencileri - Kurum tarafından eklenen öğrenciler
 * @returns {Array} Temizlenmiş öğrenci listesi
 */
function temizleOgrenciTekrarlari(veliOgrencileri = [], kurumOgrencileri = []) {
  const tcMap = new Map();
  const tcSizOgrenciler = [];
  let tekrarSayisi = 0;
  
  // Önce kurum öğrencilerini ekle (öncelikli)
  kurumOgrencileri.forEach(ogr => {
    const tc = ogr.tc_no ? String(ogr.tc_no).replace('.0', '').trim() : null;
    if (tc && tc !== '' && tc !== 'null' && tc !== 'undefined') {
      if (!tcMap.has(tc)) {
        tcMap.set(tc, ogr);
      }
    } else {
      // TC yok, direkt ekle
      tcSizOgrenciler.push(ogr);
    }
  });
  
  // Sonra veli öğrencilerini ekle (sadece TC tekrar etmeyenler)
  veliOgrencileri.forEach(ogr => {
    const tc = ogr.tc_no ? String(ogr.tc_no).replace('.0', '').trim() : null;
    if (tc && tc !== '' && tc !== 'null' && tc !== 'undefined') {
      if (!tcMap.has(tc)) {
        tcMap.set(tc, ogr);
      } else {
        tekrarSayisi++;
        console.log(`   ⚠️  Tekrar: ${ogr.ad_soyad || ogr.ogrenci_adi} (TC: ${tc}) - Kurum kaydı kullanılıyor`);
      }
    } else {
      // TC yok, direkt ekle
      tcSizOgrenciler.push(ogr);
    }
  });
  
  // Tüm öğrencileri birleştir ve isme göre sırala
  const temizlenmis = [...Array.from(tcMap.values()), ...tcSizOgrenciler];
  temizlenmis.sort((a, b) => {
    const adA = (a.ad_soyad || a.ogrenci_adi || '').toLowerCase();
    const adB = (b.ad_soyad || b.ogrenci_adi || '').toLowerCase();
    return adA.localeCompare(adB, 'tr');
  });
  
  if (tekrarSayisi > 0) {
    console.log(`   🧹 ${tekrarSayisi} tekrar temizlendi`);
  }
  
  return temizlenmis;
}

// ============================================
// SITE AYARLARI MIDDLEWARE
// ============================================
app.use(async (req, res, next) => {
  try {
    const ayarlar = await dbAll('SELECT * FROM site_ayarlari');
    res.locals.siteAyarlari = {};
    ayarlar.forEach(a => {
      res.locals.siteAyarlari[a.anahtar] = a.deger;
    });
  } catch (error) {
    res.locals.siteAyarlari = {
      site_adi: 'Sınav Merkezi',
      site_adres: 'Ankara, Türkiye',
      site_telefon: '+90 (312) 123 45 67',
      site_email: 'info@sinavmerkezi.com',
      site_aciklama: '30 yıllık eğitim tecrübesiyle öğrencilerimizi geleceğe hazırlıyoruz.'
    };
  }
  next();
});

// ============================================
// AKILLI EŞLEŞTİRME SİSTEMİ - STRATEJİLER
// ============================================

/**
 * STRATEJİ 1: Öğrenilmiş Pattern (En Hızlı)
 * Daha önce başarılı olan pattern'leri kullanır
 */
async function strategy1_LearnedPattern(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('   📚 Geçmiş öğrenmelere bakılıyor...');
  
  try {
    // Bu kurumun geçmiş başarılı pattern'lerini al
    const learnedPattern = await dbGet(`
      SELECT name_line_number, name_position_type, success_rate, use_count
      FROM pdf_learning_patterns
      WHERE kurum_id = ? 
        AND success_rate >= 0.85
      ORDER BY use_count DESC, success_rate DESC
      LIMIT 1
    `, [kurumId]);
    
    if (!learnedPattern) {
      console.log('   ℹ️ Öğrenilmiş pattern yok');
      return null;
    }
    
    console.log(`   📖 Öğrenilmiş pattern: Satır ${learnedPattern.name_line_number} (Başarı: ${(learnedPattern.success_rate * 100).toFixed(0)}%, Kullanım: ${learnedPattern.use_count}x)`);
    
    // Öğrenilmiş satırdan ismi çıkar
    const extractedName = lines[learnedPattern.name_line_number];
    
    if (!extractedName) {
      console.log('   ⚠️ Satır bulunamadı');
      return null;
    }
    
    // İsmi temizle
    const cleanName = cleanExtractedName(extractedName);
    
    // Katılımcılarla eşleştir
    const match = findBestMatch(cleanName, katilimcilar);
    
    if (match && match.similarity >= 0.80) {
      return {
        ogrenciId: match.ogrenci.ogrenci_id,
        ogrenciAd: match.ogrenci.ad_soyad,
        kaynak: match.ogrenci.kaynak,
        extractedName: cleanName,
        confidence: match.similarity,
        lineNumber: learnedPattern.name_line_number
      };
    }
    
    console.log('   ❌ Öğrenilmiş pattern eşleşmedi');
    return null;
  } catch (error) {
    console.error('   ❌ Strateji 1 hatası:', error.message);
    return null;
  }
}

/**
 * STRATEJİ 2: Veritabanı Benzerlik Taraması (Ana Yöntem)
 * Tüm satırları tarayıp veritabanındaki öğrencilerle karşılaştırır
 */
async function strategy2_DatabaseSimilarity(lines, katilimcilar, kurumId, sinavId) {
  console.log('   🔎 Tüm satırlarda veritabanı benzerliği aranıyor...');
  
  let bestMatch = null;
  let bestSimilarity = 0;
  let bestLineNumber = -1;
  let bestExtractedName = '';
  
  // İlk 50 satırı tara
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    
    // Boş satırları atla
    if (!line || line.length < 5) continue;
    
    // 🆕 GELİŞMİŞ PARSE: Satırı farklı şekillerde parse et
    const parsedNames = [];
    
    // 1. Direkt satır
    parsedNames.push({ text: line, source: 'direct' });
    
    // 2. Rakamlardan önceki kısım (örn: "ALİ OSMAN ÇÖZELİ08-A" → "ALİ OSMAN ÇÖZELİ")
    const beforeNumber = line.match(/^([A-ZÇĞİÖŞÜa-zçğıöşü\s]+?)(?=\d|$)/);
    if (beforeNumber && beforeNumber[1].trim().length >= 5) {
      parsedNames.push({ text: beforeNumber[1].trim(), source: 'before_number' });
    }
    
    // 3. Kelime tabanlı parse (birleşik satırları böl)
    // "ÖğrenciNumaraSınıfALİ OSMAN ÇÖZELİ08-A" gibi durumlar için
    const words = line.split(/(?=[A-ZÇĞİÖŞÜ][a-zçğıöşü])/);
    words.forEach(w => {
      const clean = cleanExtractedName(w);
      if (clean && clean.length >= 5 && clean.split(' ').length >= 2) {
        parsedNames.push({ text: w, source: 'word_split' });
      }
    });
    
    // Her parse edilmiş ismi test et
    for (const parsed of parsedNames) {
      // İsim gibi mi kontrol et
      if (!looksLikeName(parsed.text)) continue;
      
      const cleanLine = cleanExtractedName(parsed.text);
      if (!cleanLine) continue;
      
      // Her katılımcı ile karşılaştır
      for (const katilimci of katilimcilar) {
        const similarity = stringSimilarity(cleanLine, katilimci.ad_soyad);
        
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = katilimci;
          bestLineNumber = i;
          bestExtractedName = cleanLine;
          console.log(`   🔍 Yeni aday: "${cleanLine}" → "${katilimci.ad_soyad}" (${(similarity * 100).toFixed(0)}%, kaynak: ${parsed.source})`);
        }
      }
    }
  }
  
  if (bestMatch && bestSimilarity >= 0.70) { // Eşiği 0.70'e düşürdük
    console.log(`   ✅ Eşleşme bulundu: "${bestMatch.ad_soyad}" (Benzerlik: ${(bestSimilarity * 100).toFixed(0)}%, Satır: ${bestLineNumber})`);
    
    return {
      ogrenciId: bestMatch.ogrenci_id,
      ogrenciAd: bestMatch.ad_soyad,
      kaynak: bestMatch.kaynak,
      extractedName: bestExtractedName,
      confidence: bestSimilarity,
      lineNumber: bestLineNumber
    };
  }
  
  console.log(`   ⚠️ Yeterli benzerlik bulunamadı (En iyi: ${(bestSimilarity * 100).toFixed(0)}%)`);
  return null;
}

/**
 * STRATEJİ 3: Pozisyon Tabanlı
 * PDF'deki pozisyona göre isim tahmini yapar
 */
async function strategy3_PositionBased(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('   📍 PDF koordinatlarına bakılıyor...');
  
  // İlk 15 satırda, en çok kelime sayısına sahip satırı bul
  const candidates = lines.slice(0, 15)
    .map((line, index) => ({
      line: line,
      index: index,
      wordCount: line.split(/\s+/).length,
      isNameLike: looksLikeName(line)
    }))
    .filter(c => c.isNameLike && c.wordCount >= 2 && c.wordCount <= 4)
    .sort((a, b) => b.wordCount - a.wordCount);
  
  for (const candidate of candidates) {
    const cleanLine = cleanExtractedName(candidate.line);
    const match = findBestMatch(cleanLine, katilimcilar);
    
    if (match && match.similarity >= 0.70) {
      console.log(`   ✅ Pozisyon eşleşmesi: "${match.ogrenci.ad_soyad}"`);
      return {
        ogrenciId: match.ogrenci.ogrenci_id,
        ogrenciAd: match.ogrenci.ad_soyad,
        kaynak: match.ogrenci.kaynak,
        extractedName: cleanLine,
        confidence: match.similarity * 0.9, // Pozisyon tabanlı biraz daha düşük güven
        lineNumber: candidate.index
      };
    }
  }
  
  console.log('   ❌ Pozisyon tabanlı eşleşme başarısız');
  return null;
}

/**
 * STRATEJİ 4: Gelişmiş Regex Pattern'leri
 */
async function strategy4_AdvancedRegex(lines, katilimcilar, kurumId, sinavId) {
  console.log('   🔤 Regex pattern\'leri deneniyor...');
  
  const patterns = [
    /(?:Öğrenci|ADI|SOYADI|İSİM)[:\s]+([A-ZÇĞİÖŞÜ\s]{10,40})/i,
    /(?:Ad Soyad)[:\s]+([A-ZÇĞİÖŞÜ\s]{10,40})/i,
    /^([A-ZÇĞİÖŞÜ]+\s+[A-ZÇĞİÖŞÜ]+(?:\s+[A-ZÇĞİÖŞÜ]+)?)\s+\d/,
    /\d+\s+([A-ZÇĞİÖŞÜ]+\s+[A-ZÇĞİÖŞÜ]+)/
  ];
  
  for (const pattern of patterns) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const match_result = lines[i].match(pattern);
      
      if (match_result && match_result[1]) {
        const extractedName = cleanExtractedName(match_result[1]);
        const match = findBestMatch(extractedName, katilimcilar);
        
        if (match && match.similarity >= 0.75) {
          console.log(`   ✅ Regex eşleşmesi: "${match.ogrenci.ad_soyad}"`);
          return {
            ogrenciId: match.ogrenci.ogrenci_id,
            ogrenciAd: match.ogrenci.ad_soyad,
            kaynak: match.ogrenci.kaynak,
            extractedName: extractedName,
            confidence: match.similarity * 0.85,
            lineNumber: i
          };
        }
      }
    }
  }
  
  console.log('   ❌ Regex eşleşmesi başarısız');
  return null;
}

/**
 * STRATEJİ 5: Fuzzy Search (En agresif)
 */
async function strategy5_FuzzySearch(lines, katilimcilar, kurumId, sinavId) {
  console.log('   🌫️ Fuzzy search yapılıyor (agresif)...');
  
  // Tüm PDF textini birleştir ve her katılımcıyı ara
  const fullText = lines.join(' ').toUpperCase();
  
  for (const katilimci of katilimcilar) {
    const nameWords = katilimci.ad_soyad.toUpperCase().split(/\s+/);
    
    // İsmin tüm kelimeleri PDF'de var mı?
    const allWordsExist = nameWords.every(word => fullText.includes(word));
    
    if (allWordsExist && nameWords.length >= 2) {
      console.log(`   ✅ Fuzzy eşleşme: "${katilimci.ad_soyad}" (tüm kelimeler bulundu)`);
      
      return {
        ogrenciId: katilimci.ogrenci_id,
        ogrenciAd: katilimci.ad_soyad,
        kaynak: katilimci.kaynak,
        extractedName: katilimci.ad_soyad,
        confidence: 0.70, // Düşük güven
        lineNumber: -1
      };
    }
  }
  
  console.log('   ❌ Fuzzy search başarısız');
  return null;
}

// ============================================
// AKILLI ÖĞRENME SİSTEMİ FONKSİYONLARI
// ============================================

/**
 * Başarılı pattern'i öğren
 */
async function learnSuccessfulPattern(kurumId, sinavId, result, strategyName) {
  try {
    console.log(`\n🎓 ÖĞRENME: Başarılı pattern kaydediliyor...`);
    
    // Sınav tipini al
    const sinav = await dbGet('SELECT sinav_turu FROM sinavlar WHERE id = ?', [sinavId]);
    
    // Var olan pattern'i güncelle veya yeni ekle
    const existing = await dbGet(`
      SELECT id, success_rate, use_count 
      FROM pdf_learning_patterns 
      WHERE kurum_id = ? AND name_line_number = ?
    `, [kurumId, result.lineNumber]);
    
    if (existing) {
      // Başarı oranını güncelle (moving average)
      const newSuccessRate = (existing.success_rate * existing.use_count + result.confidence) / (existing.use_count + 1);
      
      await dbRun(`
        UPDATE pdf_learning_patterns 
        SET success_rate = ?, 
            use_count = use_count + 1,
            last_used = datetime('now')
        WHERE id = ?
      `, [newSuccessRate, existing.id]);
      
      console.log(`   ✅ Pattern güncellendi (Yeni başarı: ${(newSuccessRate * 100).toFixed(0)}%)`);
    } else {
      // Yeni pattern ekle
      await dbRun(`
        INSERT INTO pdf_learning_patterns 
        (kurum_id, sinav_tipi, name_line_number, name_position_type, success_rate)
        VALUES (?, ?, ?, ?, ?)
      `, [kurumId, sinav?.sinav_turu || 'unknown', result.lineNumber, strategyName, result.confidence]);
      
      console.log(`   ✅ Yeni pattern öğrenildi (Satır: ${result.lineNumber})`);
    }
  } catch (error) {
    console.error('❌ Öğrenme hatası:', error);
  }
}

/**
 * Başarısızlığı kaydet (gelecekte analiz için)
 */
async function logMatchingFailure(sinavId, lines, reason) {
  try {
    const attemptedNames = lines.slice(0, 10).join(' | ');
    
    await dbRun(`
      INSERT INTO matching_failures (sinav_id, attempted_name, failure_reason)
      VALUES (?, ?, ?)
    `, [sinavId, attemptedNames.substring(0, 200), reason]);
    
    console.log('   📝 Başarısızlık kaydedildi (gelecek analiz için)');
  } catch (error) {
    console.error('❌ Başarısızlık kayıt hatası:', error);
  }
}

/**
 * ANA CASCADE MATCHING SİSTEMİ
 * Çok Katmanlı Akıllı Eşleştirme - Strateji 1 başarısız olursa Strateji 2'ye geçer
 */
async function intelligentCascadeMatching(pdfText, sinavId, kurumId, pdfPath) {
  console.log('\n🧠 AKILLI EŞLEŞTİRME BAŞLADI');
  
  try {
    // 1. Sınava katılan öğrencileri al
    const katilimcilar = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
    `, [sinavId]);
    
    console.log(`👥 Sınava katılan: ${katilimcilar.length} öğrenci`);
    
    if (katilimcilar.length === 0) {
      console.log('⚠️ Sınava katılan öğrenci bulunamadı!');
      return null;
    }
    
    // PDF'den tüm satırları çıkar
    const lines = pdfText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    const strategies = [
      strategy1_LearnedPattern,
      strategy2_DatabaseSimilarity,
      strategy3_PositionBased,
      strategy4_AdvancedRegex,
      strategy5_FuzzySearch
    ];
    
    let result = null;
    let usedStrategy = null;
    
    // Her stratejiyi sırayla dene
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      console.log(`\n🔍 Strateji ${i+1}: ${strategy.name}`);
      
      try {
        result = await strategy(lines, katilimcilar, kurumId, sinavId, pdfPath);
        
        // Strateji 1 ve 2 için daha düşük eşik, diğerleri için 0.75
        const minConfidence = (i === 0 || i === 1) ? 0.70 : 0.75;
        
        if (result && result.confidence >= minConfidence) {
          usedStrategy = strategy.name;
          console.log(`✅ Strateji ${i+1} BAŞARILI! (Güven: ${(result.confidence * 100).toFixed(0)}%)`);
          
          // Başarılı stratejiyi öğren
          await learnSuccessfulPattern(kurumId, sinavId, result, strategy.name);
          break;
        } else {
          console.log(`⚠️ Strateji ${i+1} yeterli güvende değil (Mevcut: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'yok'}, Gereken: ${(minConfidence * 100).toFixed(0)}%)`);
        }
      } catch (error) {
        console.error(`❌ Strateji ${i+1} hatası:`, error.message);
      }
    }
    
    // Hiçbir strateji işe yaramadıysa
    if (!result || result.confidence < 0.70) {
      console.log('❌ TÜM STRATEJİLER BAŞARISIZ - Manuel eşleştirme gerekli');
      console.log(`   En iyi sonuç: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'Bulunamadı'}`);
      await logMatchingFailure(sinavId, lines, 'all_strategies_failed');
      return null;
    }
    
    return {
      ...result,
      usedStrategy: usedStrategy
    };
  } catch (error) {
    console.error('❌ Cascade matching hatası:', error);
    return null;
  }
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
  secret: process.env.SESSION_SECRET || 'sinav-merkezi-secret-key-2024-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Railway proxy arkasında çalıştığı için false
    httpOnly: true, // XSS koruması
    maxAge: 24 * 60 * 60 * 1000, // 24 saat
    sameSite: 'lax' // Railway için lax daha uygun
  },
  proxy: true // Railway proxy desteği
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

app.post('/login', loginLimiter, async (req, res) => {
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
      
      // İlk giriş kontrolü (password_changed = 0 veya NULL)
      if (user.user_type === 'veli' && (user.password_changed === 0 || user.password_changed === null)) {
        console.log('   🔐 İLK GİRİŞ - Şifre değiştirme ekranına yönlendiriliyor\n');
        return res.redirect('/sifre-degistir');
      }
      
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

// Şifre Değiştirme Sayfası (İlk Giriş)
app.get('/sifre-degistir', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  
  res.render('sifre-degistir', { error: req.session.error });
  req.session.error = null;
});

app.post('/sifre-degistir', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  
  const { yeni_sifre, yeni_sifre_tekrar } = req.body;
  
  try {
    // Şifre kontrolü
    if (yeni_sifre.length < 6) {
      req.session.error = 'Şifre en az 6 karakter olmalıdır!';
      return res.redirect('/sifre-degistir');
    }
    
    if (yeni_sifre !== yeni_sifre_tekrar) {
      req.session.error = 'Şifreler uyuşmuyor!';
      return res.redirect('/sifre-degistir');
    }
    
    // Yeni şifreyi hashle
    const hashedPassword = await bcrypt.hash(yeni_sifre, 10);
    
    // Veritabanını güncelle
    await dbRun(`
      UPDATE users 
      SET password_hash = ?, password_changed = 1 
      WHERE id = ?
    `, [hashedPassword, req.session.userId]);
    
    console.log(`\n🔐 ŞİFRE DEĞİŞTİRİLDİ`);
    console.log(`   User ID: ${req.session.userId}`);
    console.log(`   ✅ Şifre başarıyla değiştirildi\n`);
    
    req.session.success = 'Şifreniz başarıyla değiştirildi!';
    
    // Kullanıcı tipine göre yönlendir
    const user = await dbGet('SELECT user_type FROM users WHERE id = ?', [req.session.userId]);
    
    if (user.user_type === 'veli') {
      return res.redirect('/veli/dashboard');
    } else {
      return res.redirect('/');
    }
    
  } catch (error) {
    console.error('Şifre değiştirme hatası:', error);
    req.session.error = 'Şifre değiştirme sırasında bir hata oluştu!';
    res.redirect('/sifre-degistir');
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
    
    // TC bazlı tekrarları temizle
    const tumOgrenciler = temizleOgrenciTekrarlari(veliOgrencileri, kurumOgrencileri);
    
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
// ESKİ TELEFON BAZLI SİSTEM KALDIRILDI - SADECE TC BAZLI SİSTEM KULLANILIYOR

// Kurum - Veli Giriş Bilgisi Getir (ESKİ - KALDIRILDI)
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
    
    // Şablon veri: Başlıklar + Gerçek veri örneği
    const sablonData = [
      {
        'ÖĞRENCI SINIF BİLGİSİ': '5',
        'ÖĞRENCI ADI SOYADI': 'Onur Kapıcıoğlu',
        'TELEFON KAYDI': 'Yapıldı',
        'T.C KİMLİK NO': '14983254220',
        'ÖĞRENCİ VELİ': 'Edip Kapıcıoğlu',
        'VELİ TELEFON': '05365052512',
        'TUTAR': '5000',
        'ÖDEME DURUMU': 'Yapıldı',
        'ÖDEME TÜRÜ': 'Nakit',
        'EDESIS KAYDI': '',
        'TAKSİT': ''
      },
      {
        'ÖĞRENCI SINIF BİLGİSİ': '3',
        'ÖĞRENCI ADI SOYADI': 'Örnek Öğrenci 2',
        'TELEFON KAYDI': '',
        'T.C KİMLİK NO': '12345678901',
        'ÖĞRENCİ VELİ': 'Örnek Veli 2',
        'VELİ TELEFON': '05321234567',
        'TUTAR': '4000',
        'ÖDEME DURUMU': 'Bekliyor',
        'ÖDEME TÜRÜ': '',
        'EDESIS KAYDI': '',
        'TAKSİT': '2'
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
    // Paketleri ve ilgili istatistikleri çek (sadece aktif olanlar)
    const paketler = await dbAll(`
      SELECT 
        sp.*,
        COUNT(DISTINCT ps.sinav_id) as sinav_sayisi,
        COUNT(DISTINCT pa.ogrenci_id) as ogrenci_sayisi
      FROM sinav_paketleri sp
      LEFT JOIN paket_sinavlari ps ON sp.id = ps.paket_id
      LEFT JOIN paket_atamalari pa ON sp.id = pa.paket_id AND pa.durum = 'aktif'
      WHERE sp.aktif = 1
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
  
  // ✅ Cache'i devre dışı bırak - her zaman güncel veri çek
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
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
    
    // TC bazlı tekrarları temizle (Kurum kaydı öncelikli)
    const tumOgrenciler = temizleOgrenciTekrarlari(veliOgrencileri, kurumOgrencileri);
    
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
    
    // Eşleşme istatistiklerini hesapla
    // pdf_path varsa eşleşmiştir (sonuc_durumu 'yuklendi', 'tamamlandi', 'bildirildi' olabilir)
    const eslesmisKatilimcilar = katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '');
    const eslesmemisKatilimcilar = katilimcilar.filter(k => !k.pdf_path || k.pdf_path.trim() === '');
    
    const istatistikler = {
      toplam: katilimcilar.length,
      eslesmis: eslesmisKatilimcilar.length,
      eslesmemis: eslesmemisKatilimcilar.length,
      oran: katilimcilar.length > 0 ? Math.round((eslesmisKatilimcilar.length / katilimcilar.length) * 100) : 0
    };
    
    console.log(`\n📊 İSTATİSTİKLER (Sınav ID: ${sinavId})`);
    console.log(`   Toplam Katılımcı: ${istatistikler.toplam}`);
    console.log(`   ✅ Eşleşen: ${istatistikler.eslesmis}`);
    console.log(`   ⚠️ Eşleşmeyen: ${istatistikler.eslesmemis}`);
    console.log(`   📊 Başarı Oranı: %${istatistikler.oran}`);
    
    // Session mesajlarını al ve hemen temizle
    const errorMsg = req.session.error;
    const successMsg = req.session.success;
    req.session.error = null;
    req.session.success = null;
    
    res.render('kurum/sinav-detay', {
      sinav: sinav,
      katilimcilar: katilimcilar,
      eslesmisKatilimcilar: eslesmisKatilimcilar,
      eslesmemisKatilimcilar: eslesmemisKatilimcilar,
      istatistikler: istatistikler,
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

// 🆕 Kurum - Sınav Sonuçlarını Listele (Yüklenmiş PDF sonuçlarını göster)
app.get('/kurum/sinav-sonuclari-listele/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\n📊 SINAV SONUÇLARI LİSTELENİYOR:', sinavId);
    
    // Sınav katılımcılarını ve sonuçlarını al
    const sonuclar = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY sk.id
    `, [sinavId]);
    
    console.log(`   Toplam katılımcı: ${sonuclar.length}`);
    
    // Sonuçları grupla
    let matchedCount = 0;
    let unmatchedCount = 0;
    
    const results = sonuclar.map((s, index) => {
      const eslesti = !!(s.pdf_path && s.sonuc_durumu === 'yuklendi');
      
      if (eslesti) matchedCount++;
      else unmatchedCount++;
      
      return {
        sayfaNo: index + 1,
        ogrenciId: s.ogrenci_id,
        ogrenciAdi: s.ad_soyad || 'BİLİNMEYEN',
        pdfYolu: s.pdf_path,
        eslesti: eslesti,
        kaynak: s.kaynak,
        sonucDurumu: s.sonuc_durumu
      };
    });
    
    console.log(`   ✅ Eşleşen: ${matchedCount}`);
    console.log(`   ⚠️  Eşleşmeyen: ${unmatchedCount}`);
    
    res.json({
      success: true,
      data: {
        totalCount: sonuclar.length,
        matchedCount: matchedCount,
        unmatchedCount: unmatchedCount,
        results: results
      }
    });
    
  } catch (error) {
    console.error('❌ Sonuç listeleme hatası:', error);
    res.status(500).json({
      success: false,
      error: 'Sonuçlar listelenemedi: ' + error.message
    });
  }
});

// 🆕 Kurum - Sınav Sonuçlarını Yayınla/Kaldır
app.post('/kurum/sinav-yayinla/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    const sinavId = req.params.id;
    const { yayinla } = req.body; // true = yayınla, false = yayından kaldır
    
    const yeniDurum = yayinla ? 1 : 0;
    
    await dbRun('UPDATE sinavlar SET sonuclar_aciklandi = ? WHERE id = ?', [yeniDurum, sinavId]);
    
    // Ayrıca sınav durumunu da güncelle (görsel uyumluluk için)
    const sinavDurumu = yayinla ? 'Sonuç açıklandı' : 'Sonuç yükleniyor';
    await dbRun('UPDATE sinavlar SET sinav_durumu = ? WHERE id = ?', [sinavDurumu, sinavId]);
    
    console.log(`\n📢 Sınav ${sinavId} durumu güncellendi: ${yayinla ? 'YAYINLANDI' : 'TASLAK'}`);
    
    res.json({ 
      success: true, 
      message: yayinla ? 'Sınav sonuçları başarıyla yayınlandı! Veliler artık görebilir.' : 'Sınav sonuçları yayından kaldırıldı (Taslak).' 
    });
    
  } catch (error) {
    console.error('Sınav yayınlama hatası:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu: ' + error.message });
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
    
    // Eğer hiçbir öğrenci eklenemediyse (hepsi zaten ekliyse), uyarı ver
    if (eklenenSayisi === 0 && mevcutSayisi > 0) {
      return res.json({ 
        success: false, 
        message: `⚠️ Seçtiğiniz ${mevcutSayisi} öğrenci zaten bu sınava ekli! Tekrar ekleme yapılamaz.` 
      });
    }
    
    // Bazıları eklendi, bazıları mevcuttu
    res.json({ 
      success: true, 
      message: `✅ ${eklenenSayisi} öğrenci eklendi${mevcutSayisi > 0 ? `\n⚠️ ${mevcutSayisi} öğrenci zaten ekli olduğu için atlandı` : ''}!` 
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

// 🆕 YENİ SİSTEM: Basit Sonuç Yükleme Sayfası
app.get('/kurum/sinav-sonuc-yukle-yeni/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    const katilimciSayisi = await dbGet(
      'SELECT COUNT(*) as count FROM sinav_katilimcilari WHERE sinav_id = ?',
      [sinavId]
    );
    
    res.render('kurum/sinav-sonuc-yukle-yeni', {
      user: req.session,
      sinav: sinav,
      katilimciSayisi: katilimciSayisi.count,
      error: req.query.error || null
    });
    
  } catch (error) {
    console.error('Sonuç yükleme sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ESKİ SİSTEM: Sonuç Yükleme Sayfası (Akıllı Eşleştirme ile)
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
// 🆕 YENİ SİSTEM: PDF'i Sayfalara Ayır (Otomatik Eşleştirme YOK)
app.post('/kurum/sinav-sonuc-yukle-sayfalara-ayir', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
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
    
    console.log('\n📄 PDF SAYFALARA AYRILIYOR:', req.file.originalname);
    console.log('📚 Sınav ID:', sinav_id);
    
    // PDF'i yükle
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`📊 Toplam sayfa: ${totalPages}`);
    
    // Her sayfayı ayrı PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya adı: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join('uploads', 'sinav-sonuclari', sayfaFileName);
      
      // Klasör yoksa oluştur
      const dir = path.dirname(sayfaYolu);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`   ✓ Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join('uploads', 'sinav-sonuclari', orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // Veritabanına kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // Geçici dosyayı sil
    fs.unlinkSync(req.file.path);
    
    console.log(`✅ PDF başarıyla ${totalPages} sayfaya ayrıldı!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol
      }
    });
    
  } catch (error) {
    console.error('❌ PDF ayırma hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ESKİ SİSTEM (Yedek olarak kalıyor)
app.post('/kurum/sinav-sonuc-yukle-analiz', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
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
    
    // Potansiyel isim adaylarını bul - YENİ GELİŞMİŞ SİSTEM
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const potansiyelIsimler = [];
    
    console.log(`📋 Analiz: ${lines.length} satır bulundu`);
    
    // 1. GELİŞMİŞ FİLTRELEME: Yeni looksLikeName fonksiyonunu kullan
    for (let i = 0; i < Math.min(lines.length, 80); i++) { // 80 satıra çıkardık
      const line = lines[i];
      
      // İsim gibi mi kontrol et (yeni fonksiyon)
      if (!looksLikeName(line)) continue;
      
      // İsmi temizle (yeni fonksiyon)
      const cleanLine = cleanExtractedName(line);
      if (!cleanLine || cleanLine.length < 5) continue;
      
      // Kelime sayısı kontrolü
      const words = cleanLine.split(/\s+/);
      const wordCount = words.length;
      
      // Güven seviyesi hesapla
      let confidence = 'medium';
      
      // Sadece harf ve boşluk + 2-3 kelime = yüksek güven
      if (wordCount === 2 || wordCount === 3) {
        confidence = 'high';
      }
      // 4-6 kelime = düşük güven
      else if (wordCount > 3) {
        confidence = 'low';
      }
      
      potansiyelIsimler.push({
        text: cleanLine,
        lineNumber: i,
        confidence: confidence,
        originalLine: line // Orijinal satırı da sakla
      });
      
      console.log(`   ✓ Aday ${potansiyelIsimler.length}: "${cleanLine}" (Satır: ${i}, Güven: ${confidence})`);
    }
    
    // 2. Hiç isim bulunamadıysa, en uzun satırları göster (fallback)
    if (potansiyelIsimler.length === 0) {
      console.log('⚠️ Hiç isim adayı bulunamadı, en uzun satırlar gösteriliyor...');
      
      const longLines = lines
        .map((line, i) => ({ line, index: i, length: line.length }))
        .filter(l => l.length >= 10 && l.length <= 100)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      
      longLines.forEach(l => {
        potansiyelIsimler.push({
          text: l.line,
          lineNumber: l.index,
          confidence: 'low',
          originalLine: l.line
        });
      });
      
      console.log(`   → ${potansiyelIsimler.length} uzun satır eklendi (fallback)`);
    }
    
    // 🧠 Akıllı sistem ile ilk sayfayı test et
    console.log('\n🧠 Akıllı sistem ile ilk sayfa test ediliyor...');
    const testMatch = await intelligentCascadeMatching(
      text, 
      sinav_id, 
      req.session.userId, 
      tempFilePath
    );
    
    let autoSelectedPattern = null;
    let autoConfidence = 0;
    
    if (testMatch && testMatch.confidence >= 0.80) {
      autoSelectedPattern = {
        text: testMatch.extractedName,
        lineNumber: testMatch.lineNumber,
        confidence: testMatch.confidence,
        strategy: testMatch.usedStrategy,
        matchedStudent: testMatch.ogrenciAd
      };
      autoConfidence = testMatch.confidence;
      console.log(`✅ Otomatik pattern bulundu: "${testMatch.extractedName}" (Güven: ${(autoConfidence * 100).toFixed(0)}%)`);
    } else {
      console.log('⚠️ Otomatik pattern bulunamadı, manuel seçim gerekli');
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
        allLines: lines, // Tüm satırları da gönder (frontend için)
        autoSelectedPattern: autoSelectedPattern, // 🎯 Otomatik seçilen pattern
        useAutoMode: autoConfidence >= 0.85 // %85+ güven varsa direkt kullan
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
    
    console.log('\n🧠 AKILLI SINAV SONUÇLARI YÜKLENİYOR');
    console.log('✅ Sınav ID:', sinav_id);
    console.log('✅ PDF Path:', pdfPath);
    console.log('🎯 Mod: Akıllı Cascade Matching (5 strateji)');
    
    const results = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let savedCount = 0;
    let strategyStats = {};
    
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
        
        let ogrenciId = null;
        let ogrenciAdi = 'BİLİNMEYEN';
        let kaynak = 'kurum';
        let usedStrategy = null;
        let confidence = 0;
        let extractedName = '';
        
        // Manuel eşleşme var mı kontrol et
        if (manuelMap[sayfaNo]) {
          // Manuel eşleşme var
          ogrenciId = manuelMap[sayfaNo];
          const ogrenci = await dbGet('SELECT * FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          if (ogrenci) {
            ogrenciAdi = ogrenci.ogrenci_adi_soyadi;
            console.log(`✅ Manuel eşleşme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            matchedCount++;
            usedStrategy = 'Manuel';
            confidence = 1.0;
          } else {
            console.log(`⚠️ Manuel eşleşme geçersiz! Öğrenci ID ${ogrenciId} bulunamadı.`);
            unmatchedCount++;
          }
        } else {
          // 🧠 AKILLI CASCADE MATCHING KULLAN
          const matchResult = await intelligentCascadeMatching(
            text, 
            sinav_id, 
            req.session.userId,
            tempFilePath
          );
          
          if (matchResult && matchResult.confidence >= 0.75) {
            // Başarılı eşleşme
            ogrenciId = matchResult.ogrenciId;
            ogrenciAdi = matchResult.ogrenciAd;
            kaynak = matchResult.kaynak;
            extractedName = matchResult.extractedName;
            confidence = matchResult.confidence;
            usedStrategy = matchResult.usedStrategy;
            
            // Strateji istatistiklerini güncelle
            strategyStats[usedStrategy] = (strategyStats[usedStrategy] || 0) + 1;
            
            console.log(`✅ Akıllı eşleşme: ${ogrenciAdi} (Strateji: ${usedStrategy}, Güven: ${(confidence * 100).toFixed(0)}%)`);
            matchedCount++;
          } else {
            // Eşleşme başarısız
            console.log(`❌ Tüm stratejiler başarısız - Manuel gerekli`);
            unmatchedCount++;
          }
        }
        
        // PDF'i kaydet
        const sanitizedName = ogrenciAdi.replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ\s]/g, '').replace(/\s+/g, '_');
        const finalFileName = ogrenciId 
          ? `${sayfaNo}_${sanitizedName}_${ogrenciId}.pdf`
          : `${sayfaNo}_BILINMEYEN_${Date.now()}.pdf`;
        
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
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [finalFilePath, sinav_id, ogrenciId, kaynak]);
            
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
          isGarbled: isGarbled,
          strategy: usedStrategy,
          confidence: confidence
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
    console.log(`\n📊 Strateji İstatistikleri:`);
    Object.entries(strategyStats).forEach(([strategy, count]) => {
      console.log(`   ${strategy}: ${count} sayfa`);
    });
    
    res.json({
      success: true,
      message: `${matchedCount}/${totalPages} sayfa otomatik eşleştirildi (Akıllı Sistem)`,
      data: {
        totalPages: totalPages,
        matchedCount: matchedCount,
        unmatchedCount: unmatchedCount,
        savedCount: savedCount,
        strategyStats: strategyStats,
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
    
    // Sınavın sonuc_yuklendi durumunu güncelle (ama henüz yayınlanmamış)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1, sonuc_yayinlandi = 0 WHERE id = ?', [sinavId]);
    
    // ✅ GÜNCEL İSTATİSTİKLERİ HESAPLA
    const istatistikler = await dbGet(`
      SELECT 
        COUNT(*) as toplam,
        SUM(CASE WHEN pdf_path IS NOT NULL AND pdf_path != '' THEN 1 ELSE 0 END) as eslesmis,
        SUM(CASE WHEN pdf_path IS NULL OR pdf_path = '' THEN 1 ELSE 0 END) as eslesmemis
      FROM sinav_katilimcilari
      WHERE sinav_id = ?
    `, [sinavId]);
    
    console.log(`\n📊 MANUEL EŞLEŞTIRME TAMAMLANDI:`);
    console.log(`   ✅ Başarılı: ${basarili}`);
    console.log(`   ❌ Hatalı: ${hatali}`);
    console.log(`\n📊 GÜNCEL DURUM:`);
    console.log(`   Toplam Katılımcı: ${istatistikler.toplam}`);
    console.log(`   Eşleşen: ${istatistikler.eslesmis}`);
    console.log(`   Eşleşmeyen: ${istatistikler.eslesmemis}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} öğrenci eşleştirildi! ${hatali > 0 ? `(${hatali} hata)` : ''}`,
      matchedCount: istatistikler.eslesmis || 0,
      unmatchedCount: istatistikler.eslesmemis || 0,
      totalCount: istatistikler.toplam || 0
    });
  } catch (error) {
    console.error('❌ Manuel eşleştirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// 📄 Kurum - Eşleşmemiş PDF Sayfalarını Listele
app.get('/kurum/sinav-eslesmemis-pdfler/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\n📄 TÜM PDF SAYFALARI LİSTELENİYOR (Eşleşen + Eşleşmeyen):', sinavId);
    
    // TÜM yüklenmiş PDF'leri al - HEM EŞLEŞEN HEM EŞLEŞMEYEN
    // pdf_path NULL olanlar = henüz eşleşmemiş (BİLİNMEYEN)
    // pdf_path dolu olanlar = eşleşmiş
    // BİLİNMEYEN olanlar = PDF var ama öğrenci eşleşmemiş
    const eslesmemisOgrenciler = await dbAll(`
      SELECT 
        sk.id as katilimci_id,
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
          ELSE 'BİLİNMEYEN'
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY 
        CASE 
          WHEN sk.pdf_path IS NOT NULL AND (ok.ogrenci_adi_soyadi = 'BİLİNMEYEN' OR o.ad_soyad = 'BİLİNMEYEN' OR (ok.ogrenci_adi_soyadi IS NULL AND o.ad_soyad IS NULL)) THEN 0
          WHEN sk.pdf_path IS NULL THEN 1
          ELSE 2
        END,
        sk.id
    `, [sinavId]);
    
    // Eşleştirilebilir öğrencileri al (tüm katılımcılar)
    const tumOgrenciler = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY ad_soyad
    `, [sinavId]);
    
    // Orijinal PDF yolunu bul - eşleşmiş herhangi bir öğrencinin PDF'inden al
    let orijinalPdfYolu = null;
    
    // Önce sinavlar tablosuna bak
    const sinav = await dbGet('SELECT dosya_yolu FROM sinavlar WHERE id = ?', [sinavId]);
    if (sinav && sinav.dosya_yolu) {
        orijinalPdfYolu = sinav.dosya_yolu;
    } else {
        // Yoksa eşleşmiş herhangi bir öğrencinin PDF'ini al
        const eslesmisOgrenci = await dbGet(
            'SELECT pdf_path FROM sinav_katilimcilari WHERE sinav_id = ? AND pdf_path IS NOT NULL LIMIT 1',
            [sinavId]
        );
        if (eslesmisOgrenci && eslesmisOgrenci.pdf_path) {
            orijinalPdfYolu = eslesmisOgrenci.pdf_path;
        }
    }
    
    console.log(`   📄 Eşleşmemiş: ${eslesmemisOgrenciler.length}`);
    console.log(`   👥 Toplam Öğrenci: ${tumOgrenciler.length}`);
    console.log(`   📁 PDF Yolu: ${orijinalPdfYolu}`);
    
    res.json({
      success: true,
      data: {
        eslesmemisPdfler: eslesmemisOgrenciler,
        tumOgrenciler: tumOgrenciler,
        orijinalPdfYolu: orijinalPdfYolu
      }
    });
    
  } catch (error) {
    console.error('❌ Eşleşmemiş PDF listeleme hatası:', error);
    res.json({ success: false, error: error.message });
  }
});

// 🔄 Kurum - Mevcut PDF'i Başka Öğrenciye Ata
app.post('/kurum/sinav-pdf-yeniden-eslestir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { katilimci_id, yeni_ogrenci_id, yeni_kaynak, sinav_id } = req.body;
    
    console.log(`\n🔄 PDF YENİDEN EŞLEŞTİRİLİYOR`);
    console.log(`   Katılımcı ID: ${katilimci_id}`);
    console.log(`   Yeni Öğrenci ID: ${yeni_ogrenci_id}`);
    console.log(`   Yeni Kaynak: ${yeni_kaynak}`);
    
    // Eski katılımcının PDF yolunu al
    const eskiKatilimci = await dbGet('SELECT pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimci_id]);
    
    if (!eskiKatilimci || !eskiKatilimci.pdf_path) {
      return res.json({ success: false, message: 'PDF bulunamadı!' });
    }
    
    // Yeni öğrenci bilgilerini al
    let yeniOgrenci;
    if (yeni_kaynak === 'kurum') {
      yeniOgrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [yeni_ogrenci_id]);
    } else {
      yeniOgrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [yeni_ogrenci_id]);
    }
    
    if (!yeniOgrenci) {
      return res.json({ success: false, message: 'Öğrenci bulunamadı!' });
    }
    
    // Eski PDF yolunu al
    const eskiPdfPath = eskiKatilimci.pdf_path;
    
    // Yeni dosya adı oluştur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    const guvenliIsim = yeniOgrenci.ad_soyad.replace(/[^a-zA-Z0-9ğüşöçİĞÜŞÖÇ\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // Dosyayı kopyala/taşı
    const eskiTamYol = path.join(__dirname, eskiPdfPath);
    if (fs.existsSync(eskiTamYol)) {
      fs.copyFileSync(eskiTamYol, yeniDosyaYolu);
    }
    
    // Veritabanını güncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    
    // Yeni öğrenci için kayıt oluştur/güncelle
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, yeni_ogrenci_id, yeni_kaynak]);
    
    // Eski kaydı temizle (PDF'i kaldır)
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = NULL, sonuc_durumu = 'bekleniyor'
      WHERE id = ?
    `, [katilimci_id]);
    
    // Eski dosyayı sil
    if (fs.existsSync(eskiTamYol)) {
      fs.unlinkSync(eskiTamYol);
    }
    
    console.log(`   ✅ PDF başarıyla "${yeniOgrenci.ad_soyad}" için atandı`);
    
    res.json({ 
      success: true, 
      message: `✅ PDF başarıyla "${yeniOgrenci.ad_soyad}" ile eşleştirildi!`
    });
    
  } catch (error) {
    console.error('❌ PDF yeniden eşleştirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// 👤 Kurum - Tek Öğrenci İçin PDF Eşleştir
app.post('/kurum/sinav-tek-ogrenci-eslestir', requireAuth, upload.single('pdf'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    const pdfFile = req.file;
    
    if (!pdfFile) {
      return res.json({ success: false, message: 'PDF dosyası yüklenmedi!' });
    }
    
    console.log(`\n👤 TEK ÖĞRENCİ EŞLEŞTİRME`);
    console.log(`   Sınav ID: ${sinav_id}`);
    console.log(`   Öğrenci ID: ${ogrenci_id}`);
    console.log(`   Kaynak: ${kaynak}`);
    console.log(`   PDF: ${pdfFile.filename}`);
    
    // Öğrenci bilgilerini al
    let ogrenci;
    if (kaynak === 'kurum') {
      ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenci_id]);
    } else {
      ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    }
    
    if (!ogrenci) {
      return res.json({ success: false, message: 'Öğrenci bulunamadı!' });
    }
    
    // Sınav klasörünü oluştur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sinavKlasoru)) {
      fs.mkdirSync(sinavKlasoru, { recursive: true });
    }
    
    // Dosya adını oluştur
    const guvenliIsim = ogrenci.ad_soyad.replace(/[^a-zA-Z0-9ğüşöçİĞÜŞÖÇ\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // Dosyayı taşı
    fs.copyFileSync(pdfFile.path, yeniDosyaYolu);
    fs.unlinkSync(pdfFile.path); // Geçici dosyayı sil
    
    // Veritabanını güncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, ogrenci_id, kaynak]);
    
    // Sınavın sonuc_yuklendi durumunu güncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`   ✅ Başarılı: ${ogrenci.ad_soyad} için PDF eşleştirildi`);
    
    res.json({ 
      success: true, 
      message: `✅ ${ogrenci.ad_soyad} için sonuç başarıyla eşleştirildi!`
    });
    
  } catch (error) {
    console.error('❌ Tek öğrenci eşleştirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// 📢 Kurum - Sınav Sonuçlarını Yayınla (Velilere görünür hale getir)
app.post('/kurum/sinav-sonuclari-yayinla/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\n📢 SINAV SONUÇLARI YAYINLANIYOR:', sinavId);
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'Sınav bulunamadı!' });
    }
    
    if (!sinav.sonuc_yuklendi) {
      return res.json({ success: false, message: 'Henüz sonuç yüklenmemiş!' });
    }
    
    if (sinav.sonuc_yayinlandi) {
      return res.json({ success: false, message: 'Sonuçlar zaten yayınlanmış!' });
    }
    
    // Eşleşmiş sonuç sayısını kontrol et
    const eslesmisler = await dbAll(`
      SELECT COUNT(*) as sayi 
      FROM sinav_katilimcilari 
      WHERE sinav_id = ? AND pdf_path IS NOT NULL
    `, [sinavId]);
    
    const eslesmeSayisi = eslesmisler[0]?.sayi || 0;
    
    if (eslesmeSayisi === 0) {
      return res.json({ success: false, message: 'Hiç eşleşmiş sonuç yok! Lütfen önce eşleştirme yapın.' });
    }
    
    // Sınavı yayınla
    await dbRun('UPDATE sinavlar SET sonuc_yayinlandi = 1 WHERE id = ?', [sinavId]);
    
    console.log(`   ✅ Yayınlandı: ${eslesmeSayisi} sonuç velilere görünür hale geldi`);
    
    res.json({ 
      success: true, 
      message: `✅ Sonuçlar yayınlandı! ${eslesmeSayisi} öğrencinin velisi artık sonuçları görebilir.`
    });
    
  } catch (error) {
    console.error('❌ Yayınlama hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
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
    console.log(`\n📋 SINAV SONUÇLARI (Veli ID: ${req.session.userId}, Username: ${req.session.username})`);
    
    // 1. Veli'nin kendi eklediği öğrenciler (ogrenciler tablosu)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`   Veli ekledi: ${veliOgrencileri.length} öğrenci`);
    
    // 2. Kurum tarafından eklenen öğrenciler (TC eşleşmesi ile)
    const kurumOgrencileri = await dbAll(`
      SELECT 
        id,
        ogrenci_adi_soyadi as ad_soyad,
        sinif,
        tc_kimlik_no as tc_no,
        telefon,
        'kurum' as kaynak
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = ?
    `, [req.session.username]);
    console.log(`   Kurum ekledi: ${kurumOgrencileri.length} öğrenci (TC eşleştirme)`);
    
    // 3. İki listeyi birleştir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    console.log(`   📊 TOPLAM: ${ogrenciler.length} öğrenci`);
    
    if (ogrenciler.length === 0) {
      return res.render('veli/sinav-sonuclari', {
        user: { username: req.session.username, type: req.session.userType },
        sonuclar: [],
        ogrenciler: [],
        error: 'Henüz öğrenci kaydınız bulunmuyor.',
        success: req.session.success
      });
    }
    
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
        AND s.sonuc_yayinlandi = 1
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
        AND REPLACE(CAST(ok.tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
        AND s.sonuc_yayinlandi = 1
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
      SELECT 
        t.id as talep_id, 
        t.created_at, 
        t.sonuc_goruntuleme_aktif,
        u.id as ogretmen_id, 
        u.ad_soyad, 
        u.kurum, 
        u.brans, 
        u.telefon
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

// Veli - Rehber Öğretmen Sınav Sonucu Görme Yetkisini Değiştir
app.post('/veli/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('🔄 Sonuç yetkisi değiştirme isteği:', { talepId, yeniDurum: yeni_durum, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduğunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    if (!talep || talep.veli_id !== req.session.userId) {
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Yetkiyi güncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`✅ Sınav sonucu görme yetkisi ${yeni_durum == 1 ? 'açıldı' : 'kapatıldı'}`);
    res.json({ 
      success: true, 
      message: `Sınav sonucu görme yetkisi ${yeni_durum == 1 ? 'açıldı' : 'kapatıldı'}!` 
    });
  } catch (error) {
    console.error('Yetki değiştirme hatası:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber Öğretmenler Listesi (Yetki Yönetimi)
app.get('/kurum/rehber-ogretmenler', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // Tüm onaylı talepleri rehber öğretmene göre grupla
    const talepler = await dbAll(`
      SELECT 
        t.id as talep_id,
        t.ogrenci_id,
        t.ad_soyad,
        t.sinif,
        t.veli_id,
        t.rehber_ogretmen_id,
        t.sonuc_goruntuleme_aktif,
        u.ad_soyad as rehber_ad_soyad,
        u.brans,
        u.kurum,
        u.telefon as rehber_telefon,
        o.ad_soyad as ogrenci_veli_ad,
        o.sinif as ogrenci_sinif,
        v.ad_soyad as veli_adi
      FROM ogrenci_talepleri t
      INNER JOIN users u ON t.rehber_ogretmen_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      LEFT JOIN users v ON t.veli_id = v.id
      WHERE t.durum = 'onaylandi'
      ORDER BY u.ad_soyad ASC, o.ad_soyad ASC
    `);
    
    // Rehber öğretmene göre grupla
    const rehberMap = new Map();
    
    talepler.forEach(talep => {
      const rehberId = talep.rehber_ogretmen_id;
      
      if (!rehberMap.has(rehberId)) {
        rehberMap.set(rehberId, {
          rehber_id: rehberId,
          ad_soyad: talep.rehber_ad_soyad,
          brans: talep.brans,
          kurum: talep.kurum,
          telefon: talep.rehber_telefon,
          ogrenci_sayisi: 0,
          ogrenciler: []
        });
      }
      
      const rehber = rehberMap.get(rehberId);
      rehber.ogrenci_sayisi++;
      rehber.ogrenciler.push({
        talep_id: talep.talep_id,
        ad_soyad: talep.ogrenci_veli_ad || talep.ad_soyad,
        sinif: talep.ogrenci_sinif || talep.sinif,
        veli_adi: talep.veli_adi,
        sonuc_goruntuleme_aktif: talep.sonuc_goruntuleme_aktif
      });
    });
    
    const rehberOgretmenler = Array.from(rehberMap.values());
    
    res.render('kurum/rehber-ogretmenler', {
      rehberOgretmenler: rehberOgretmenler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Rehber öğretmen listesi hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Rehber Öğretmen Sınav Sonucu Görme Yetkisini Değiştir
app.post('/kurum/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('🔄 Kurum - Sonuç yetkisi değiştirme:', { talepId, yeniDurum: yeni_durum });
    
    // Yetkiyi güncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`✅ Sınav sonucu görme yetkisi ${yeni_durum == 1 ? 'açıldı' : 'kapatıldı'}`);
    res.json({ 
      success: true, 
      message: `Sınav sonucu görme yetkisi ${yeni_durum == 1 ? 'açıldı' : 'kapatıldı'}!` 
    });
  } catch (error) {
    console.error('Yetki değiştirme hatası:', error);
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
    // Velinin tüm öğrencilerini getir (her iki tablodan)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    const kurumOgrencileri = await dbAll(`
      SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif, tc_kimlik_no as tc_no
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
    `, [req.session.userId]);
    
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    // Her öğrenci için sınav takvimini getir (her iki kaynaktan)
    let tumTakvim = [];
    try {
      // Veli eklediği öğrencilerin sınavları
      const veliTakvim = await dbAll(`
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
          sk.pdf_path,
          'veli' as kaynak
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
        WHERE o.veli_id = ? 
        ORDER BY s.tarih ASC
      `, [req.session.userId]);
      
      // Kurum eklediği öğrencilerin sınavları
      const kurumTakvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          ok.ogrenci_adi_soyadi as ogrenci_ad_soyad,
          ok.id as ogrenci_id,
          sk.sonuc_durumu,
          sk.pdf_path,
          'kurum' as kaynak
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
        WHERE REPLACE(CAST(ok.tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
        ORDER BY s.tarih ASC
      `, [req.session.userId]);
      
      tumTakvim = [...veliTakvim, ...kurumTakvim].sort((a, b) => new Date(a.tarih) - new Date(b.tarih));
      
      console.log(`\n📅 Veli Sınav Takvimi (User ID: ${req.session.userId}):`);
      console.log(`   Veli ekledi: ${veliTakvim.length} sınav`);
      console.log(`   Kurum ekledi: ${kurumTakvim.length} sınav`);
      console.log(`   Toplam: ${tumTakvim.length} sınav`);
      if (tumTakvim.length > 0) {
        tumTakvim.forEach(t => {
          console.log(`   - ${t.sinav_adi} | ${t.ogrenci_ad_soyad} | ${t.tarih} (${t.kaynak})`);
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
    
    // 1. Veli'nin kendi eklediği öğrenciler (ogrenciler tablosu)
    const veliOgrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`✅ Veli tablosundan ${veliOgrenciler.length} öğrenci bulundu`);
    
    // 2. Kurum tarafından eklenen öğrenciler (TC eşleşmesi ile)
    const kurumOgrenciler = await dbAll(`
      SELECT 
        id,
        ogrenci_adi_soyadi as ad_soyad,
        tc_kimlik_no as tc_no,
        sinif,
        'kurum' as kaynak
      FROM ogrenci_kayitlari 
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = REPLACE(?, '.0', '')
    `, [req.session.username]);
    console.log(`✅ Kurum tablosundan ${kurumOgrenciler.length} öğrenci bulundu (TC: ${req.session.username})`);
    
    // 3. Birleştir
    const ogrenciler = [...veliOgrenciler, ...kurumOgrenciler];
    console.log(`📊 TOPLAM ${ogrenciler.length} öğrenci`);
    
    // 4. İstatistikler
    for (let ogrenci of ogrenciler) {
      if (ogrenci.kaynak === 'kurum') {
        // Kurum öğrencisi - sinav_katilimcilari'ndan sınavları al
        const katilimlar = await dbAll(`
          SELECT s.ad AS sinav_adi, s.tarih AS sinav_tarihi, sk.pdf_path
          FROM sinav_katilimcilari sk
          JOIN sinavlar s ON sk.sinav_id = s.id
          WHERE sk.ogrenci_id = ? AND sk.ogrenci_kaynak = 'kurum'
        `, [ogrenci.id]);
        
        ogrenci.pdf_sonuc_sayisi = katilimlar.filter(k => k.pdf_path).length;
        ogrenci.excel_sonuc_sayisi = 0;
        ogrenci.sinavlar = katilimlar;
      } else {
        // Veli öğrencisi - eski sistem
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
    // Onaylı VE yetkisi aktif olan öğrencilerin sınav sonuçlarını getir
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
        AND t.sonuc_goruntuleme_aktif = 1
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
    
    console.log('\n📝 KURUMSAL SAYFA GÜNCELLEME:');
    console.log(`   ID: ${sayfaId}`);
    console.log(`   Sayfa Adı: ${sayfa_adi}`);
    console.log(`   Başlık: ${baslik}`);
    console.log(`   İçerik: ${icerik ? icerik.substring(0, 100) + '...' : 'BOŞ'}`);
    console.log(`   İçerik Uzunluğu: ${icerik ? icerik.length : 0} karakter`);
    console.log(`   Aktif: ${aktif}`);
    
    await dbRun(
      `UPDATE kurumsal_sayfalar 
       SET sayfa_adi = ?, baslik = ?, icerik = ?, seo_baslik = ?, seo_aciklama = ?, 
           sira = ?, aktif = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [sayfa_adi, baslik, icerik || '', seo_baslik || '', seo_aciklama || '', sira || 0, aktif ? 1 : 0, sayfaId]
    );
    
    console.log('   ✅ VERİTABANINA KAYDEDİLDİ!');
    
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

// ============================================
// KURUMSAL İÇERİK YÖNETİMİ (ADMIN PANEL)
// ============================================

// Kurumsal içerik listesi (Admin)
// DEPRECATED: Admin paneli yönlendirmeleri - Artık /kurum/ panelini kullanın
app.get('/admin/kurumsal-icerik', requireAuth, (req, res) => {
  console.log('⚠️ ESKİ ROUTE: /admin/kurumsal-icerik → /kurum/kurumsal-sayfalar yönlendiriliyor');
  res.redirect('/kurum/kurumsal-sayfalar');
});

app.get('/admin/kurumsal-icerik/duzenle/:id', requireAuth, (req, res) => {
  console.log(`⚠️ ESKİ ROUTE: /admin/kurumsal-icerik/duzenle/${req.params.id} → /kurum/kurumsal-sayfa-duzenle/${req.params.id} yönlendiriliyor`);
  res.redirect(`/kurum/kurumsal-sayfa-duzenle/${req.params.id}`);
});

// DEPRECATED: Admin paneli POST/DELETE route'ları kaldırıldı
// Artık /kurum/kurumsal-sayfa-guncelle/:id kullanılıyor

// 🆕 YENİ SİSTEM: Manuel Eşleştirme Ekranı
app.get('/kurum/sinav-manuel-eslestirme/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    const sadeceEslesmemis = req.query.sadece_eslesmemis === '1';
    
    // Sınavı al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    // Sayfa dosyalarını bul
    const sayfalarDir = path.join('uploads', 'sinav-sonuclari');
    let sayfalar = [];
    
    if (fs.existsSync(sayfalarDir)) {
      const allFiles = fs.readdirSync(sayfalarDir);
      sayfalar = allFiles
        .filter(f => f.startsWith(`sinav_${sinavId}_sayfa_`) && f.endsWith('.pdf'))
        .sort()
        .map(f => path.join(sayfalarDir, f));
    }
    
    // Eğer "sadece eşleşmemiş" modundaysa, sadece eşleşmemiş sayfaları filtrele
    if (sadeceEslesmemis) {
      // Hangi sayfaların eşleştiğini kontrol et
      const eslesmisSayfalar = await dbAll(`
        SELECT pdf_path FROM sinav_katilimcilari 
        WHERE sinav_id = ? AND pdf_path IS NOT NULL
      `, [sinavId]);
      
      const eslesmisSayfaSet = new Set(eslesmisSayfalar.map(s => s.pdf_path));
      
      // Sadece eşleşmemiş sayfaları al
      sayfalar = sayfalar.filter(sayfa => !eslesmisSayfaSet.has(sayfa));
      
      console.log(`📄 Sadece eşleşmemiş sayfalar: ${sayfalar.length}`);
    }
    
    // Katılımcıları al (pdf_path ile birlikte - eşleşme durumunu kontrol için)
    const katilimcilar = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY ad_soyad
    `, [sinavId]);
    
    console.log(`\n📋 MANUEL EŞLEŞTİRME - KATILIMCI LİSTESİ (Sınav ID: ${sinavId})`);
    console.log(`   Toplam Katılımcı: ${katilimcilar.length}`);
    const eslesmisSayisi = katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').length;
    console.log(`   Eşleşmiş Katılımcı: ${eslesmisSayisi}`);
    if (eslesmisSayisi > 0) {
      console.log(`   Eşleşmiş Öğrenciler:`);
      katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').forEach(k => {
        console.log(`     - ${k.ad_soyad} (ID: ${k.ogrenci_id}) -> ${k.pdf_path}`);
      });
    }
    
    res.render('kurum/sinav-manuel-eslestirme', {
      user: req.session,
      sinav: sinav,
      sayfalar: sayfalar,
      katilimcilar: katilimcilar
    });
    
  } catch (error) {
    console.error('Manuel eşleştirme ekranı hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// 🆕 Eşleşenleri Kontrol Et Sayfası
app.get('/kurum/sinav-eslesen-kontrol/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sınavı al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    // Eşleşmiş katılımcıları al (pdf_path dolu olanlar)
    const eslesmisler = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ? AND sk.pdf_path IS NOT NULL AND sk.pdf_path != ''
      ORDER BY ad_soyad
    `, [sinavId]);
    
    console.log(`\n✅ EŞLEŞEN KONTROL SAYFASI`);
    console.log(`   Sınav ID: ${sinavId}`);
    console.log(`   Eşleşmiş Sayısı: ${eslesmisler.length}`);
    
    res.render('kurum/sinav-eslesen-kontrol', {
      user: req.session,
      sinav: sinav,
      eslesmisler: eslesmisler
    });
    
  } catch (error) {
    console.error('Eşleşen kontrol sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// 🆕 Eşleşmeyi Kaldır
app.post('/kurum/sinav-eslestirme-kaldir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    
    console.log(`\n❌ EŞLEŞMEYİ KALDIR`);
    console.log(`   Sınav ID: ${sinav_id}`);
    console.log(`   Öğrenci ID: ${ogrenci_id} (${kaynak})`);
    
    // pdf_path'i NULL yap ve sonuc_durumu'nu beklemede'ye çek
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE sinav_katilimcilari 
        SET pdf_path = NULL, sonuc_durumu = 'beklemede'
        WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
      `, [sinav_id, ogrenci_id, kaynak], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
    
    console.log(`   ✅ Başarılı: ${result.changes} satır güncellendi`);
    
    if (result.changes === 0) {
      console.log(`   ⚠️  UYARI: Hiçbir satır güncellenmedi!`);
      return res.json({ success: false, error: 'Eşleşme bulunamadı!' });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Eşleşme kaldırma hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 TOPLU VELİ HESABI OLUŞTURMA
app.post('/kurum/toplu-veli-hesap-olustur', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('\n👥 TOPLU VELİ HESABI OLUŞTURMA BAŞLADI');
    
    // Tüm öğrencileri al (sadece kurum öğrencileri - tc_no olanlar)
    const ogrenciler = await dbAll(`
      SELECT id, ogrenci_adi_soyadi, tc_kimlik_no, sinif, telefon, veli_adi, veli_telefon
      FROM ogrenci_kayitlari
      WHERE tc_kimlik_no IS NOT NULL AND tc_kimlik_no != ''
      ORDER BY sinif, ogrenci_adi_soyadi
    `);
    
    console.log(`   📊 ${ogrenciler.length} öğrenci bulundu`);
    
    let olusturulan = 0;
    let mevcutOlanlar = 0;
    let hatalar = 0;
    
    for (const ogrenci of ogrenciler) {
      try {
        // Kontrol et: Bu TC ile kullanıcı var mı?
        const mevcutUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        if (mevcutUser) {
          mevcutOlanlar++;
          continue;
        }
        
        // Şifreyi hashle (ilk şifre = TC)
        const hashedPassword = await bcrypt.hash(ogrenci.tc_kimlik_no, 10);
        
        // Veli hesabı oluştur
        await dbRun(`
          INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, password_changed)
          VALUES (?, ?, ?, 'veli', ?, ?, 0)
        `, [
          ogrenci.tc_kimlik_no, // username = TC
          `veli_${ogrenci.id}_${Date.now()}@temp.com`, // benzersiz email
          hashedPassword,
          ogrenci.veli_adi || `${ogrenci.ogrenci_adi_soyadi} Velisi`,
          ogrenci.veli_telefon || ogrenci.telefon
        ]);
        
        // Veli ID'sini al
        const veliUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        // ogrenciler tablosuna ekle (veli-öğrenci ilişkisi)
        await dbRun(`
          INSERT OR IGNORE INTO ogrenciler (veli_id, ad_soyad, sinif, telefon, tc_no)
          VALUES (?, ?, ?, ?, ?)
        `, [
          veliUser.id,
          ogrenci.ogrenci_adi_soyadi,
          ogrenci.sinif,
          ogrenci.telefon,
          ogrenci.tc_kimlik_no
        ]);
        
        olusturulan++;
        
      } catch (error) {
        console.error(`   ❌ Hata (${ogrenci.ogrenci_adi_soyadi}):`, error.message);
        hatalar++;
      }
    }
    
    console.log(`\n✅ TOPLU VELİ HESABI OLUŞTURMA TAMAMLANDI`);
    console.log(`   ✅ Oluşturulan: ${olusturulan}`);
    console.log(`   ⚠️  Mevcut olanlar: ${mevcutOlanlar}`);
    console.log(`   ❌ Hatalar: ${hatalar}`);
    
    res.json({ 
      success: true, 
      olusturulan, 
      mevcutOlanlar, 
      hatalar,
      toplam: ogrenciler.length
    });
    
  } catch (error) {
    console.error('❌ Toplu veli hesabı oluşturma hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 YENİ SİSTEM: Sayfa Eşleştirme Kaydet
app.post('/kurum/sinav-sayfa-eslestir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, sayfa_yolu, ogrenci_id, kaynak } = req.body;
    
    console.log(`\n🔗 TEK SAYFA EŞLEŞTİRME`);
    console.log(`   Sınav ID: ${sinav_id}`);
    console.log(`   Öğrenci ID: ${ogrenci_id} (${kaynak})`);
    console.log(`   Sayfa Yolu: ${sayfa_yolu}`);
    
    // sinav_katilimcilari tablosunu güncelle
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE sinav_katilimcilari 
        SET pdf_path = ?, sonuc_durumu = 'yuklendi'
        WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
      `, [sayfa_yolu, sinav_id, ogrenci_id, kaynak], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
    
    console.log(`   ✅ Başarılı: ${result.changes} satır güncellendi`);
    
    if (result.changes === 0) {
      console.log(`   ⚠️  UYARI: Hiçbir satır güncellenmedi! WHERE koşulu tutmadı.`);
    }
    
    res.json({ success: true, changes: result.changes });
    
  } catch (error) {
    console.error('❌ Sayfa eşleştirme hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 YENİ SİSTEM: Yeni Sonuç Yükleme Sayfası
app.get('/kurum/sinav-sonuc-yukle-yeni/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    const katilimciSayisi = await dbGet(
      'SELECT COUNT(*) as count FROM sinav_katilimcilari WHERE sinav_id = ?',
      [sinavId]
    );
    
    res.render('kurum/sinav-sonuc-yukle-yeni', {
      user: req.session,
      sinav: sinav,
      katilimciSayisi: katilimciSayisi.count,
      error: req.query.error || null
    });
    
  } catch (error) {
    console.error('Sonuç yükleme sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ============================================
// KURUM - SITE AYARLARI
// ============================================

// Kurumsal Sayfalar Listesi
app.get('/kurum/kurumsal-sayfalar', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    
    res.render('kurum/kurumsal-sayfalar', {
      user: { username: req.session.username, type: req.session.userType },
      sayfalar: sayfalar,
      success: req.session.success,
      error: req.session.error
    });
    req.session.success = null;
    req.session.error = null;
  } catch (error) {
    console.error('Kurumsal sayfalar listesi hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurumsal Sayfa Düzenle (GET)
app.get('/kurum/kurumsal-sayfa-duzenle/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE id = ?', [req.params.id]);
    
    if (!sayfa) {
      req.session.error = 'Sayfa bulunamadı!';
      return res.redirect('/kurum/kurumsal-sayfalar');
    }
    
    res.render('kurum/kurumsal-sayfa-duzenle', {
      user: { username: req.session.username, type: req.session.userType },
      sayfa: sayfa
    });
  } catch (error) {
    console.error('Sayfa düzenle hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/kurumsal-sayfalar');
  }
});

// Site Ayarları Sayfası (GET)
app.get('/kurum/site-ayarlari', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const ayarlar = await dbAll('SELECT * FROM site_ayarlari ORDER BY anahtar ASC');
    
    const ayarlarObj = {};
    ayarlar.forEach(a => {
      ayarlarObj[a.anahtar] = a.deger;
    });
    
    res.render('kurum/site-ayarlari', {
      user: { username: req.session.username, type: req.session.userType },
      ayarlar: ayarlarObj,
      success: req.session.success,
      error: req.session.error
    });
    req.session.success = null;
    req.session.error = null;
  } catch (error) {
    console.error('Site ayarları sayfa hatası:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Site Ayarları Güncelle (POST)
app.post('/kurum/site-ayarlari', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { site_adi, site_adres, site_telefon, site_email, site_aciklama } = req.body;
    
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adi', site_adi]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adres', site_adres]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_telefon', site_telefon]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_email', site_email]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_aciklama', site_aciklama]);
    
    console.log('✅ Site ayarları güncellendi');
    req.session.success = 'Site ayarları başarıyla güncellendi!';
    res.redirect('/kurum/site-ayarlari');
  } catch (error) {
    console.error('Site ayarları güncelleme hatası:', error);
    req.session.error = 'Ayarlar güncellenirken bir hata oluştu!';
    res.redirect('/kurum/site-ayarlari');
  }
});

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
