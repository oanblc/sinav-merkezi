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
require('dotenv').config();

// Turso/SQLite Database Module
const { initConnection, dbGet, dbAll, dbRun, getDb, isTurso, USE_TURSO, ensureTursoTables } = require('./db');
const { initDatabase } = require('./init-db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');
// SESSION_SECRET - Railway icin fallback (production'da mutlaka environment variable kullanin!)
// Railway'de NODE_ENV otomatik production olmayabilir, bu yuzden fallback ekliyoruz
const SESSION_SECRET = process.env.SESSION_SECRET || 'railway-temp-secret-' + Date.now() + '-change-this-in-production';
const ENABLE_ADMIN_RESET = process.env.ENABLE_ADMIN_RESET === 'true';

if (!SESSION_SECRET) {
  console.error(' HATA: SESSION_SECRET environment variable is required!');
  console.error(' Railway Dashboard → Your Project → Variables → Add:');
  console.error('   Key: SESSION_SECRET');
  console.error('   Value: [guclu bir secret key - en az 32 karakter]');
  console.error('💡 Ornek: openssl rand -hex 32');
  console.error('  Production ortaminda SESSION_SECRET mutlaka ayarlanmalidir!');
  process.exit(1);
}

// ============================================
// RAILWAY PROXY CONFIGURATION
// ============================================
// Railway Metal Edge proxy kullaniyor, Express'e guvenmesini soyle
app.set('trust proxy', 1);

// ============================================
// RATE LIMITING - DDoS KORUMASI
// ============================================

// Genel rate limit (tum istekler icin)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 1000, // IP basina maksimum 1000 istek
  message: 'Cok fazla istek gonderdiniz. Lutfen 15 dakika sonra tekrar deneyin.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Login rate limit (brute force korumasi)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 5, // IP basina maksimum 5 deneme
  message: 'Cok fazla giris denemesi. Lutfen 15 dakika sonra tekrar deneyin.',
  skipSuccessfulRequests: true,
});

// File upload rate limit
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 50, // IP basina maksimum 50 upload
  message: 'Cok fazla dosya yukleme istegi. Lutfen 1 saat sonra tekrar deneyin.',
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
// WHATSAPP BILDIRIM SISTEMI
// ============================================

// WhatsApp bildirimi gonder (Whapi.cloud API kullanarak)
async function whatsappBildirimGonder(telefon, mesaj, bildirimTipi = 'genel') {
  console.log('\n ');
  console.log(' WHATSAPP BILDIRIM - Whapi.cloud');
  console.log(' ');
  console.log(` Alici: ${telefon}`);
  console.log(` Mesaj: ${mesaj}`);
  console.log(`  Tip: ${bildirimTipi}`);
  console.log(' \n');
  
  try {
    // WhatsApp ayarlarini al
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.api_token) {
      console.log('  WhatsApp API token bulunamadi, sadece log yaziliyor');
      
      // Bildirim gecmisine kaydet (simulasyon)
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
         VALUES (?, ?, ?, 'simulasyon', datetime('now'))`,
        [bildirimTipi, telefon, mesaj]
      );
      
      return { success: true, message: 'Bildirim gonderildi (simulasyon - API token yok)' };
    }
    
    // Whapi.cloud API'ye istek gonder
    const https = require('https');
    const url = require('url');
    
    // Telefon numarasini formatla (Whapi.cloud formati: 905551234567@s.whatsapp.net)
    let formattedPhone = telefon.replace(/[^0-9]/g, ''); // Sadece rakamlar
    if (!formattedPhone.startsWith('90')) {
      formattedPhone = '90' + formattedPhone; // Turkiye kodu ekle
    }
    formattedPhone = formattedPhone + '@s.whatsapp.net';
    
    // API URL'ini duzelt
    const baseUrl = (ayarlar.api_url || 'https://gate.whapi.cloud').replace(/\/$/, '');
    const apiUrl = `${baseUrl}/messages/text`;
    
    const postData = JSON.stringify({
      to: formattedPhone,
      body: mesaj
    });
    
    console.log(' API URL:', apiUrl);
    console.log(' Formatted Phone:', formattedPhone);
    console.log(' POST Data:', postData);
    
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
          console.log(' Whapi.cloud API Yaniti:', res.statusCode);
          console.log(' Response:', data);
          
          if (res.statusCode === 200 || res.statusCode === 201) {
            // Basarili - Bildirim gecmisine kaydet
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
               VALUES (?, ?, ?, 'basarili', datetime('now'))`,
              [bildirimTipi, telefon, mesaj]
            );
            
            resolve({ success: true, message: 'WhatsApp bildirimi basariyla gonderildi!' });
          } else {
            // API hatasi
            const errorMsg = `API Error: ${res.statusCode} - ${data}`;
            console.error('', errorMsg);
            
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
               VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
              [bildirimTipi, telefon, mesaj, errorMsg]
            );
            
            resolve({ success: false, message: 'WhatsApp bildirimi gonderilemedi', error: errorMsg });
          }
        });
      });
      
      req.on('error', async (error) => {
        console.error(' Whapi.cloud baglanti hatasi:', error);
        
        // Hata durumunu kaydet
        try {
          await dbRun(
            `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
             VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
            [bildirimTipi, telefon, mesaj, error.message]
          );
        } catch (logError) {
          console.error(' Bildirim gecmisi kayit hatasi:', logError);
        }
        
        resolve({ success: false, message: 'Baglanti hatasi', error: error.message });
      });
      
      req.write(postData);
      req.end();
    });
    
  } catch (error) {
    console.error(' WhatsApp bildirim hatasi:', error);
    
    // Hata durumunu kaydet
    try {
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
         VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
        [bildirimTipi, telefon, mesaj, error.message]
      );
    } catch (logError) {
      console.error(' Bildirim gecmisi kayit hatasi:', logError);
    }
    
    return { success: false, message: 'Bildirim gonderilemedi', error: error.message };
  }
}

// Yeni talep bildirimi olustur
function talepBildirimMesaji(veli, sinav) {
  return ` YENI SINAV TALEBI

 Veli: ${veli.ad_soyad}
 Telefon: ${veli.telefon}
 E-posta: ${veli.email}

 Sinav: ${sinav.ad}
 Fiyat: ${sinav.fiyat} TL
 Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

  Talep Zamani: ${new Date().toLocaleString('tr-TR')}

Lutfen bu talebi degerlendirin ve yanitlayin.`;
}

// ============================================
// GELIMI PDF TEXT EXTRACTION
// ============================================

// Bozuk text tespit et
function isGarbledText(text) {
  if (!text || text.length === 0) return true;
  
  // 1. Ayni karakterin 10+ kez tekrari (DYBNDYBNDYBN...)
  if (text.match(/(.)\1{9,}/)) {
    console.log('    Tespit: Tekrarlayan karakter paterni');
    return true;
  }
  
  // 2. 2-3 karakterlik tekrar (DYBN DYBN DYBN...)
  if (text.match(/(.{2,4})\1{5,}/)) {
    console.log('    Tespit: Tekrarlayan string paterni');
    return true;
  }
  
  // 3. Cok az sesli harf (encoding sorunlarinda sesliler kaybolur)
  const vowelCount = (text.match(/[AEIOUUOIIaeiouuo]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars > 50 && vowelCount / totalChars < 0.15) {
    console.log(`    Tespit: Cok az sesli harf (${vowelCount}/${totalChars})`);
    return true;
  }
  
  return false;
}

// Alternatif PDF okuma (simdilik devre disi - gelecekte OCR eklenebilir)
async function extractTextWithAlternative(pdfPath) {
  console.log('    Alternatif extraction su anda desteklenmiyor');
  console.log('    PDF\'i farkli formatta export edin veya manuel giris kullanin');
  return null;
}

// Hibrit extraction: Once pdf-parse, bozuksa PDF.js
async function extractTextHybrid(pdfPath) {
  // 1. Once pdf-parse dene
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const text1 = data.text;
  
  // Bozuk mu kontrol et
  if (!isGarbledText(text1)) {
    console.log('    pdf-parse basarili');
    return { text: text1, method: 'pdf-parse' };
  }
  
  console.log('    pdf-parse bozuk text uretti');
  
  // 2. Alternatif yontem dene (simdilik sadece uyari)
  await extractTextWithAlternative(pdfPath);
  
  // 3. Bozuk text ile devam et ama isaretle
  console.log('    Bozuk text ile devam ediliyor - Manuel kontrol gerekli');
  return { text: text1, method: 'pdf-parse-garbled', garbled: true };
}

// ============================================
// AKILLI ELETIRME SISTEMI - YARDIMCI FONKSIYONLAR
// ============================================

/**
 * Isim gibi gorunuyor mu kontrol et
 */
function looksLikeName(line) {
  // Once ismi rakamlardan ayir (orn: "ALI OSMAN COZELI08-A"  "ALI OSMAN COZELI")
  const cleanedLine = line.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  const words = cleanedLine.split(/\s+/);
  const wordCount = words.length;
  
  // Kelime sayisi kontrolu (daha esnek)
  if (wordCount < 2 || wordCount > 6) return false;
  
  // Uzunluk kontrolu (daha esnek)
  if (cleanedLine.length < 5 || cleanedLine.length > 60) return false;
  
  // Turkce harfler kontrolu
  if (!cleanedLine.match(/^[A-ZCIOUa-zcgiosu\s]+$/)) return false;
  
  // Blacklist: Baslik kelimeleri (daha kapsamli)
  if (cleanedLine.match(/BELGESI|SINAV|SONUC|PUAN|OKUL|DERS|NET|DORU|YANLI|BO|SIRA|ORTALAMA|ILCE|KURUM|LISE|ORTAOKUL|DENEME|NUMARA|GENEL|DERECE|KATILIM|BAARI|ANALIZ|CEVAP|SORU/i)) return false;
  
  // En az bir bosluk olmali (ad-soyad)
  if (!cleanedLine.includes(' ')) return false;
  
  return true;
}

/**
 * Ismi temizle (rakamlari ve ozel karakterleri kaldir)
 */
function cleanExtractedName(name) {
  if (!name) return '';
  
  // 1. Once sondaki rakam-harf kombinasyonlarini temizle (08-A, 123, vs)
  let clean = name.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  // 2. Tum rakamlari temizle
  clean = clean.replace(/\d+/g, '');
  
  // 3. Ozel karakterleri temizle (Turkce harfler haric)
  clean = clean.replace(/[^\wCIOUcgiosu\s]/g, '');
  
  // 4. Basindaki/sonundaki gereksiz kelimeleri temizle
  clean = clean.replace(/^(Ogrenci|ORENCI|Ogrenci|OGRENCI|Ad|AD|Adi|ADI|Soyad|SOYAD|Soyadi|SOYADI)\s*/gi, '');
  clean = clean.replace(/\s*(Numara|NUMARA|Sinif|SINIF|Sinifi|SINIFI)$/gi, '');
  
  // 5. Fazla bosluklari temizle
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // 6. Buyuk harfe cevir
  clean = clean.toUpperCase();
  
  // 7. Cok kisa veya cok uzunsa gecersiz
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
 * String benzerligi hesapla (0-1 arasi, 1 = tam eslesme)
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
 * En iyi eslesmeyi bul
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
  
  // Threshold'u dusurduk (0.60) - daha fazla eslesme icin
  return bestMatch && bestSimilarity >= 0.60 ? { ogrenci: bestMatch, similarity: bestSimilarity } : null;
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
      cb(new Error('Sadece PDF dosyasi yukleyebilirsiniz!'), false);
    }
  }
});

// Cevap anahtari upload (ayri klasor)
const answerKeyStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads/cevap-anahtarlari/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const answerKeyUpload = multer({
  storage: answerKeyStorage,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Sadece PDF dosyasi yukleyebilirsiniz!'), false);
    }
  }
});

// Veritabani baglantisi (Turso veya SQLite)
initConnection();

// Initialize database tables (async)
initDatabase().then(async () => {
  console.log('Database ready');
  // Turso icin eksik tablolari olustur
  if (USE_TURSO) {
    await ensureTursoTables();
  }
}).catch(err => {
  console.error('Database init failed:', err);
});

// LEGACY: db.serialize block removed - now using init-db.js
// Old db.serialize(() => { ... }) block starts here - REMOVING
const DB_INIT_REMOVED = true; // Marker for removed code
/* OLD CODE REMOVED - START
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
  
  // Mevcut veritabanina yeni sutunlari ekle (eger yoksa)
  db.run(`ALTER TABLE users ADD COLUMN ad_soyad TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN kurum TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  // Veli ilk giris kontrolu icin password_changed kolonu
  db.run(`ALTER TABLE users ADD COLUMN password_changed INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN brans TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN uzmanlik_alani TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN mezuniyet TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN profil_foto TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
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
  
  // Mevcut veritabanina yeni sutunlari ekle
  db.run(`ALTER TABLE ogrenciler ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN okul TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN sinif TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN ogrenci_no TEXT UNIQUE`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  // Sinavlar tablosuna yeni kolonlar ekle
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
  
  // Satinalma tablosuna PayTR kolonlari ekle
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
  
  // Mevcut sinavlar tablosuna yeni kolonlari ekle (eger yoksa)
  db.run(`ALTER TABLE sinavlar ADD COLUMN durum TEXT DEFAULT 'taslak'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' durum kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuclar_aciklandi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' sonuclar_aciklandi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN katilimci_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' katilimci_sayisi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuc_yuklendi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' sonuc_yuklendi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN cevap_anahtari_pdf TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' cevap_anahtari_pdf kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sinav_durumu TEXT DEFAULT 'Basvuru asamasinda'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' sinav_durumu kolonu zaten var veya hata:', err.message);
  });
  
  // Sinav Katilimcilari Tablosu (Sinav-Ogrenci Iliskisi + PDF Sonuclari)
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
    if (err && !err.message.includes('duplicate column')) console.log(' ogrenci_kaynak kolonu zaten var veya hata:', err.message);
  });
  
  // PDF goruntulenme takibi icin kolonlar ekle
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_goruldu INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' pdf_goruldu kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_gorunme_tarihi DATETIME`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' pdf_gorunme_tarihi kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_indirilme_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log(' pdf_indirilme_sayisi kolonu zaten var veya hata:', err.message);
  });
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_sinav_katilimci_unique ON sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak)", (err) => {
    if (err && !err.message.includes("already exists")) console.log("idx_sinav_katilimci_unique olusturulamadi:", err.message);
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
  
  // Sinav Talepleri Tablosu (Satin alma sistemi kaldirildi)
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

  // Paket Talepleri Tablosu (Sinav olmasa bile paket talebi kaydedilir)
  db.run(`
    CREATE TABLE IF NOT EXISTS paket_talepleri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      veli_id INTEGER NOT NULL,
      paket_id INTEGER NOT NULL,
      durum TEXT DEFAULT 'beklemede',
      aciklama TEXT,
      yanit TEXT,
      ad_soyad TEXT,
      telefon TEXT,
      email TEXT,
      talep_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
      yanitlanma_tarihi DATETIME,
      FOREIGN KEY (veli_id) REFERENCES users(id),
      FOREIGN KEY (paket_id) REFERENCES paketler(id)
    )
  `);
  
  // PayTR Ayarlari Tablosu - KALDIRILDI (Talep sistemi kullaniliyor)
  
  // ============ SINAV PAKETLERI SISTEMI ============
  
  // Sinav Paketleri Tablosu
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
  
  // Paket-Sinav Iliskisi (Many-to-Many)
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
  
  // Paket-Ogrenci Atamalari
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
  
  console.log(' Sinav Paketleri tablolari olusturuldu');
  
  // Kurumsal Icerik Yonetimi Tablosu
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
  
  // Varsayilan kurumsal icerikleri ekle (eger yoksa)
  db.get(`SELECT COUNT(*) as count FROM kurumsal_icerik`, (err, row) => {
    if (!err && row.count === 0) {
      const defaultPages = [
        {
          sayfa_adi: 'hakkimizda',
          baslik: 'Turkiye\'nin Simulasyon Sinav Merkezi',
          alt_baslik: '30 yillik egitim tecrubesiyle, gercek sinav ortaminda ogrencilerimizi gelecege hazirliyoruz.',
          icerik: 'Sinav Merkezi, Turkiye\'nin onde gelen simulasyon sinav organizasyonlarindan biridir. 1995 yilindan bu yana ogrencilerimize gercek sinav deneyimi yasatarak, onlari en iyi sekilde gelecege hazirlamaktayiz.',
          meta_description: 'Turkiye\'nin onde gelen simulasyon sinav merkezi. 30 yillik tecrube ile LGS, YKS ve tum sinavlar icin profesyonel deneme sinavlari.',
          meta_keywords: 'sinav merkezi, deneme sinavi, LGS, YKS, simulasyon sinavi',
          aktif: 1,
          sira: 1
        },
        {
          sayfa_adi: 'iletisim',
          baslik: 'Iletisim',
          alt_baslik: 'Bizimle iletisime gecin',
          icerik: 'Sorulariniz ve talepleriniz icin bizimle iletisime gecebilirsiniz.',
          meta_description: 'Sinav Merkezi iletisim bilgileri',
          meta_keywords: 'iletisim, telefon, e-posta, adres',
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
      
      console.log(' Varsayilan kurumsal icerikler olusturuldu');
    }
  });
  
  console.log(' Kurumsal Icerik Yonetimi tablosu olusturuldu');
  
  // Ogrenci Kayitlari Tablosu (Kurum icin)
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
      odeme_durumu TEXT DEFAULT 'BEKLIYOR',
      odeme_turu TEXT,
      edessis_kaydi TEXT,
      taksit TEXT,
      veli_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (veli_id) REFERENCES users(id)
    )
  `);

  // ogrenci_kayitlari tablosuna veli_id kolonu ekle (mevcut tablolar icin)
  db.run(`ALTER TABLE ogrenci_kayitlari ADD COLUMN veli_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });

  // WhatsApp API Ayarlari Tablosu
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
  
  // Bildirim Gecmisi Tablosu
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
  // AKILLI ORENME SISTEMI TABLOLARI
  // ============================================
  
  // PDF Pattern Ogrenme Tablosu
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
  
  // Basarisiz Eslestirmeler Tablosu (Ogrenme icin)
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
  
  // PDF Yapisi Hafizasi
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
  
  console.log(' Akilli Ogrenme Sistemi tablolari hazir');
  
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
  
  // Satin alinabilir sinavlar tablosu
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
  
  // Hakkimizda ve site ayarlari
  db.run(`
    CREATE TABLE IF NOT EXISTS site_ayarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anahtar TEXT UNIQUE NOT NULL,
      deger TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Varsayilan site ayarlarini ekle
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adi', 'Sinav Merkezi')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adres', 'Ankara, Turkiye')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_telefon', '+90 (312) 123 45 67')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_email', 'info@sinavmerkezi.com')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_aciklama', '30 yillik egitim tecrubesiyle ogrencilerimizi gelecege hazirliyoruz.')`);

  
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
  
  // Varsayilan kurumsal sayfalari ekle (eger yoksa)
  db.run(`
    INSERT OR IGNORE INTO kurumsal_sayfalar (sayfa_slug, sayfa_adi, baslik, icerik, sira)
    VALUES 
    ('hakkimizda', 'Hakkimizda', 'Sinav Merkezi Hakkinda', 
    '<div class="row mb-5">
      <div class="col-lg-6">
        <h3 class="mb-4">Misyonumuz</h3>
        <p class="lead">Sinav Merkezi olarak, ogrencilerin akademik basarilarini en ust duzeye cikarmak ve onlari gelecege hazirlamak icin kapsamli sinav hizmetleri sunuyoruz.</p>
        <p>30 yillik egitim tecrubemizle, ogrencilerimize en kaliteli sinav deneyimini yasatmayi hedefliyoruz.</p>
      </div>
      <div class="col-lg-6">
        <h3 class="mb-4">Vizyonumuz</h3>
        <p class="lead">Turkiye''nin en guvenilir ve yenilikci sinav merkezi olmak.</p>
        <p>Modern teknoloji ve deneyimli kadromuzla, egitim sektorunde fark yaratan hizmetler sunmaya devam ediyoruz.</p>
      </div>
    </div>
    <div class="row mb-5">
      <div class="col-12">
        <h3 class="mb-4">Neden Biz?</h3>
        <div class="row">
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-award-fill text-primary" style="font-size: 3rem;"></i>
              <h5 class="mt-3">30+ Yil Tecrube</h5>
              <p>Egitim sektorunde koklu gecmis</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-people-fill text-success" style="font-size: 3rem;"></i>
              <h5 class="mt-3">10,000+ Ogrenci</h5>
              <p>Binlerce ogrenciye hizmet</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-mortarboard-fill text-info" style="font-size: 3rem;"></i>
              <h5 class="mt-3">Uzman Kadro</h5>
              <p>Deneyimli egitim ekibi</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-graph-up-arrow text-warning" style="font-size: 3rem;"></i>
              <h5 class="mt-3">Yuksek Basari</h5>
              <p>Kanitlanmis sonuclar</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="col-12">
        <h3 class="mb-4">Hizmetlerimiz</h3>
        <ul class="list-unstyled">
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Deneme Sinavlari (TYT, AYT, LGS)</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Dijital Sonuc Takibi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Kisisellestirilmis Performans Raporlari</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Veli Bilgilendirme Sistemi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Online Sinav Platformu</li>
        </ul>
      </div>
    </div>', 1),
    ('iletisim', 'Iletisim', 'Iletisim', '<p><strong>Adres:</strong> Istanbul, Turkiye</p><p><strong>Email:</strong> info@sinavmerkezi.com</p><p><strong>Telefon:</strong> 0 (505) 354 12 30</p>', 2),
    ('sinav-merkezleri', 'Sinav Merkezleri', 'Sinav Merkezlerimiz', '<p>Tum Turkiye genelinde sinav merkezlerimiz bulunmaktadir.</p>', 3)
  `);
  
  // Eski sinav_takvimi tablosu kaldirildi - yeni yapi asagida
  
  db.run(`
    CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT NOT NULL,
      sinif TEXT NOT NULL,
      sinav_tarihi DATETIME NOT NULL,
      durum TEXT DEFAULT 'Sonuc aciklandi',
      cevap_anahtari_url TEXT,
      sonuc_url TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Sinav sonuclari tablosu (PDF'ler)
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
  
  // Ogrenci ekleme talepleri tablosu (Rehber -> Veli talep sistemi)
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
      console.error(' Kolon ekleme hatasi:', err);
    } else if (!err) {
      console.log(' sonuc_goruntuleme_aktif kolonu eklendi');
    }
  });
  
  // Sinav takvimi tablosu
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
  
  // Cevap anahtarlari tablosu
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
  
  // Eksik kolonlari ekle (ALTER TABLE)
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN rehber_ogretmen_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log(' rehber_ogretmen_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log(' ogrenci_talepleri.rehber_ogretmen_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN ogrenci_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log(' ogrenci_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log(' ogrenci_talepleri.ogrenci_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN pdf_isim TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN sayfa_no INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // Sutun zaten var, sorun yok
    }
  });
  
  // Sinav paketlerine fiyat kolonu ekle
  db.run(`ALTER TABLE sinav_paketleri ADD COLUMN fiyat REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log(' sinav_paketleri.fiyat kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('sinav_paketleri.fiyat kolonu eklendi');
    }
  });
});
OLD CODE REMOVED - END */

// Ogrenci Numarasi Olusturma Fonksiyonu
async function generateOgrenciNo() {
  const yil = new Date().getFullYear();
  
  // Bu yil eklenen son ogrenci numarasini bul
  const sonOgrenci = await dbGet(
    `SELECT ogrenci_no FROM ogrenciler 
     WHERE ogrenci_no LIKE ? 
     ORDER BY ogrenci_no DESC LIMIT 1`,
    [`${yil}%`]
  );
  
  let sira = 1;
  if (sonOgrenci && sonOgrenci.ogrenci_no) {
    // Son 4 haneyi al ve 1 artir
    const sonSira = parseInt(sonOgrenci.ogrenci_no.substring(4));
    sira = sonSira + 1;
  }
  
  // Yil + 4 haneli sira numarasi
  const ogrenciNo = `${yil}${sira.toString().padStart(4, '0')}`;
  return ogrenciNo;
}

// dbGet, dbAll, dbRun fonksiyonlari artik db.js'den import ediliyor

/**
 * TC bazli ogrenci tekrarlarini temizler
 * Ayni TC'ye sahip ogrenciler varsa, kurum kaydini oncelikli tutar
 * @param {Array} veliOgrencileri - Veli tarafindan eklenen ogrenciler
 * @param {Array} kurumOgrencileri - Kurum tarafindan eklenen ogrenciler
 * @returns {Array} Temizlenmis ogrenci listesi
 */
function temizleOgrenciTekrarlari(veliOgrencileri = [], kurumOgrencileri = []) {
  const tcMap = new Map();
  const tcSizOgrenciler = [];
  let tekrarSayisi = 0;
  
  // Once kurum ogrencilerini ekle (oncelikli)
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
  
  // Sonra veli ogrencilerini ekle (sadece TC tekrar etmeyenler)
  veliOgrencileri.forEach(ogr => {
    const tc = ogr.tc_no ? String(ogr.tc_no).replace('.0', '').trim() : null;
    if (tc && tc !== '' && tc !== 'null' && tc !== 'undefined') {
      if (!tcMap.has(tc)) {
        tcMap.set(tc, ogr);
      } else {
        tekrarSayisi++;
        console.log(`     Tekrar: ${ogr.ad_soyad || ogr.ogrenci_adi} (TC: ${tc}) - Kurum kaydi kullaniliyor`);
      }
    } else {
      // TC yok, direkt ekle
      tcSizOgrenciler.push(ogr);
    }
  });
  
  // Tum ogrencileri birlestir ve isme gore sirala
  const temizlenmis = [...Array.from(tcMap.values()), ...tcSizOgrenciler];
  temizlenmis.sort((a, b) => {
    const adA = (a.ad_soyad || a.ogrenci_adi || '').toLowerCase();
    const adB = (b.ad_soyad || b.ogrenci_adi || '').toLowerCase();
    return adA.localeCompare(adB, 'tr');
  });
  
  if (tekrarSayisi > 0) {
    console.log(`    ${tekrarSayisi} tekrar temizlendi`);
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
      site_adi: 'Sinav Merkezi',
      site_adres: 'Ankara, Turkiye',
      site_telefon: '+90 (312) 123 45 67',
      site_email: 'info@sinavmerkezi.com',
      site_aciklama: '30 yillik egitim tecrubesiyle ogrencilerimizi gelecege hazirliyoruz.'
    };
  }
  next();
});

// ============================================
// AKILLI ELETIRME SISTEMI - STRATEJILER
// ============================================

/**
 * STRATEJI 1: Ogrenilmis Pattern (En Hizli)
 * Daha once basarili olan pattern'leri kullanir
 */
async function strategy1_LearnedPattern(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('    Gecmis ogrenmelere bakiliyor...');
  
  try {
    // Bu kurumun gecmis basarili pattern'lerini al
    const learnedPattern = await dbGet(`
      SELECT name_line_number, name_position_type, success_rate, use_count
      FROM pdf_learning_patterns
      WHERE kurum_id = ? 
        AND success_rate >= 0.85
      ORDER BY use_count DESC, success_rate DESC
      LIMIT 1
    `, [kurumId]);
    
    if (!learnedPattern) {
      console.log('    Ogrenilmis pattern yok');
      return null;
    }
    
    console.log(`    Ogrenilmis pattern: Satir ${learnedPattern.name_line_number} (Basari: ${(learnedPattern.success_rate * 100).toFixed(0)}%, Kullanim: ${learnedPattern.use_count}x)`);
    
    // Ogrenilmis satirdan ismi cikar
    const extractedName = lines[learnedPattern.name_line_number];
    
    if (!extractedName) {
      console.log('    Satir bulunamadi');
      return null;
    }
    
    // Ismi temizle
    const cleanName = cleanExtractedName(extractedName);
    
    // Katilimcilarla eslestir
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
    
    console.log('    Ogrenilmis pattern eslesmedi');
    return null;
  } catch (error) {
    console.error('    Strateji 1 hatasi:', error.message);
    return null;
  }
}

/**
 * STRATEJI 2: Veritabani Benzerlik Taramasi (Ana Yontem)
 * Tum satirlari tarayip veritabanindaki ogrencilerle karsilastirir
 */
async function strategy2_DatabaseSimilarity(lines, katilimcilar, kurumId, sinavId) {    console.log('Database connected:', DB_PATH);
  
  let bestMatch = null;
  let bestSimilarity = 0;
  let bestLineNumber = -1;
  let bestExtractedName = '';
  
  // Ilk 50 satiri tara
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    
    // Bos satirlari atla
    if (!line || line.length < 5) continue;
    
    //  GELIMI PARSE: Satiri farkli sekillerde parse et
    const parsedNames = [];
    
    // 1. Direkt satir
    parsedNames.push({ text: line, source: 'direct' });
    
    // 2. Rakamlardan onceki kisim (orn: "ALI OSMAN COZELI08-A"  "ALI OSMAN COZELI")
    const beforeNumber = line.match(/^([A-ZCIOUa-zcgiosu\s]+?)(?=\d|$)/);
    if (beforeNumber && beforeNumber[1].trim().length >= 5) {
      parsedNames.push({ text: beforeNumber[1].trim(), source: 'before_number' });
    }
    
    // 3. Kelime tabanli parse (birlesik satirlari bol)
    // "OgrenciNumaraSinifALI OSMAN COZELI08-A" gibi durumlar icin
    const words = line.split(/(?=[A-ZCIOU][a-zcgiosu])/);
    words.forEach(w => {
      const clean = cleanExtractedName(w);
      if (clean && clean.length >= 5 && clean.split(' ').length >= 2) {
        parsedNames.push({ text: w, source: 'word_split' });
      }
    });
    
    // Her parse edilmis ismi test et
    for (const parsed of parsedNames) {
      // Isim gibi mi kontrol et
      if (!looksLikeName(parsed.text)) continue;
      
      const cleanLine = cleanExtractedName(parsed.text);
      if (!cleanLine) continue;
      
      // Her katilimci ile karsilastir
      for (const katilimci of katilimcilar) {
        const similarity = stringSimilarity(cleanLine, katilimci.ad_soyad);
        
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = katilimci;
          bestLineNumber = i;
          bestExtractedName = cleanLine;
          console.log(`    Yeni aday: "${cleanLine}"  "${katilimci.ad_soyad}" (${(similarity * 100).toFixed(0)}%, kaynak: ${parsed.source})`);
        }
      }
    }
  }
  
  if (bestMatch && bestSimilarity >= 0.70) { // Esigi 0.70'e dusurduk
    console.log(`    Eslesme bulundu: "${bestMatch.ad_soyad}" (Benzerlik: ${(bestSimilarity * 100).toFixed(0)}%, Satir: ${bestLineNumber})`);
    
    return {
      ogrenciId: bestMatch.ogrenci_id,
      ogrenciAd: bestMatch.ad_soyad,
      kaynak: bestMatch.kaynak,
      extractedName: bestExtractedName,
      confidence: bestSimilarity,
      lineNumber: bestLineNumber
    };
  }
  
  console.log(`    Yeterli benzerlik bulunamadi (En iyi: ${(bestSimilarity * 100).toFixed(0)}%)`);
  return null;
}

/**
 * STRATEJI 3: Pozisyon Tabanli
 * PDF'deki pozisyona gore isim tahmini yapar
 */
async function strategy3_PositionBased(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('    PDF koordinatlarina bakiliyor...');
  
  // Ilk 15 satirda, en cok kelime sayisina sahip satiri bul
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
      console.log(`    Pozisyon eslesmesi: "${match.ogrenci.ad_soyad}"`);
      return {
        ogrenciId: match.ogrenci.ogrenci_id,
        ogrenciAd: match.ogrenci.ad_soyad,
        kaynak: match.ogrenci.kaynak,
        extractedName: cleanLine,
        confidence: match.similarity * 0.9, // Pozisyon tabanli biraz daha dusuk guven
        lineNumber: candidate.index
      };
    }
  }
  
  console.log('    Pozisyon tabanli eslesme basarisiz');
  return null;
}

/**
 * STRATEJI 4: Gelismis Regex Pattern'leri
 */
async function strategy4_AdvancedRegex(lines, katilimcilar, kurumId, sinavId) {
  console.log('    Regex pattern\'leri deneniyor...');
  
  const patterns = [
    /(?:Ogrenci|ADI|SOYADI|ISIM)[:\s]+([A-ZCIOU\s]{10,40})/i,
    /(?:Ad Soyad)[:\s]+([A-ZCIOU\s]{10,40})/i,
    /^([A-ZCIOU]+\s+[A-ZCIOU]+(?:\s+[A-ZCIOU]+)?)\s+\d/,
    /\d+\s+([A-ZCIOU]+\s+[A-ZCIOU]+)/
  ];
  
  for (const pattern of patterns) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const match_result = lines[i].match(pattern);
      
      if (match_result && match_result[1]) {
        const extractedName = cleanExtractedName(match_result[1]);
        const match = findBestMatch(extractedName, katilimcilar);
        
        if (match && match.similarity >= 0.75) {
          console.log(`    Regex eslesmesi: "${match.ogrenci.ad_soyad}"`);
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
  
  console.log('    Regex eslesmesi basarisiz');
  return null;
}

/**
 * STRATEJI 5: Fuzzy Search (En agresif)
 */
async function strategy5_FuzzySearch(lines, katilimcilar, kurumId, sinavId) {
  console.log('    Fuzzy search yapiliyor (agresif)...');
  
  // Tum PDF textini birlestir ve her katilimciyi ara
  const fullText = lines.join(' ').toUpperCase();
  
  for (const katilimci of katilimcilar) {
    const nameWords = katilimci.ad_soyad.toUpperCase().split(/\s+/);
    
    // Ismin tum kelimeleri PDF'de var mi?
    const allWordsExist = nameWords.every(word => fullText.includes(word));
    
    if (allWordsExist && nameWords.length >= 2) {
      console.log(`    Fuzzy eslesme: "${katilimci.ad_soyad}" (tum kelimeler bulundu)`);
      
      return {
        ogrenciId: katilimci.ogrenci_id,
        ogrenciAd: katilimci.ad_soyad,
        kaynak: katilimci.kaynak,
        extractedName: katilimci.ad_soyad,
        confidence: 0.70, // Dusuk guven
        lineNumber: -1
      };
    }
  }
  
  console.log('    Fuzzy search basarisiz');
  return null;
}

// ============================================
// AKILLI ORENME SISTEMI FONKSIYONLARI
// ============================================

/**
 * Basarili pattern'i ogren
 */
async function learnSuccessfulPattern(kurumId, sinavId, result, strategyName) {
  try {
    console.log(`\n ORENME: Basarili pattern kaydediliyor...`);
    
    // Sinav tipini al
    const sinav = await dbGet('SELECT sinav_turu FROM sinavlar WHERE id = ?', [sinavId]);
    
    // Var olan pattern'i guncelle veya yeni ekle
    const existing = await dbGet(`
      SELECT id, success_rate, use_count 
      FROM pdf_learning_patterns 
      WHERE kurum_id = ? AND name_line_number = ?
    `, [kurumId, result.lineNumber]);
    
    if (existing) {
      // Basari oranini guncelle (moving average)
      const newSuccessRate = (existing.success_rate * existing.use_count + result.confidence) / (existing.use_count + 1);
      
      await dbRun(`
        UPDATE pdf_learning_patterns 
        SET success_rate = ?, 
            use_count = use_count + 1,
            last_used = datetime('now')
        WHERE id = ?
      `, [newSuccessRate, existing.id]);
      
      console.log(`    Pattern guncellendi (Yeni basari: ${(newSuccessRate * 100).toFixed(0)}%)`);
    } else {
      // Yeni pattern ekle
      await dbRun(`
        INSERT INTO pdf_learning_patterns 
        (kurum_id, sinav_tipi, name_line_number, name_position_type, success_rate)
        VALUES (?, ?, ?, ?, ?)
      `, [kurumId, sinav?.sinav_turu || 'unknown', result.lineNumber, strategyName, result.confidence]);
      
      console.log(`    Yeni pattern ogrenildi (Satir: ${result.lineNumber})`);
    }
  } catch (error) {
    console.error(' Ogrenme hatasi:', error);
  }
}

/**
 * Basarisizligi kaydet (gelecekte analiz icin)
 */
async function logMatchingFailure(sinavId, lines, reason) {
  try {
    const attemptedNames = lines.slice(0, 10).join(' | ');
    
    await dbRun(`
      INSERT INTO matching_failures (sinav_id, attempted_name, failure_reason)
      VALUES (?, ?, ?)
    `, [sinavId, attemptedNames.substring(0, 200), reason]);
    
    console.log('    Basarisizlik kaydedildi (gelecek analiz icin)');
  } catch (error) {
    console.error(' Basarisizlik kayit hatasi:', error);
  }
}

/**
 * ANA CASCADE MATCHING SISTEMI
 * Cok Katmanli Akilli Eslestirme - Strateji 1 basarisiz olursa Strateji 2'ye gecer
 */
async function intelligentCascadeMatching(pdfText, sinavId, kurumId, pdfPath) {
  console.log('\n AKILLI ELETIRME BALADI');
  
  try {
    // 1. Sinava katilan ogrencileri al
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
    
    console.log(` Sinava katilan: ${katilimcilar.length} ogrenci`);
    
    if (katilimcilar.length === 0) {
      console.log(' Sinava katilan ogrenci bulunamadi!');
      return null;
    }
    
    // PDF'den tum satirlari cikar
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
    
    // Her stratejiyi sirayla dene
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      console.log(`\n Strateji ${i+1}: ${strategy.name}`);
      
      try {
        result = await strategy(lines, katilimcilar, kurumId, sinavId, pdfPath);
        
        // Strateji 1 ve 2 icin daha dusuk esik, digerleri icin 0.75
        const minConfidence = (i === 0 || i === 1) ? 0.70 : 0.75;
        
        if (result && result.confidence >= minConfidence) {
          usedStrategy = strategy.name;
          console.log(` Strateji ${i+1} BAARILI! (Guven: ${(result.confidence * 100).toFixed(0)}%)`);
          
          // Basarili stratejiyi ogren
          await learnSuccessfulPattern(kurumId, sinavId, result, strategy.name);
          break;
        } else {
          console.log(` Strateji ${i+1} yeterli guvende degil (Mevcut: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'yok'}, Gereken: ${(minConfidence * 100).toFixed(0)}%)`);
        }
      } catch (error) {
        console.error(` Strateji ${i+1} hatasi:`, error.message);
      }
    }
    
    // Hicbir strateji ise yaramadiysa
    if (!result || result.confidence < 0.70) {
      console.log(' TUM STRATEJILER BAARISIZ - Manuel eslestirme gerekli');
      console.log(`   En iyi sonuc: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'Bulunamadi'}`);
      await logMatchingFailure(sinavId, lines, 'all_strategies_failed');
      return null;
    }
    
    return {
      ...result,
      usedStrategy: usedStrategy
    };
  } catch (error) {
    console.error(' Cascade matching hatasi:', error);
    return null;
  }
}

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads')); // PDF dosyalarina erisim icin
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// EJS cache'i devre disi birak (development icin)
app.set('view cache', false);

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProd, // production'da HTTPS zorunlu, local gelistirmede false
    httpOnly: true, // XSS korumasi
    maxAge: 24 * 60 * 60 * 1000, // 24 saat
    sameSite: 'lax' // CSRF riskini azaltmak icin
  },
  proxy: true // Railway proxy destegi
}));

// Upload klasoru
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer yapilandirmasi
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
      cb(new Error('Sadece Excel ve CSV dosyalari yuklenebilir!'));
    }
  }
});

// Yardimci fonksiyonlar
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    // AJAX/API istekleri icin JSON donmeli
    const isApiRequest = req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
      req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';

    if (isApiRequest) {
      return res.status(401).json({
        success: false,
        message: 'Oturum suresi doldu. Lutfen tekrar giris yapin.',
        redirect: '/login'
      });
    }
    res.redirect('/login');
  }
}

function requireRole(role) {
  // role: string | string[]
  return (req, res, next) => {
    const allowed = Array.isArray(role) ? role : [role];
    if (allowed.includes(req.session.userType)) {
      return next();
    }

    // AJAX/API istekleri icin JSON donmeli
    const isApiRequest = req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
      req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';

    if (isApiRequest) {
      return res.status(403).json({
        success: false,
        message: 'Bu islemi yapmaya yetkiniz yok!'
      });
    }

    req.session.error = 'Bu sayfaya erisim yetkiniz yok!';
    if (req.session.userType && req.session.userType.startsWith('kurum')) {
      return res.redirect('/kurum/dashboard');
    }
    return res.redirect('/');
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
  
  // Ogrenci adi kolonunu bul
  if (!ogrenciAdiKolonu) {
    const keys = Object.keys(data[0]);
    ogrenciAdiKolonu = keys.find(key => {
      const keyLower = String(key).toLowerCase();
      return ['ad', 'isim', 'name', 'ogrenci', 'student', 'ad soyad', 'ad_soyad'].some(kelime => 
        keyLower.includes(kelime)
      );
    });
  }
  
  if (!ogrenciAdiKolonu) return [];
  
  // Tum ogrencileri cek
  const tumOgrenciler = await dbAll('SELECT * FROM ogrenciler');
  const ogrenciMap = {};
  tumOgrenciler.forEach(ogr => {
    const normalized = normalizeIsim(ogr.ad_soyad).toLowerCase();
    ogrenciMap[normalized] = ogr;
  });
  
  // Eslestirme yap
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
  
  // Ilk satiri baslik olarak al
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = cell.value;
  });
  
  // Diger satirlari oku
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Baslik satirini atla
    
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

// Health check endpoint (Railway icin)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// Routes
app.get('/', async (req, res) => {
  // Eger giris yapmissa ve force parametresi yoksa dashboard'a yonlendir
  if (req.session.userId && !req.query.force) {
    if (req.session.userType === 'veli') {
      return res.redirect('/veli/dashboard');
    } else if (req.session.userType === 'rehber_ogretmen') {
      return res.redirect('/rehber/dashboard');
    } else if (req.session.userType === 'admin') {
      return res.redirect('/admin/dashboard');
    }
  }
  
  // Anasayfa verilerini cek
  try {
    let slider = [];
    let duyurular = [];
    let satinAlinabilirSinavlar = [];
    let toplamOgrenci = { sayi: 0 };
    let toplamSinav = { sayi: 0 };
    
    try {
      slider = await dbAll('SELECT * FROM slider WHERE aktif = 1 ORDER BY sira ASC');
    } catch (e) {
      console.log('Slider hatasi:', e.message);
    }
    
    try {
      duyurular = await dbAll('SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC LIMIT 6');
    } catch (e) {
      console.log('Duyurular hatasi:', e.message);
    }
    
    try {
      // Yeni sinavlar tablosundan cek (fiyat > 0 olanlar satilik)
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
      console.log('Sinavlar hatasi:', e.message);
      satinAlinabilirSinavlar = [];
    }
    
    let sinavPaketleri = [];
    try {
      // Aktif sinav paketlerini cek
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
      console.log('Sinav paketleri hatasi:', e.message);
    }
    
    // Istatistikler
    try {
      toplamOgrenci = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler') || { sayi: 0 };
    } catch (e) {
      console.log('Ogrenci sayisi hatasi:', e.message);
    }
    
    try {
      toplamSinav = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar') || { sayi: 0 };
    } catch (e) {
      console.log('Sinav sayisi hatasi:', e.message);
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
    console.error('Anasayfa hatasi:', error);
    // Hata olsa bile anasayfayi goster
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
      console.error('Template render hatasi:', renderError);
      res.send('Anasayfa yuklenirken bir hata olustu: ' + renderError.message);
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

// Sinav Paketleri Sayfasi
app.get('/sinav-paketleri', async (req, res) => {
  try {
    // Tekil sinavlar (fiyat > 0 olanlar)
    const sinavlar = await dbAll('SELECT * FROM sinavlar WHERE fiyat > 0 ORDER BY tarih ASC');
    
    // Sinav paketleri (aktif olanlar)
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
    console.error('Sinav paketleri hatasi:', error);
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

// Kurum - Sinav Paketleri (yonetim listesi)
app.get('/kurum/sinav-paketleri-yonet', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar WHERE fiyat > 0 ORDER BY tarih ASC');
    const kurumId = req.session.userId || null;
    const paketler = await dbAll(`
      SELECT 
        sp.*,
        COUNT(DISTINCT ps.sinav_id) as sinav_sayisi
      FROM sinav_paketleri sp
      LEFT JOIN paket_sinavlari ps ON sp.id = ps.paket_id
      ${kurumId ? 'WHERE sp.kurum_id = ?' : ''}
      GROUP BY sp.id
      ORDER BY sp.olusturulma_tarihi DESC
    `, kurumId ? [kurumId] : []);
    
    // Kurum yonetim listesi admin sablonunu kullan
    res.render('kurum/sinav-paketleri', {
      paketler: paketler || [],
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      success: null,
      error: null,
      isYonetim: true
    });
  } catch (error) {
    console.error('Kurum sinav paketleri hatasi:', error);
    res.render('kurum/sinav-paketleri', {
      paketler: [],
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      success: null,
      error: 'Sinav paketleri alinamadi',
      isYonetim: true
    });
  }
});

// Eski kurum paketleri linki yeni yonetime yonlendir
app.get('/kurum/sinav-paketleri', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), (req, res) => {
  return res.redirect('/kurum/sinav-paketleri-yonet');
});

// Kurum - Yeni Sinav Paketi Olustur (form sayfasi)
app.get('/kurum/sinav-paketi-olustur', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY created_at DESC');
    const siniflar = Array.from(
      new Set([...(sinavlar || []).map(s => s.sinif).filter(Boolean), '3','4','5','6','7','8','9','10','11','12'])
    ).filter(Boolean).sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (isNaN(na) || isNaN(nb)) return String(a).localeCompare(String(b));
      return na - nb;
    });
    res.render('kurum/sinav-paketi-olustur', {
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      sinavlar: sinavlar || [],
      siniflar,
      paket: null,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Sinav paketi olustur sayfasi hatasi:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Kurum - Sinav Paketi Kaydet
app.post('/kurum/sinav-paketi-kaydet', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const { ad, aciklama, sinif, fiyat, sinav_ids } = req.body || {};
    if (!ad) return res.status(400).json({ success: false, message: 'Paket adi zorunludur!' });
    const sinavIds = Array.isArray(sinav_ids) ? sinav_ids : [];
    const pkgFiyat = parseFloat(fiyat) || 0;

    const result = await dbRun(`INSERT INTO sinav_paketleri (ad, aciklama, sinif, toplam_sinav_sayisi, aktif, fiyat, kurum_id) VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [ad.trim(), aciklama || null, sinif || null, sinavIds.length, pkgFiyat, req.session.userId || null]);
    const paketId = result.lastID;

    for (const sid of sinavIds) {
      await dbRun('INSERT INTO paket_sinavlari (paket_id, sinav_id) VALUES (?, ?)', [paketId, sid]);
    }

    return res.json({ success: true, message: 'Paket olusturuldu', paketId });
  } catch (error) {
    console.error('Sinav paketi kaydetme hatasi:', error);
    return res.status(500).json({ success: false, message: 'Paket olusturulamadi' });
  }
});

// Kurum - Sinav Paketi Duzenle (form)
app.get('/kurum/sinav-paketi-duzenle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    if (!paket) return res.redirect('/kurum/sinav-paketleri');

    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY created_at DESC');
    const siniflar = Array.from(
      new Set([...(sinavlar || []).map(s => s.sinif).filter(Boolean), '3','4','5','6','7','8','9','10','11','12'])
    ).filter(Boolean).sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (isNaN(na) || isNaN(nb)) return String(a).localeCompare(String(b));
      return na - nb;
    });

    // Secili sinavlar
    const secili = await dbAll('SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?', [paketId]);
    const seciliIds = new Set((secili || []).map(s => s.sinav_id));
    const sinavlarWithFlag = (sinavlar || []).map(s => ({ ...s, selected: seciliIds.has(s.id) }));

    res.render('kurum/sinav-paketi-duzenle', {
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      paket,
      sinavlar: sinavlarWithFlag,
      siniflar,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Sinav paketi duzenle sayfasi hatasi:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Kurum - Sinav Paketi Guncelle
app.post('/kurum/sinav-paketi-guncelle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const { ad, aciklama, sinif, fiyat, sinav_ids } = req.body || {};
    if (!ad) return res.status(400).json({ success: false, message: 'Paket adi zorunludur!' });
    const sinavIds = Array.isArray(sinav_ids) ? sinav_ids : [];
    const pkgFiyat = parseFloat(fiyat) || 0;

    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    if (!paket) return res.status(404).json({ success: false, message: 'Paket bulunamadi!' });

    await dbRun('UPDATE sinav_paketleri SET ad = ?, aciklama = ?, sinif = ?, fiyat = ?, toplam_sinav_sayisi = ? WHERE id = ?',
      [ad.trim(), aciklama || null, sinif || null, pkgFiyat, sinavIds.length, paketId]);

    await dbRun('DELETE FROM paket_sinavlari WHERE paket_id = ?', [paketId]);
    for (const sid of sinavIds) {
      await dbRun('INSERT INTO paket_sinavlari (paket_id, sinav_id) VALUES (?, ?)', [paketId, sid]);
    }

    return res.json({ success: true, message: 'Paket guncellendi' });
  } catch (error) {
    console.error('Sinav paketi guncelleme hatasi:', error);
    return res.status(500).json({ success: false, message: 'Paket guncellenemedi' });
  }
});

// Kurum - Sinav Paketi Aktif/Pasif
app.post('/kurum/sinav-paketi-aktif/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const { aktif } = req.body || {};

    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ? AND (kurum_id = ? OR ? IS NULL)', [paketId, req.session.userId || null, req.session.userId || null]);
    if (!paket) return res.status(404).json({ success: false, message: 'Paket bulunamadi!' });

    await dbRun('UPDATE sinav_paketleri SET aktif = ? WHERE id = ?', [aktif ? 1 : 0, paketId]);
    return res.json({ success: true, message: `Paket ${aktif ? 'aktiflestirildi' : 'pasiflestirildi'}` });
  } catch (error) {
    console.error('Sinav paketi aktif/pasif hatasi:', error);
    return res.status(500).json({ success: false, message: 'Guncellenemedi' });
  }
});

// Kurum - Sinav Paketi Sil
app.post('/kurum/sinav-paketi-sil/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    await dbRun('DELETE FROM sinav_paketleri WHERE id = ?', [paketId]);
    return res.json({ success: true, message: 'Paket silindi' });
  } catch (error) {
    console.error('Sinav paketi silme hatasi:', error);
    return res.status(500).json({ success: false, message: 'Paket silinemedi' });
  }
});

// Kurum - Sinav Paketi Detay
app.get('/kurum/sinav-paketi-detay/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    if (!paket) return res.redirect('/kurum/sinav-paketleri');

    const sinavlar = await dbAll(`
      SELECT s.*
      FROM paket_sinavlari ps
      INNER JOIN sinavlar s ON s.id = ps.sinav_id
      WHERE ps.paket_id = ?
      ORDER BY ps.sira ASC, s.tarih ASC
    `, [paketId]) || [];

    // Pakete atanan ogrencileri getir
    const ogrenciler = await dbAll(`
      SELECT pa.*, ok.ogrenci_adi_soyadi as ogrenci_adi, ok.sinif
      FROM paket_atamalari pa
      LEFT JOIN ogrenci_kayitlari ok ON ok.id = pa.ogrenci_id AND pa.ogrenci_kaynak = 'kurum'
      WHERE pa.paket_id = ?
      ORDER BY pa.atama_tarihi DESC
    `, [paketId]) || [];

    res.render('kurum/sinav-paketi-detay', {
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      paket,
      sinavlar,
      ogrenciler
    });
  } catch (error) {
    console.error('Sinav paketi detay hatasi:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Kurum - Pakete Ogrenci Ata
app.post('/kurum/paket-ogrenci-ata', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const { paket_id, ogrenci_ids } = req.body;

    if (!paket_id || !ogrenci_ids || ogrenci_ids.length === 0) {
      return res.json({ success: false, message: 'Paket ve ogrenci secimi gerekli' });
    }

    // Paketi kontrol et
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paket_id]);
    if (!paket) {
      return res.json({ success: false, message: 'Paket bulunamadi' });
    }

    let eklenenSayisi = 0;
    let zatenVarSayisi = 0;

    for (const ogrenciData of ogrenci_ids) {
      // Format: "id_kaynak" (ornegin "5_kurum")
      const [ogrenciId, kaynak] = ogrenciData.split('_');

      // Daha once atanmis mi kontrol et
      const mevcutAtama = await dbGet(
        'SELECT id FROM paket_atamalari WHERE paket_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?',
        [paket_id, ogrenciId, kaynak || 'kurum']
      );

      if (mevcutAtama) {
        zatenVarSayisi++;
        continue;
      }

      // Pakete ata
      await dbRun(
        'INSERT INTO paket_atamalari (paket_id, ogrenci_id, ogrenci_kaynak, durum) VALUES (?, ?, ?, ?)',
        [paket_id, ogrenciId, kaynak || 'kurum', 'aktif']
      );
      eklenenSayisi++;

      // Paketteki tum sinavlara da kaydet
      const paketSinavlari = await dbAll('SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?', [paket_id]);
      for (const ps of paketSinavlari) {
        // Ogrenci bilgisini al
        const ogrenci = await dbGet('SELECT ogrenci_adi_soyadi, sinif FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
        if (ogrenci) {
          // sinav_katilimcilari tablosuna ekle (yoksa)
          const mevcutKatilim = await dbGet(
            'SELECT id FROM sinav_katilimcilari WHERE sinav_id = ? AND ogrenci_id = ?',
            [ps.sinav_id, ogrenciId]
          );
          if (!mevcutKatilim) {
            await dbRun(
              'INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_adi, sinif, durum) VALUES (?, ?, ?, ?, ?)',
              [ps.sinav_id, ogrenciId, ogrenci.ogrenci_adi_soyadi, ogrenci.sinif, 'bekliyor']
            );
          }
        }
      }
    }

    let mesaj = eklenenSayisi + ' ogrenci pakete atandi';
    if (zatenVarSayisi > 0) {
      mesaj += ' (' + zatenVarSayisi + ' ogrenci zaten atanmisti)';
    }

    res.json({ success: true, message: mesaj });
  } catch (error) {
    console.error('Paket ogrenci atama hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Sinav Talep Gonderme - Giris Zorunlu Degil
app.post('/sinav-talep-gonder', async (req, res) => {
  try {
    const { sinav_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // Eger giris yapilmissa
    
    // Sinavi kontrol et
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.json({ success: false, message: 'Sinav bulunamadi!' });
    }
    
    // DURUM 1: Giris yapilmamis - Yeni hesap olustur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolu (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'Lutfen tum bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik olustur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha once kullanilmis mi?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // ifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username olustur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabi olustur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(` Yeni veli hesabi olusturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
      
      // Otomatik giris yapma (session olusturma)
      // req.session.userId = veli_id;
      // req.session.username = username;
      // req.session.userType = 'veli';
    }
    
    // DURUM 2: Daha once talep gonderilmis mi kontrol et
    const mevcutTalep = await dbGet(
      'SELECT * FROM sinav_talepleri WHERE veli_id = ? AND sinav_id = ? AND durum != "reddedildi"',
      [veli_id, sinav_id]
    );
    
    if (mevcutTalep) {
      return res.json({ success: false, message: 'Bu sinav icin zaten bir talebiniz bulunmaktadir!' });
    }
    
    // Talep kaydet
    await dbRun(
      `INSERT INTO sinav_talepleri (veli_id, sinav_id, durum, aciklama, talep_tarihi) 
       VALUES (?, ?, 'beklemede', ?, datetime('now'))`,
      [veli_id, sinav_id, aciklama || '']
    );
    
    // Veli bilgilerini al (WhatsApp bildirimi icin)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarini kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesaji olustur
      const mesaj = talepBildirimMesaji(veliDetay, sinav);
      
      // WhatsApp bildirimi gonder (arka planda, hata olsa bile kullaniciya basarili don)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'yeni_talep')
        .then(result => {
          console.log(' WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error(' WhatsApp bildirimi hatasi (arka plan):', error);
        });
    } else {
      console.log('  WhatsApp ayarlari yapilmamis, bildirim gonderilmedi');
    }
    
    res.json({ 
      success: true, 
      message: `${sinav.ad} icin talebiniz basariyla gonderildi! En kisa surede degerlendirilecektir.`,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Talep gonderme hatasi:', error);
    res.json({ success: false, message: 'Talep gonderilirken bir hata olustu: ' + error.message });
  }
});

// Paket Talebi Gonder
app.post('/paket-talep-gonder', async (req, res) => {
  try {
    const { paket_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // Eger giris yapilmissa
    
    // Paketi kontrol et
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ? AND aktif = 1', [paket_id]);
    if (!paket) {
      return res.json({ success: false, message: 'Paket bulunamadi!' });
    }
    
    // DURUM 1: Giris yapilmamis - Yeni hesap olustur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolu (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'Lutfen tum bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik olustur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha once kullanilmis mi?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // ifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username olustur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabi olustur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(` Yeni veli hesabi olusturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
    }
    
    // Daha once ayni pakete talep gonderilmis mi kontrol et
    const mevcutPaketTalep = await dbGet(
      'SELECT * FROM paket_talepleri WHERE veli_id = ? AND paket_id = ? AND durum = "beklemede"',
      [veli_id, paket_id]
    );

    if (mevcutPaketTalep) {
      return res.json({
        success: false,
        message: 'Bu paket icin zaten bekleyen bir talebiniz bulunmaktadir!'
      });
    }

    // Paket talebini kaydet (sinav olsun olmasin)
    await dbRun(
      `INSERT INTO paket_talepleri (veli_id, paket_id, durum, aciklama, ad_soyad, telefon, email, talep_tarihi)
       VALUES (?, ?, 'beklemede', ?, ?, ?, ?, datetime('now'))`,
      [veli_id, paket_id, aciklama || '', ad_soyad || '', telefon || '', email || '']
    );

    // Paket icindeki sinavlari al (varsa)
    const paketSinavlari = await dbAll(
      'SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ? AND sinav_id IS NOT NULL',
      [paket_id]
    );

    // Eger pakette sinav varsa, her sinav icin de talep olustur
    let olusturulanSinavTalep = 0;
    for (const ps of paketSinavlari) {
      // Daha once talep gonderilmis mi kontrol et
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
        olusturulanSinavTalep++;
      }
    }
    
    // Veli bilgilerini al (WhatsApp bildirimi icin)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarini kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesaji olustur
    const mesaj = `📥 YENI PAKET TALEBI\n\n` +
      `Merhaba,\n\n` +
      `${veliDetay.ad_soyad || veliDetay.username} adli veli "${paket.ad}" paketi icin talep gonderdi.\n\n` +
      `📦 Paket: ${paket.ad}\n` +
      `🎓 Sinif: ${paket.sinif || 'Belirtilmemis'}\n` +
      `📑 Sinav Sayisi: ${paketSinavlari.length}\n` +
      `${aciklama ? ` Aciklama: ${aciklama}\n` : ''}\n` +
      ` Telefon: ${veliDetay.telefon || 'Belirtilmemis'}\n` +
      `✉️ Email: ${veliDetay.email || 'Belirtilmemis'}\n\n` +
      `Lutfen kurum panelinden talebi degerlendirin.`;
      
      // WhatsApp bildirimi gonder (arka planda, hata olsa bile kullaniciya basarili don)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'paket_talebi')
        .then(result => {
          console.log(' WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error(' WhatsApp bildirimi hatasi (arka plan):', error);
        });
    } else {
      console.log('  WhatsApp ayarlari yapilmamis, bildirim gonderilmedi');
    }
    
    // Basari mesaji olustur
    let basariMesaji = `${paket.ad} paketi icin talebiniz basariyla gonderildi!`;
    if (paketSinavlari.length > 0) {
      basariMesaji += ` (${olusturulanSinavTalep} sinav talebi olusturuldu)`;
    }
    basariMesaji += ' En kisa surede degerlendirilecektir.';

    res.json({
      success: true,
      message: basariMesaji,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Paket talep gonderme hatasi:', error);
    res.json({ success: false, message: 'Talep gonderilirken bir hata olustu: ' + error.message });
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
    
    console.log('\n GIRI DENEMESI:');
    console.log('   Kullanici Adi:', username);
    console.log('Database connected:', DB_PATH);
    if (user) {
      console.log('   Kullanici Tipi:', user.user_type);
      console.log('   Hash Karsilastirma:', await bcrypt.compare(password, user.password_hash) ? 'Basarili' : 'Basarisiz');
    }
    
    if (user && await bcrypt.compare(password, user.password_hash)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.userType = user.user_type;
      
      console.log('    GIRI BAARILI!');
      console.log('   Session ID:', req.session.userId);
      
      // Ilk giris kontrolu (password_changed = 0 veya NULL)
      if (user.user_type === 'veli' && (user.password_changed === 0 || user.password_changed === null)) {
        console.log('    ILK GIRI - ifre degistirme ekranina yonlendiriliyor\n');
        return res.redirect('/sifre-degistir');
      }
      
      console.log('   Yonlendirme:', user.user_type + ' dashboard\n');
      
      if (user.user_type === 'veli') {
        return res.redirect('/veli/dashboard');
      } else if (user.user_type === 'rehber_ogretmen') {
        return res.redirect('/rehber/dashboard');
      } else if (user.user_type === 'kurum_yonetici') {
        return res.redirect('/kurum/dashboard');
      }
    }
    
    console.log('    GIRI BAARISIZ!\n');
    req.session.error = 'Kullanici adi veya sifre hatali!';
    res.redirect('/login');
  } catch (error) {
    console.error('Login hatasi:', error);
    req.session.error = 'Giris sirasinda bir hata olustu!';
    res.redirect('/login');
  }
});

// ifre Degistirme Sayfasi (Ilk Giris)
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
    // ifre kontrolu
    if (yeni_sifre.length < 6) {
      req.session.error = 'ifre en az 6 karakter olmalidir!';
      return res.redirect('/sifre-degistir');
    }
    
    if (yeni_sifre !== yeni_sifre_tekrar) {
      req.session.error = 'ifreler uyusmuyor!';
      return res.redirect('/sifre-degistir');
    }
    
    // Yeni sifreyi hashle
    const hashedPassword = await bcrypt.hash(yeni_sifre, 10);
    
    // Veritabanini guncelle
    await dbRun(`
      UPDATE users 
      SET password_hash = ?, password_changed = 1 
      WHERE id = ?
    `, [hashedPassword, req.session.userId]);
    
    console.log(`\n IFRE DEITIRILDI`);
    console.log(`   User ID: ${req.session.userId}`);
    console.log(`    ifre basariyla degistirildi\n`);
    
    req.session.success = 'ifreniz basariyla degistirildi!';
    
    // Kullanici tipine gore yonlendir
    const user = await dbGet('SELECT user_type FROM users WHERE id = ?', [req.session.userId]);
    
    if (user.user_type === 'veli') {
      return res.redirect('/veli/dashboard');
    } else {
      return res.redirect('/');
    }
    
  } catch (error) {
    console.error('ifre degistirme hatasi:', error);
    req.session.error = 'ifre degistirme sirasinda bir hata olustu!';
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
    // Kullanici adi kontrolu
    const existingUser = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existingUser) {
      req.session.error = existingUser.username === username 
        ? 'Bu kullanici adi zaten kullaniliyor!'
        : 'Bu e-posta adresi zaten kullaniliyor!';
      return res.redirect('/register');
    }
    
    // ifreyi hashle
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Kullaniciyi kaydet
    await dbRun('INSERT INTO users (username, email, password_hash, user_type) VALUES (?, ?, ?, ?)', 
      [username, email, passwordHash, user_type]);
    
    req.session.success = 'Kayit basarili! Giris yapabilirsiniz.';
    res.redirect('/login');
  } catch (error) {
    console.error('Register hatasi:', error);
    req.session.error = 'Kayit sirasinda bir hata olustu!';
    res.redirect('/register');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ONEMLI: Bu endpoint'i production'da kaldirin veya sifreleyin!
app.get('/reset-admin-password-secret-endpoint-12345', async (req, res) => {
  if (!ENABLE_ADMIN_RESET) {
    return res.status(404).send('Not found');
  }
  try {
    const password_hash = await bcrypt.hash('Admin2024!', 10);
    await dbRun(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [password_hash, 'kurum_admin']
    );
    res.send(' Admin sifresi sifirlandi! Username: kurum_admin, Password: Admin2024!');
  } catch (error) {
    res.status(500).send(' Hata: ' + error.message);
  }
});

// Kurum Dashboard
app.get('/kurum/dashboard', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
  }
  
  try {
    // Istatistikler
    const sinavSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar');
    const sinavAktif = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 0 AND katilimci_sayisi > 0');
    const sinavTamamlandi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 1');
    const sinavTaslak = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE katilimci_sayisi = 0');
    const toplamKatilimci = await dbGet('SELECT SUM(katilimci_sayisi) as toplam FROM sinavlar');
    const takvimSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar'); // Duzeltildi: sinav_takvimi  sinavlar
    const veliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM users WHERE user_type = "veli"');
    
    // Tum ogrenci sayisi (kurum + veli kayitlari)
    const ogrenciKurumSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    const ogrenciVeliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler');
    const ogrenciSayisi = { sayi: (ogrenciKurumSayisi.sayi || 0) + (ogrenciVeliSayisi.sayi || 0) };
    const ogrenciKayitSayisi = ogrenciKurumSayisi; // Kurum kayitlari icin ayri
    
    const talepBeklemede = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "beklemede"');
    const talepOnaylandi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "onaylandi"');
    const talepReddedildi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "reddedildi"');
    const talepToplam = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri');
    
    // Paket Istatistikleri
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
    console.error('Kurum dashboard hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// PayTR Entegrasyon Sayfasi - KALDIRILDI (Gerek yok)

// Kurum - WhatsApp Ayarlari (GET)
app.get('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
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
    console.error('WhatsApp ayarlari hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - WhatsApp Ayarlari (POST)
app.post('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
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
    
    req.session.success = 'WhatsApp ayarlari basariyla kaydedildi!';
    res.redirect('/kurum/whatsapp-ayarlari');
  } catch (error) {
    console.error('WhatsApp ayarlari kaydetme hatasi:', error);
    req.session.error = 'Ayarlar kaydedilirken bir hata olustu!';
    res.redirect('/kurum/whatsapp-ayarlari');
  }
});

// Kurum - WhatsApp Test Bildirimi
// Test icin manuel endpoint (GECICI - uretimde kaldirilmali)
app.post('/test-whatsapp-mesaj', async (req, res) => {
  try {
    const { telefon, mesaj } = req.body;
    
    if (!telefon || !mesaj) {
      return res.json({ success: false, message: 'Telefon ve mesaj gerekli!' });
    }
    
    console.log('\n ');
    console.log(' MANUEL TEST MESAJI GONDERILIYOR');
    console.log(' ');
    console.log(` Telefon: ${telefon}`);
    console.log(` Mesaj: ${mesaj}`);
    console.log(' \n');
    
    const result = await whatsappBildirimGonder(telefon, mesaj, 'test_manuel');
    
    res.json(result);
  } catch (error) {
    console.error(' Test mesaji hatasi:', error);
    res.json({ success: false, message: error.message });
  }
});

app.post('/kurum/whatsapp-test', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.phone_number) {
      return res.json({ 
        success: false, 
        message: 'WhatsApp ayarlari yapilmamis veya telefon numarasi eksik!' 
      });
    }
    
    const testMesaj = ` TEST BILDIRIMI

Bu bir test mesajidir.

 WhatsApp API entegrasyonunuz basariyla calisiyor!

 Test Zamani: ${new Date().toLocaleString('tr-TR')}`;
    
    const result = await whatsappBildirimGonder(ayarlar.phone_number, testMesaj, 'test');
    
    if (result.success) {
      return res.json({ 
        success: true, 
        message: 'Test mesaji basariyla gonderildi! Console loglari kontrol edin.' 
      });
    } else {
      return res.json({ 
        success: false, 
        message: 'Test mesaji gonderilemedi: ' + result.message 
      });
    }
  } catch (error) {
    console.error('Test bildirimi hatasi:', error);
    res.json({ success: false, message: 'Test sirasinda bir hata olustu: ' + error.message });
  }
});

// Kurum - Talep Yonetimi
app.get('/kurum/talepler', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    // Sinav Talepleri (Veli -> Kurum)
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
    
    // Rehber Ogretmen Talepleri (Hem kurum hem veli ogrencileri)
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

    // Paket Talepleri (Anasayfadan gelen)
    let paketTalepleri = [];
    try {
      paketTalepleri = await dbAll(`
        SELECT
          pt.*,
          p.ad as paket_adi,
          p.fiyat,
          p.sinif,
          pt.ad_soyad as veli_ad_soyad,
          pt.telefon as veli_telefon,
          pt.email as veli_email,
          u.username as veli_username,
          'paket' as talep_tipi
        FROM paket_talepleri pt
        LEFT JOIN sinav_paketleri p ON pt.paket_id = p.id
        LEFT JOIN users u ON pt.veli_id = u.id
      `);
    } catch (err) {
      console.log('Paket talepleri sorgu hatasi (tablo olmayabilir):', err.message);
    }

    // Tum listeleri birlestir
    const talepler = [...sinavTalepleri, ...rehberTalepleri, ...paketTalepleri].sort((a, b) => {
      // Once duruma gore sirala
      const durumOrder = { 'beklemede': 1, 'onaylandi': 2, 'reddedildi': 3 };
      const durumDiff = durumOrder[a.durum] - durumOrder[b.durum];
      if (durumDiff !== 0) return durumDiff;
      
      // Sonra tarihe gore sirala (en yeni en ustte)
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
    console.error('Talep listesi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - Talep Yonetimi (Alias - /kurum/talepler ile ayni)
app.get('/kurum/talep-yonetimi', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
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
    console.error('Talep listesi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - Talep Yanitla (Onayla/Reddet)
app.post('/kurum/talep-yanitla', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { talep_id, durum, yanit, talep_tipi } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'Gecersiz parametreler!' });
    }
    
    // Talep tipine gore farkli tablolardan guncelle
    if (talep_tipi === 'rehber') {
      // Rehber ogretmen talebi
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
      
      // WhatsApp bildirimi gonder
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? ` REHBER ORETMEN TALEBINIZ ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
            `Ã‚ÂŸÃ‚ÂÃ‚Â« Ogrenci: ${talep.ogrenci_adi}\n` +
            ` Rehber: ${talep.rehber_ad_soyad || 'Rehber Ogretmen'}\n` +
            ` Durum: Onaylandi\n\n` +
            (yanit ? ` Kurum Yaniti: ${yanit}\n\n` : '') +
            `Rehber ogretmen yetkisi aktif hale getirilmistir.`
          : ` REHBER ORETMEN TALEBINIZ REDDEDILDI\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
            `Ã‚ÂŸÃ‚ÂÃ‚Â« Ogrenci: ${talep.ogrenci_adi}\n` +
            ` Durum: Reddedildi\n\n` +
            (yanit ? ` Kurum Yaniti: ${yanit}\n\n` : '') +
            `Daha fazla bilgi icin lutfen bizimle iletisime geciniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
          .then(result => console.log(' WhatsApp bildirimi gonderildi:', result))
          .catch(error => console.error(' WhatsApp bildirimi hatasi:', error));
      }
      
    } else if (talep_tipi === 'paket') {
      // Paket talebi
      await dbRun(
        `UPDATE paket_talepleri
         SET durum = ?, yanit = ?, yanitlanma_tarihi = datetime('now')
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );

    } else {
      // Sinav talebi (eski kod)
      await dbRun(
        `UPDATE sinav_talepleri
         SET durum = ?, yanit = ?, yanitlanma_tarihi = datetime('now')
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al (WhatsApp bildirimi icin)
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
      
      // WhatsApp bildirimi gonder (arka planda)
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? ` TALEBINIZ ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
            ` Sinav: ${talep.sinav_adi}\n` +
            ` Durum: Onaylandi\n\n` +
            (yanit ? ` Kurum Yaniti: ${yanit}\n\n` : '') +
            `Sinav erisiminiz aktif hale getirilmistir. Iyi sinavlar dileriz! `
          : ` TALEBINIZ REDDEDILDI\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
            ` Sinav: ${talep.sinav_adi}\n` +
            ` Durum: Reddedildi\n\n` +
            (yanit ? ` Kurum Yaniti: ${yanit}\n\n` : '') +
            `Daha fazla bilgi icin lutfen bizimle iletisime geciniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `talep_${durum}`)
          .then(result => console.log(' WhatsApp bildirimi gonderildi:', result))
          .catch(error => console.error(' WhatsApp bildirimi hatasi:', error));
      }
    }

    res.json({
      success: true,
      message: durum === 'onaylandi' ? 'Talep basariyla onaylandi!' : 'Talep reddedildi.'
    });

  } catch (error) {
    console.error('Talep yanitlama hatasi:', error);
    res.json({ success: false, message: 'Talep islenirken bir hata olustu!' });
  }
});

// Kurum - Veli Listesi API (Rehber Talep icin)
app.get('/kurum/veliler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log(' Veli listesi API cagrildi');
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
    
    console.log(` ${veliler.length} veli bulundu`);
    res.json(veliler);
  } catch (error) {
    console.error(' Veli listesi hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Rehber Ogretmen Listesi API
app.get('/kurum/rehberler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
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
    console.error('Rehber listesi hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Tum Ogrenciler API (Kurum + Veli ogrencileri)
app.get('/kurum/tum-ogrenciler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log(' Tum ogrenciler API cagrildi');
    
    // Veli ogrencileri
    // Tek tablo sistemi - sadece ogrenci_kayitlari kullan
    const ogrenciler = await dbAll(`
      SELECT
        ok.id,
        ok.ogrenci_adi_soyadi as ad_soyad,
        ok.tc_kimlik_no as tc_no,
        ok.sinif,
        '' as okul,
        ok.telefon,
        '' as ogrenci_no,
        ok.veli_id,
        ok.veli_adi,
        ok.veli_telefon,
        'kurum' as kaynak
      FROM ogrenci_kayitlari ok
      ORDER BY ok.ogrenci_adi_soyadi ASC
    `);
    console.log('Toplam ' + ogrenciler.length + ' ogrenci donduruldu');
    res.json(ogrenciler);
/*
      console.log(` ${veliOgrencileri.length} veli ogrencisi bulundu`);
    } catch (error) {
      console.error(' Veli ogrencileri yukleme hatasi:', error);
    }
    
    // Kurum ogrencileri
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
      console.log(` ${kurumOgrencileri.length} kurum ogrencisi bulundu`);
    } catch (error) {
      console.error(' Kurum ogrencileri yukleme hatasi:', error);
    }
    
    // TC bazli tekrarlari temizle
    const tumOgrenciler = temizleOgrenciTekrarlari(veliOgrencileri, kurumOgrencileri);
    
    console.log(` Toplam ${tumOgrenciler.length} ogrenci donduruluyor`);
    
*/
  } catch (error) {
    console.error(' Tum ogrenci listesi hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Kurum - Veli Bilgisi API
app.get('/kurum/veli-bilgi-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
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
      return res.status(404).json({ success: false, message: 'Veli bulunamadi!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Veli bilgisi hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Telefon ile Veli Bul API
app.get('/kurum/veli-bul-telefon', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { telefon } = req.query;
    
    if (!telefon) {
      return res.status(400).json({ success: false, message: 'Telefon numarasi gerekli!' });
    }
    
    // Telefon numarasini temizle (.0 gibi ekleri kaldir)
    let temizTelefon = telefon.toString().trim();
    if (temizTelefon.endsWith('.0')) {
      temizTelefon = temizTelefon.replace('.0', '');
    }
    const telefonNokta = temizTelefon + '.0';
    
    // Telefon numarasi ile veli ara - hem temiz hem de .0 formatinda ara
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
      return res.status(404).json({ success: false, message: 'Veli bulunamadi!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Telefon ile veli arama hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Veli Ogrencileri API
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
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
    console.error('Ogrenci listesi hatasi:', error);
    res.status(500).json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Rehber Ogretmene Talep Gonder
app.post('/kurum/rehber-talep-gonder', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id, ogrenci_id, rehber_ogretmen_id, ogrenci_no, ad_soyad, sinif, okul, mesaj, ogrenci_kaynak } = req.body;
    
    console.log(' Talep gonderme istegi:', { veli_id, ogrenci_id, rehber_ogretmen_id, ad_soyad, ogrenci_kaynak });
    
    if (!veli_id || !rehber_ogretmen_id || !ad_soyad) {
      return res.json({ success: false, message: 'Eksik bilgiler! (veli_id, rehber_ogretmen_id, ad_soyad gerekli)' });
    }
    
    // Kurum ogrencileri icin ogrenci_id NULL olabilir
    const kullanilacakOgrenciId = (ogrenci_kaynak === 'kurum') ? null : ogrenci_id;
    
    // Ayni talep var mi kontrol et (ogrenci_id varsa) - Beklemede VEYA Onayli talep kontrolu
    if (kullanilacakOgrenciId) {
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi')
      `, [kullanilacakOgrenciId, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ogrenci icin bu rehber ogretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ogrenci icin bu rehber ogretmene zaten onayli bir talep var!' });
        }
      }
    } else {
      // Kurum ogrencileri icin ad_soyad ve veli_id ile kontrol et
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ad_soyad = ? AND veli_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi') AND ogrenci_id IS NULL
      `, [ad_soyad, veli_id, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ogrenci icin bu rehber ogretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ogrenci icin bu rehber ogretmene zaten onayli bir talep var!' });
        }
      }
    }
    
    // Talep olustur
    // rehber_id ve rehber_ogretmen_id ayni deger (kurum tarafindan gonderildigi icin)
    await dbRun(`
      INSERT INTO ogrenci_talepleri 
      (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum, mesaj)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'beklemede', ?)
    `, [kullanilacakOgrenciId, ogrenci_no || '', ad_soyad, sinif || '', okul || '', veli_id, rehber_ogretmen_id, rehber_ogretmen_id, mesaj || '']);
    
    console.log(' Talep basariyla olusturuldu');
    
    // Veli ve rehber bilgilerini al
    const veli = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [veli_id]);
    const rehber = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [rehber_ogretmen_id]);
    
    // WhatsApp bildirimi gonder (arka planda)
    if (veli && veli.telefon) {
      const veliMesaj = ` YENI REHBER ORETMEN TALEBI\n\n` +
        `Merhaba ${veli.ad_soyad || 'Degerli Velimiz'},\n\n` +
        `Kurum tarafindan sizin adiniza rehber ogretmen yetki talebi gonderilmistir.\n\n` +
        ` Ogrenci: ${ad_soyad}\n` +
        `Ã‚ÂŸÃ‚ÂÃ‚Â« Rehber: ${rehber?.ad_soyad || 'Rehber Ogretmen'}\n\n` +
        `Talebiniz onaylandiginda rehber ogretmen ogrenciniz hakkinda bilgilere erisebilecektir.`;
      
      whatsappBildirimGonder(veli.telefon, veliMesaj, 'rehber_talep_kurum')
        .then(result => console.log(' Veli WhatsApp bildirimi gonderildi:', result))
        .catch(error => console.error(' Veli WhatsApp bildirimi hatasi:', error));
    }
    
    if (rehber && rehber.telefon) {
      const rehberMesaj = ` YENI ORENCI YETKI TALEBI\n\n` +
        `Merhaba ${rehber.ad_soyad || 'Degerli Rehber Ogretmenimiz'},\n\n` +
        `Kurum tarafindan size yeni bir ogrenci yetki talebi gonderilmistir.\n\n` +
        ` Ogrenci: ${ad_soyad}\n` +
        `Ã‚ÂŸÃ‚Â‘Ã‚Â© Veli: ${veli?.ad_soyad || 'Veli'}\n` +
        `${sinif ? ` Sinif: ${sinif}\n` : ''}` +
        `${okul ? ` Okul: ${okul}\n` : ''}` +
        `${mesaj ? `\n Mesaj: ${mesaj}\n` : ''}\n` +
        `Lutfen veli panelinden talebi inceleyip onaylayin veya reddedin.`;
      
      whatsappBildirimGonder(rehber.telefon, rehberMesaj, 'rehber_talep_kurum')
        .then(result => console.log(' Rehber WhatsApp bildirimi gonderildi:', result))
        .catch(error => console.error(' Rehber WhatsApp bildirimi hatasi:', error));
    }
    
    res.json({ 
      success: true, 
      message: 'Rehber ogretmene talep basariyla gonderildi!' 
    });
    
  } catch (error) {
    console.error(' Rehber talep gonderme hatasi:', error);
    console.error('Hata detayi:', error.message);
    console.error('Stack trace:', error.stack);
    res.json({ 
      success: false, 
      message: `Talep gonderilirken bir hata olustu: ${error.message}` 
    });
  }
});

// Kurum - Ogrenci Kayitlari Yonetimi

// API: Hesapsiz Velileri Kontrol Et
app.get('/kurum/kontrol-hesapsiz-veliler', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    // ogrenci_kayitlari tablosundaki velileri al (sistemde hesabi olmayan)
    const hesapsizVeliler = await dbAll(`
      SELECT DISTINCT
        ok.veli_adi,
        ok.veli_telefon,
        ok.veli_email,
        ok.ogrenci_adi_soyadi,
        ok.sinif
      FROM ogrenci_kayitlari ok
      WHERE ok.veli_telefon IS NOT NULL
        AND ok.veli_telefon != ''
        AND NOT EXISTS (
          SELECT 1 FROM users u
          WHERE u.telefon = ok.veli_telefon
            OR u.username = ok.veli_telefon
        )
      ORDER BY ok.veli_adi ASC
    `);

    res.json({
      success: true,
      veliler: hesapsizVeliler
    });
  } catch (error) {
    console.error('Hesapsiz veliler kontrol hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!', veliler: [] });
  }
});

// API: Kurum Ogrenci Kayitlari (JSON)
app.get('/kurum/ogrenci-kayitlari-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY ogrenci_adi_soyadi ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API ogrenci kayitlari hatasi:', error);
    res.json([]);
  }
});

// API: Veli Ogrencileri (JSON)
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler ORDER BY ad_soyad ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API veli ogrencileri hatasi:', error);
    res.json([]);
  }
});

app.get('/kurum/ogrenci-kayitlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY created_at DESC');
    
    // Benzersiz sinif listesi
    const siniflar = [...new Set(ogrenciler.map(o => o.sinif).filter(s => s))].sort();
    
    // Session mesajlarini al ve hemen temizle
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
    console.error('Ogrenci kayitlari listesi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - Ogrenci Kayit Ekle
app.post('/kurum/ogrenci-kayit-ekle', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    const {
      sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
      veli_adi, veli_telefon, tutar, odeme_durumu,
      odeme_turu, edessis_kaydi, taksit, tcOnaylanmis
    } = req.body;

    // TC Kimlik kontrolu - ayni TC ile kayitli ogrenci var mi?
    if (tc_kimlik_no && !tcOnaylanmis) {
      const tcTemiz = tc_kimlik_no.toString().replace('.0', '').trim();
      const mevcutOgrenci = await dbGet(
        'SELECT id, ogrenci_adi_soyadi, sinif FROM ogrenci_kayitlari WHERE tc_kimlik_no = ?',
        [tcTemiz]
      );

      if (mevcutOgrenci) {
        return res.json({
          success: false,
          duplicate: true,
          message: 'Bu TC Kimlik No ile kayitli bir ogrenci bulunuyor!',
          mevcutOgrenci: {
            ad_soyad: mevcutOgrenci.ogrenci_adi_soyadi,
            sinif: mevcutOgrenci.sinif
          }
        });
      }
    }

    // Ogrenci kaydini ekle
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

    // Otomatik veli hesabi olustur (TC ile giris yapabilsin)
    let veliHesabiMesaji = '';
    if (tc_kimlik_no) {
      const tcTemiz = tc_kimlik_no.toString().replace('.0', '').trim();

      // TC ile mevcut veli hesabi var mi kontrol et
      const mevcutVeli = await dbGet(
        'SELECT id FROM users WHERE username = ? AND user_type = ?',
        [tcTemiz, 'veli']
      );

      if (!mevcutVeli) {
        // Yeni veli hesabi olustur - TC hem kullanici adi hem sifre
        const hashedPassword = await bcrypt.hash(tcTemiz, 10);
        const tempEmail = tcTemiz + '@temp.veli.com';
        await dbRun(
          `INSERT INTO users (username, password_hash, user_type, ad_soyad, telefon, email, created_at)
           VALUES (?, ?, 'veli', ?, ?, ?, datetime('now'))`,
          [tcTemiz, hashedPassword, veli_adi || ogrenci_adi_soyadi + ' Velisi', veli_telefon || telefon, tempEmail]
        );
        veliHesabiMesaji = ' Veli hesabi otomatik olusturuldu (TC: ' + tcTemiz + ')';
        console.log('Otomatik veli hesabi olusturuldu - TC:', tcTemiz);
      }
    }

    res.json({ success: true, message: 'Ogrenci kaydi basariyla eklendi!' + veliHesabiMesaji });
  } catch (error) {
    console.error('Ogrenci kayit ekleme hatasi:', error);
    res.json({ success: false, message: 'Kayit eklenirken bir hata olustu: ' + error.message });
  }
});

// Kurum - Hesapsiz Velileri Kontrol Et
// ESKI TELEFON BAZLI SISTEM KALDIRILDI - SADECE TC BAZLI SISTEM KULLANILIYOR

// Kurum - Veli Giris Bilgisi Getir (ESKI - KALDIRILDI)
app.get('/kurum/veli-giris-bilgisi', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz erisim!' });
  }
  
  try {
    let { telefon } = req.query;
    
    if (!telefon) {
      return res.json({ success: false, message: 'Telefon numarasi gerekli!' });
    }
    
    // Telefon formatini temizle (.0 ile biten)
    telefon = telefon.toString().trim();
    const telefonTemiz = telefon.endsWith('.0') ? telefon.replace('.0', '') : telefon;
    const telefonNokta = telefonTemiz + '.0';
    
    // Veli hesabini bul - hem temiz hem de .0 formatinda ara
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
    
    // Ilk sifre hash'i
    const ilkSifreHash = '$2b$10$';  // bcrypt baslangici
    // Ilk sifre = TC Kimlik No (username) - onemli degisiklik
    let usernameTemizForPassword = veli.username.toString();
    if (usernameTemizForPassword.endsWith('.0')) {
      usernameTemizForPassword = usernameTemizForPassword.replace('.0', '');
    }
    const defaultPassword = usernameTemizForPassword;
    
    // ifre degistirilmis mi kontrol et
    // (Basit kontrol: created_at ile password_hash hash'i ayni zamanda mi olusturulmus)
    // Daha guvenli: password_hash'i "Veli2024!" ile karsilastir
    const sifreDegismis = !await bcrypt.compare(defaultPassword, veli.password_hash);
    
    // Username'deki .0 formatini temizle
    let usernameTemiz = veli.username.toString();
    if (usernameTemiz.endsWith('.0')) {
      usernameTemiz = usernameTemiz.replace('.0', '');
    }
    
    console.log(`\n VELI BILGISI GOSTERILDI`);
    console.log(`   Telefon: ${telefon}`);
    console.log(`   Username (orijinal): ${veli.username}`);
    console.log(`   Username (temiz): ${usernameTemiz}`);
    console.log(`   ifre degismis: ${sifreDegismis ? 'Evet' : 'Hayir'}`);
    
    res.json({
      success: true,
      hesapVar: true,
      username: usernameTemiz,
      sifre: defaultPassword,
      sifreDegismis: sifreDegismis
    });
  } catch (error) {
    console.error('Veli bilgi getirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Ogrenci Kayit Guncelle
app.post('/kurum/ogrenci-kayit-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
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
    
    res.json({ success: true, message: 'Ogrenci kaydi guncellendi!' });
  } catch (error) {
    console.error('Ogrenci kayit guncelleme hatasi:', error);
    res.json({ success: false, message: 'Guncelleme sirasinda bir hata olustu!' });
  }
});

// Kurum - Ogrenci Kayit Sil
app.post('/kurum/ogrenci-kayit-sil/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    const { id } = req.params;

    // Silinecek ogrencinin TC'sini al (veli hesabi kontrolu icin)
    const ogrenci = await dbGet('SELECT tc_kimlik_no FROM ogrenci_kayitlari WHERE id = ?', [id]);
    const tcKimlik = ogrenci?.tc_kimlik_no?.toString().replace('.0', '').trim();

    // Ogrenciyi sil
    await dbRun('DELETE FROM ogrenci_kayitlari WHERE id = ?', [id]);

    // TC varsa, bu TC ile baska ogrenci var mi kontrol et
    let veliSilindi = false;
    if (tcKimlik) {
      const digerOgrenci = await dbGet(
        'SELECT id FROM ogrenci_kayitlari WHERE tc_kimlik_no = ? OR tc_kimlik_no = ?',
        [tcKimlik, tcKimlik + '.0']
      );

      // Baska ogrenci yoksa veli hesabini sil
      if (!digerOgrenci) {
        const veli = await dbGet('SELECT id FROM users WHERE username = ? AND user_type = ?', [tcKimlik, 'veli']);
        if (veli) {
          await dbRun('DELETE FROM users WHERE id = ?', [veli.id]);
          console.log(`Veli hesabi silindi (TC: ${tcKimlik}) - baska ogrencisi kalmadi`);
          veliSilindi = true;
        }
      }
    }

    const mesaj = veliSilindi
      ? 'Ogrenci kaydi ve veli hesabi silindi!'
      : 'Ogrenci kaydi silindi!';
    res.json({ success: true, message: mesaj });
  } catch (error) {
    console.error('Ogrenci kayit silme hatasi:', error);
    res.json({ success: false, message: 'Silme sirasinda bir hata olustu!' });
  }
});

// Kurum - TUM Ogrenci Kayitlarini Sil
app.post('/kurum/ogrenci-kayitlari-tumunu-sil', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    const { onayKodu } = req.body;

    // Guvenlik kontrolu: "SIL" yazmasi gerekiyor
    if (onayKodu !== 'SIL') {
      return res.json({ success: false, message: 'Onay kodu hatali! "SIL" yazmaniz gerekiyor.' });
    }

    // Kac kayit var?
    const kayitSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');

    // Silinecek TC'leri topla (veli hesaplarini silmek icin)
    const tcListesi = await dbAll(`
      SELECT DISTINCT tc_kimlik_no FROM ogrenci_kayitlari
      WHERE tc_kimlik_no IS NOT NULL AND tc_kimlik_no != ''
    `);

    // Tum ogrenci kayitlarini sil
    await dbRun('DELETE FROM ogrenci_kayitlari');

    // Yetim veli hesaplarini sil (artik ogrencisi olmayan)
    let silinenVeliSayisi = 0;
    for (const row of tcListesi) {
      const tc = row.tc_kimlik_no?.toString().replace('.0', '').trim();
      if (tc) {
        const veli = await dbGet('SELECT id FROM users WHERE username = ? AND user_type = ?', [tc, 'veli']);
        if (veli) {
          await dbRun('DELETE FROM users WHERE id = ?', [veli.id]);
          silinenVeliSayisi++;
        }
      }
    }

    console.log(`\n  TUM OGRENCI KAYITLARI SILINDI!`);
    console.log(`   Silinen ogrenci sayisi: ${kayitSayisi.sayi}`);
    console.log(`   Silinen veli hesabi sayisi: ${silinenVeliSayisi}`);
    console.log(`   Yapan kullanici: ${req.session.username}\n`);

    res.json({
      success: true,
      message: `${kayitSayisi.sayi} ogrenci kaydi ve ${silinenVeliSayisi} veli hesabi silindi!`
    });
  } catch (error) {
    console.error('Toplu silme hatasi:', error);
    res.json({ success: false, message: 'Silme islemi sirasinda bir hata olustu!' });
  }
});

// Kurum - Ogrenci Kayitlari Excel Import (Otomatik Veli Hesabi Olusturma ile)
app.post('/kurum/ogrenci-import-excel', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Excel dosyasi secilmedi!' });
    }

    console.log('\nOGRENCi KAYITLARI EXCEL IMPORT BASLADI');
    console.log('Dosya:', req.file.originalname);

    // Excel dosyasini oku
    const data = await readExcelFile(req.file.path);

    if (!data || data.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.json({ success: false, message: 'Excel dosyasi bos veya okunamiyor!' });
    }

    console.log('Toplam ' + data.length + ' satir bulundu');

    let eklenen = 0;
    let hatalar = 0;
    let veliOlusturulan = 0;

    for (const row of data) {
      try {
        // Kolon isimlerini normalize et
        const normalizedRow = {};
        for (const key of Object.keys(row)) {
          const normalKey = key.toString().trim().toUpperCase()
            .replace(/I/g, 'I').replace(/G/g, 'G').replace(/U/g, 'U')
            .replace(/S/g, 'S').replace(/O/g, 'O').replace(/C/g, 'C');
          normalizedRow[normalKey] = row[key];
        }

        // Degerleri al
        const sinif = normalizedRow['OGRENCI SINIF BILGISI'] || normalizedRow['SINIF'] || '';
        const ogrenci_adi_soyadi = normalizedRow['OGRENCI ADI SOYADI'] || normalizedRow['AD SOYAD'] || '';
        const telefon = normalizedRow['TELEFON KAYDI'] || normalizedRow['TELEFON'] || '';
        let tc_kimlik_no = normalizedRow['T.C KIMLIK NO'] || normalizedRow['TC KIMLIK NO'] || normalizedRow['TC'] || '';
        const veli_adi = normalizedRow['OGRENCI VELI'] || normalizedRow['VELI ADI'] || '';
        const veli_telefon = normalizedRow['VELI TELEFON'] || '';
        const tutar = normalizedRow['TUTAR'] || 0;
        const odeme_durumu = normalizedRow['ODEME DURUMU'] || 'BEKLIYOR';
        const odeme_turu = normalizedRow['ODEME TURU'] || '';
        const edessis_kaydi = normalizedRow['EDESIS KAYDI'] || normalizedRow['EDESSIS KAYDI'] || '';
        const taksit = normalizedRow['TAKSIT'] || '';

        // TC'yi temizle (.0 varsa)
        if (tc_kimlik_no) {
          tc_kimlik_no = tc_kimlik_no.toString().replace('.0', '').trim();
        }

        // Ogrenci adini kontrol et
        if (!ogrenci_adi_soyadi || ogrenci_adi_soyadi.toString().trim() === '') {
          continue;
        }

        // Veritabanina ekle
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

        eklenen++;

        // Otomatik veli hesabi olustur
        if (tc_kimlik_no) {
          const mevcutVeli = await dbGet(
            'SELECT id FROM users WHERE username = ? AND user_type = ?',
            [tc_kimlik_no, 'veli']
          );

          if (!mevcutVeli) {
            const hashedPassword = await bcrypt.hash(tc_kimlik_no, 10);
            const tempEmail = tc_kimlik_no + '@temp.veli.com';
            await dbRun(
              `INSERT INTO users (username, password_hash, user_type, ad_soyad, telefon, email, created_at)
               VALUES (?, ?, 'veli', ?, ?, ?, datetime('now'))`,
              [tc_kimlik_no, hashedPassword, veli_adi || ogrenci_adi_soyadi + ' Velisi', veli_telefon || telefon, tempEmail]
            );
            veliOlusturulan++;
          }
        }

      } catch (rowError) {
        console.error('Satir hatasi:', rowError.message);
        hatalar++;
      }
    }

    // Gecici dosyayi sil
    fs.unlinkSync(req.file.path);

    console.log('EXCEL IMPORT TAMAMLANDI: ' + eklenen + ' eklendi, ' + veliOlusturulan + ' veli hesabi olusturuldu');

    res.json({
      success: true,
      message: eklenen + ' ogrenci eklendi, ' + veliOlusturulan + ' veli hesabi otomatik olusturuldu!'
    });

  } catch (error) {
    console.error('Excel import hatasi:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, message: 'Excel yuklenirken hata: ' + error.message });
  }
});

// ESKI: Sinav Sonucu PDF Yukle (kullanilmiyor)
app.post('/kurum/ogrenci-import-excel-eski', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }

  try {
    const { sinav_id, pdfPath } = req.body;
    const isUploaded = !!req.file;
    const sourcePath = isUploaded ? req.file.path : pdfPath;
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sinav ID eksik!' });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi bulunamadi!' });
    }
    console.log('SINAV SONUCU ANALIZ EDILIYOR:', isUploaded && req.file ? req.file.originalname : path.basename(sourcePath));
    console.log('Sinav ID:', sinav_id);
    // PDF\'i yukle
    const pdfBytes = fs.readFileSync(sourcePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(` Toplam sayfa: ${totalPages}`);
    
    // Her sayfayi ayri PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya adi: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join('uploads', 'sinav-sonuclari', sayfaFileName);
      
      // Klasor yoksa olustur
      const dir = path.dirname(sayfaYolu);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`    Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join('uploads', 'sinav-sonuclari', orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // Veritabanina kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // Gecici dosyayi sil
    fs.unlinkSync(req.file.path);
    
    console.log(` PDF basariyla ${totalPages} sayfaya ayrildi!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // Akilli eslestirme (analiz/pattern secimi) ekranina yonlendir
        redirectTo: `/kurum/sinav-sonuc-yukle/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error(' PDF ayirma hatasi:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ESKI SISTEM (Yedek olarak kaliyor)
app.post('/kurum/sinav-sonuc-yukle-analiz', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath } = req.body;
    const isUploaded = !!req.file;
    const sourcePath = isUploaded ? req.file.path : pdfPath;
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sinav ID eksik!' });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi bulunamadi!' });
    }
    console.log('SINAV SONUCU ANALIZ EDILIYOR:', isUploaded && req.file ? req.file.originalname : path.basename(sourcePath));
    console.log('Sinav ID:', sinav_id);
    // PDF\'i yukle
    const pdfBytes = fs.readFileSync(sourcePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(` Toplam sayfa: ${totalPages}`);
    
    // Sadece ilk sayfayi analiz et
    const singlePagePdf = await PDFDocument.create();
    const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [0]);
    singlePagePdf.addPage(copiedPage);
    const singlePageBytes = await singlePagePdf.save();
    
    // Gecici dosya olustur
    const tempFileName = `temp_analyze_sinav_${Date.now()}.pdf`;
    const tempFilePath = path.join('uploads', tempFileName);
    fs.writeFileSync(tempFilePath, singlePageBytes);
    
    // Text cikar - HIBRIT YONTEM
    const extractionResult = await extractTextHybrid(tempFilePath);
    const text = extractionResult.text;
    
    console.log(` Ilk sayfa text uzunlugu: ${text.length} (Yontem: ${extractionResult.method})`);
    
    if (extractionResult.garbled) {
      console.log(' Ilk sayfada encoding sorunu tespit edildi!');
      console.log(' Manuel giris onerilir.');
    }
    
    // Potansiyel isim adaylarini bul - YENI GELIMI SISTEM
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const potansiyelIsimler = [];
    
    console.log(` Analiz: ${lines.length} satir bulundu`);
    
    // 1. GELIMI FILTRELEME: Yeni looksLikeName fonksiyonunu kullan
    for (let i = 0; i < Math.min(lines.length, 80); i++) { // 80 satira cikardik
      const line = lines[i];
      
      // Isim gibi mi kontrol et (yeni fonksiyon)
      if (!looksLikeName(line)) continue;
      
      // Ismi temizle (yeni fonksiyon)
      const cleanLine = cleanExtractedName(line);
      if (!cleanLine || cleanLine.length < 5) continue;
      
      // Kelime sayisi kontrolu
      const words = cleanLine.split(/\s+/);
      const wordCount = words.length;
      
      // Guven seviyesi hesapla
      let confidence = 'medium';
      
      // Sadece harf ve bosluk + 2-3 kelime = yuksek guven
      if (wordCount === 2 || wordCount === 3) {
        confidence = 'high';
      }
      // 4-6 kelime = dusuk guven
      else if (wordCount > 3) {
        confidence = 'low';
      }
      
      potansiyelIsimler.push({
        text: cleanLine,
        lineNumber: i,
        confidence: confidence,
        originalLine: line // Orijinal satiri da sakla
      });
      
      console.log(`    Aday ${potansiyelIsimler.length}: "${cleanLine}" (Satir: ${i}, Guven: ${confidence})`);
    }
    
    // 2. Hic isim bulunamadiysa, en uzun satirlari goster (fallback)
    if (potansiyelIsimler.length === 0) {
      console.log(' Hic isim adayi bulunamadi, en uzun satirlar gosteriliyor...');
      
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
      
      console.log(`    ${potansiyelIsimler.length} uzun satir eklendi (fallback)`);
    }
    
    //  Akilli sistem ile ilk sayfayi test et
    console.log('\n Akilli sistem ile ilk sayfa test ediliyor...');
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
      console.log(` Otomatik pattern bulundu: "${testMatch.extractedName}" (Guven: ${(autoConfidence * 100).toFixed(0)}%)`);
    } else {
      console.log(' Otomatik pattern bulunamadi, manuel secim gerekli');
    }
    
    // Gecici dosyalari temizle
    fs.unlinkSync(tempFilePath);
    
    console.log(` ${potansiyelIsimler.length} potansiyel isim bulundu`);
    potansiyelIsimler.forEach(p => console.log(`   - ${p.text} (satir ${p.lineNumber}, guven: ${p.confidence})`));
    
    res.json({
      success: true,
      data: {
        totalPages: totalPages,
        uploadPath: req.file.path,
        originalName: req.file.originalname,
        sinavId: sinav_id,
        potansiyelIsimler: potansiyelIsimler.slice(0, 15), // Ilk 15 aday
        ornekText: text.substring(0, 500), // Kullaniciya goster
        allLines: lines, // Tum satirlari da gonder (frontend icin)
        autoSelectedPattern: autoSelectedPattern, //  Otomatik secilen pattern
        useAutoMode: autoConfidence >= 0.85 // %85+ guven varsa direkt kullan
      }
    });
    
  } catch (error) {
    console.error('Sonuc analiz hatasi:', error);
    
    // Dosyayi temizle
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Analiz sirasinda bir hata olustu: ' + error.message 
    });
  }
});

// Kurum - Sonuc PDF Kaydet (Tum sayfalari isle, eslestir, kaydet)
app.post('/kurum/sinav-sonuc-yukle-kaydet', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath, selectedPattern, selectedLineNumber, manuelEslesmeler } = req.body;
    
    if (!sinav_id || !pdfPath) {
      return res.status(400).json({ success: false, error: 'Sinav ID veya PDF dosya yolu eksik!' });
    }
    
    console.log('\n AKILLI SINAV SONUCLARI YUKLENIYOR');
    console.log(' Sinav ID:', sinav_id);
    console.log(' PDF Path:', pdfPath);
    console.log(' Mod: Akilli Cascade Matching (5 strateji)');
    
    const results = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let savedCount = 0;
    let strategyStats = {};
    
    // Sinav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'Sinav bulunamadi!' });
    }
    
    // Sonuc klasorunu olustur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // PDF'i yukle
    if (!fs.existsSync(pdfPath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi bulunamadi!' });
    }
    
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(` Toplam sayfa: ${totalPages}`);
    console.log(` Sonuc klasoru: ${sonucKlasoru}`);
    
    // Manuel eslesmeleri map'e cevir (sayfa numarasi  ogrenci ID)
    const manuelMap = {};
    if (manuelEslesmeler && Array.isArray(manuelEslesmeler)) {
      manuelEslesmeler.forEach(m => {
        if (m.sayfaNo && m.ogrenciId) {
          manuelMap[m.sayfaNo] = m.ogrenciId;
        }
      });
      console.log(` ${Object.keys(manuelMap).length} manuel eslesme alindi`);
    }
    
    // Her sayfayi isle
    for (let i = 0; i < totalPages; i++) {
      try {
        const sayfaNo = i + 1;
        console.log(`\n Sayfa ${sayfaNo}/${totalPages} isleniyor...`);
        
        // Bu sayfayi ayri bir PDF olarak olustur
        const singlePagePdf = await PDFDocument.create();
        const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
        singlePagePdf.addPage(copiedPage);
        const singlePageBytes = await singlePagePdf.save();
        
        // Gecici dosya adi olustur
        const tempFileName = `temp_sinav_page_${sayfaNo}_${Date.now()}.pdf`;
        const tempFilePath = path.join('uploads', tempFileName);
        fs.writeFileSync(tempFilePath, singlePageBytes);
        
        // Bu sayfadan text cikar
        const extractionResult = await extractTextHybrid(tempFilePath);
        const text = extractionResult.text;
        const isGarbled = extractionResult.garbled || false;
        
        let ogrenciId = null;
        let ogrenciAdi = 'BILINMEYEN';
        let kaynak = 'kurum';
        let usedStrategy = null;
        let confidence = 0;
        let extractedName = '';
        
        // Manuel eslesme var mi kontrol et
        if (manuelMap[sayfaNo]) {
          // Manuel eslesme var
          ogrenciId = manuelMap[sayfaNo];
          const ogrenci = await dbGet('SELECT * FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          if (ogrenci) {
            ogrenciAdi = ogrenci.ogrenci_adi_soyadi;
            console.log(` Manuel eslesme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            matchedCount++;
            usedStrategy = 'Manuel';
            confidence = 1.0;
          } else {
            console.log(` Manuel eslesme gecersiz! Ogrenci ID ${ogrenciId} bulunamadi.`);
            unmatchedCount++;
          }
        } else {
          //  AKILLI CASCADE MATCHING KULLAN
          const matchResult = await intelligentCascadeMatching(
            text, 
            sinav_id, 
            req.session.userId,
            tempFilePath
          );
          
          if (matchResult && matchResult.confidence >= 0.75) {
            // Basarili eslesme
            ogrenciId = matchResult.ogrenciId;
            ogrenciAdi = matchResult.ogrenciAd;
            kaynak = matchResult.kaynak;
            extractedName = matchResult.extractedName;
            confidence = matchResult.confidence;
            usedStrategy = matchResult.usedStrategy;
            
            // Strateji istatistiklerini guncelle
            strategyStats[usedStrategy] = (strategyStats[usedStrategy] || 0) + 1;
            
            console.log(` Akilli eslesme: ${ogrenciAdi} (Strateji: ${usedStrategy}, Guven: ${(confidence * 100).toFixed(0)}%)`);
            matchedCount++;
          } else {
            // Eslesme basarisiz
            console.log(` Tum stratejiler basarisiz - Manuel gerekli`);
            unmatchedCount++;
          }
        }
        
        // PDF'i kaydet
        const sanitizedName = ogrenciAdi.replace(/[^a-zA-ZcCgiIoOsuU\s]/g, '').replace(/\s+/g, '_');
        const finalFileName = ogrenciId 
          ? `${sayfaNo}_${sanitizedName}_${ogrenciId}.pdf`
          : `${sayfaNo}_BILINMEYEN_${Date.now()}.pdf`;
        
        const finalFilePath = path.join(sonucKlasoru, finalFileName);
        fs.writeFileSync(finalFilePath, singlePageBytes);
        
        console.log(` PDF kaydedildi: ${finalFileName}`);
        
        // Veritabanina kaydet (eger eslesme varsa)
        if (ogrenciId) {
          try {
            // sinav_katilimcilari tablosunu guncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi' 
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [finalFilePath, sinav_id, ogrenciId, kaynak]);
            
            savedCount++;
            console.log(` Veritabanina kaydedildi`);
          } catch (dbError) {
            console.error(` Veritabani kayit hatasi:`, dbError);
          }
        }
        
        // Sonuc listesine ekle
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
        
        // Gecici dosyayi temizle
        fs.unlinkSync(tempFilePath);
        
      } catch (pageError) {
        console.error(` Sayfa ${i + 1} islenirken hata:`, pageError);
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
    
    // Sinavi guncelle (sonuc_yuklendi = 1)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    // Yuklenen PDF dosyasini temizle
    try {
      fs.unlinkSync(pdfPath);
    } catch (cleanError) {
      console.error(' Gecici PDF temizlenemedi:', cleanError);
    }
    
    console.log('\n ILEM TAMAMLANDI!');
    console.log(`   Toplam sayfa: ${totalPages}`);
    console.log(`   Eslesen: ${matchedCount}`);
    console.log(`   Eslesmeyen: ${unmatchedCount}`);
    console.log(`   Kaydedilen: ${savedCount}`);
    console.log(`\n Strateji Istatistikleri:`);
    Object.entries(strategyStats).forEach(([strategy, count]) => {
      console.log(`   ${strategy}: ${count} sayfa`);
    });
    
    res.json({
      success: true,
      message: `${matchedCount}/${totalPages} sayfa otomatik eslestirildi (Akilli Sistem)`,
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
    console.error(' Sonuc kaydetme hatasi:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Kaydetme sirasinda bir hata olustu: ' + error.message 
    });
  }
});

// Kurum - Manuel Sinav Sonuc Eslestirme
app.post('/kurum/sinav-manuel-eslestir/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    const { eslesmeler } = req.body;
    
    if (!eslesmeler || eslesmeler.length === 0) {
      return res.json({ success: false, message: 'Eslestirme bilgisi eksik!' });
    }
    
    console.log(`\n MANUEL ELETIRME (Sinav ID: ${sinavId})`);
    console.log(`   ${eslesmeler.length} adet eslestirme yapilacak`);
    
    let basarili = 0;
    let hatali = 0;
    
    for (const eslesme of eslesmeler) {
      try {
        const { sayfaNo, pdfYolu, ogrenciId, kaynak } = eslesme;
        
        console.log(`    Sayfa ${sayfaNo}:`);
        console.log(`      - Ogrenci ID: ${ogrenciId}`);
        console.log(`      - Kaynak: ${kaynak}`);
        console.log(`      - PDF Yolu: ${pdfYolu}`);
        console.log(`      - Dosya var mi: ${pdfYolu ? fs.existsSync(pdfYolu) : 'PDF yolu bos'}`);
        
        // PDF dosyasini yeni isimle kaydet
        if (pdfYolu && fs.existsSync(pdfYolu)) {
          // Ogrenci bilgilerini al
          let ogrenci;
          if (kaynak === 'veli') {
            ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenciId]);
          } else {
            ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          }
          
          if (ogrenci) {
            // Yeni dosya adi olustur
            const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
            if (!fs.existsSync(sonucKlasoru)) {
              fs.mkdirSync(sonucKlasoru, { recursive: true });
            }
            
            const timestamp = Date.now();
            const safeIsim = ogrenci.ad_soyad.replace(/[^a-zA-ZcCgiIoOsuU\s]/g, '').replace(/\s+/g, '_');
            const yeniDosyaAdi = `${safeIsim}_${timestamp}.pdf`;
            const yeniDosyaYolu = path.join(sonucKlasoru, yeniDosyaAdi);
            
            // Dosyayi kopyala
            fs.copyFileSync(pdfYolu, yeniDosyaYolu);
            
            // sinav_katilimcilari tablosunu guncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi'
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [yeniDosyaYolu, sinavId, ogrenciId, kaynak]);
            
            console.log(`    Basarili: ${ogrenci.ad_soyad}`);
            basarili++;
          } else {
            console.log(`    Ogrenci bulunamadi: ${ogrenciId}`);
            hatali++;
          }
        } else {
          console.log(`    PDF dosyasi bulunamadi: ${pdfYolu}`);
          hatali++;
        }
      } catch (error) {
        console.error(`    Eslestirme hatasi:`, error);
        hatali++;
      }
    }
    
    // Sinavin sonuc_yuklendi durumunu guncelle (ama henuz yayinlanmamis)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1, sonuc_yayinlandi = 0 WHERE id = ?', [sinavId]);
    
    //  GUNCEL ISTATISTIKLERI HESAPLA
    const istatistikler = await dbGet(`
      SELECT 
        COUNT(*) as toplam,
        SUM(CASE WHEN pdf_path IS NOT NULL AND pdf_path != '' THEN 1 ELSE 0 END) as eslesmis,
        SUM(CASE WHEN pdf_path IS NULL OR pdf_path = '' THEN 1 ELSE 0 END) as eslesmemis
      FROM sinav_katilimcilari
      WHERE sinav_id = ?
    `, [sinavId]);
    
    console.log(`\n MANUEL ELETIRME TAMAMLANDI:`);
    console.log(`    Basarili: ${basarili}`);
    console.log(`    Hatali: ${hatali}`);
    console.log(`\n GUNCEL DURUM:`);
    console.log(`   Toplam Katilimci: ${istatistikler.toplam}`);
    console.log(`   Eslesen: ${istatistikler.eslesmis}`);
    console.log(`   Eslesmeyen: ${istatistikler.eslesmemis}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} ogrenci eslestirildi! ${hatali > 0 ? `(${hatali} hata)` : ''}`,
      matchedCount: istatistikler.eslesmis || 0,
      unmatchedCount: istatistikler.eslesmemis || 0,
      totalCount: istatistikler.toplam || 0
    });
  } catch (error) {
    console.error(' Manuel eslestirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!' });
  }
});

//  Kurum - Eslesmemis PDF Sayfalarini Listele
app.get('/kurum/sinav-eslesmemis-pdfler/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\n TUM PDF SAYFALARI LISTELENIYOR (Eslesen + Eslesmeyen):', sinavId);
    
    // TUM yuklenmis PDF'leri al - HEM ELEEN HEM ELEMEYEN
    // pdf_path NULL olanlar = henuz eslesmemis (BILINMEYEN)
    // pdf_path dolu olanlar = eslesmis
    // BILINMEYEN olanlar = PDF var ama ogrenci eslesmemis
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
          ELSE 'BILINMEYEN'
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
          WHEN sk.pdf_path IS NOT NULL AND (ok.ogrenci_adi_soyadi = 'BILINMEYEN' OR o.ad_soyad = 'BILINMEYEN' OR (ok.ogrenci_adi_soyadi IS NULL AND o.ad_soyad IS NULL)) THEN 0
          WHEN sk.pdf_path IS NULL THEN 1
          ELSE 2
        END,
        sk.id
    `, [sinavId]);
    
    // Eslestirilebilir ogrencileri al (tum katilimcilar)
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
    
    // Orijinal PDF yolunu bul - eslesmis herhangi bir ogrencinin PDF'inden al
    let orijinalPdfYolu = null;
    
    // Once sinavlar tablosuna bak
    const sinav = await dbGet('SELECT dosya_yolu FROM sinavlar WHERE id = ?', [sinavId]);
    if (sinav && sinav.dosya_yolu) {
        orijinalPdfYolu = sinav.dosya_yolu;
    } else {
        // Yoksa eslesmis herhangi bir ogrencinin PDF'ini al
        const eslesmisOgrenci = await dbGet(
            'SELECT pdf_path FROM sinav_katilimcilari WHERE sinav_id = ? AND pdf_path IS NOT NULL LIMIT 1',
            [sinavId]
        );
        if (eslesmisOgrenci && eslesmisOgrenci.pdf_path) {
            orijinalPdfYolu = eslesmisOgrenci.pdf_path;
        }
    }
    
    console.log(`    Eslesmemis: ${eslesmemisOgrenciler.length}`);
    console.log(`    Toplam Ogrenci: ${tumOgrenciler.length}`);
    console.log(`    PDF Yolu: ${orijinalPdfYolu}`);
    
    res.json({
      success: true,
      data: {
        eslesmemisPdfler: eslesmemisOgrenciler,
        tumOgrenciler: tumOgrenciler,
        orijinalPdfYolu: orijinalPdfYolu
      }
    });
    
  } catch (error) {
    console.error(' Eslesmemis PDF listeleme hatasi:', error);
    res.json({ success: false, error: error.message });
  }
});

//  Kurum - Mevcut PDF'i Baska Ogrenciye Ata
app.post('/kurum/sinav-pdf-yeniden-eslestir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { katilimci_id, yeni_ogrenci_id, yeni_kaynak, sinav_id } = req.body;
    
    console.log(`\n PDF YENIDEN ELETIRILIYOR`);
    console.log(`   Katilimci ID: ${katilimci_id}`);
    console.log(`   Yeni Ogrenci ID: ${yeni_ogrenci_id}`);
    console.log(`   Yeni Kaynak: ${yeni_kaynak}`);
    
    // Eski katilimcinin PDF yolunu al
    const eskiKatilimci = await dbGet('SELECT pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimci_id]);
    
    if (!eskiKatilimci || !eskiKatilimci.pdf_path) {
      return res.json({ success: false, message: 'PDF bulunamadi!' });
    }
    
    // Yeni ogrenci bilgilerini al
    let yeniOgrenci;
    if (yeni_kaynak === 'kurum') {
      yeniOgrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [yeni_ogrenci_id]);
    } else {
      yeniOgrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [yeni_ogrenci_id]);
    }
    
    if (!yeniOgrenci) {
      return res.json({ success: false, message: 'Ogrenci bulunamadi!' });
    }
    
    // Eski PDF yolunu al
    const eskiPdfPath = eskiKatilimci.pdf_path;
    
    // Yeni dosya adi olustur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    const guvenliIsim = yeniOgrenci.ad_soyad.replace(/[^a-zA-Z0-9gusocIUOC\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // Dosyayi kopyala/tasi
    const eskiTamYol = path.join(__dirname, eskiPdfPath);
    if (fs.existsSync(eskiTamYol)) {
      fs.copyFileSync(eskiTamYol, yeniDosyaYolu);
    }
    
    // Veritabanini guncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    
    // Yeni ogrenci icin kayit olustur/guncelle
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, yeni_ogrenci_id, yeni_kaynak]);
    
    // Eski kaydi temizle (PDF'i kaldir)
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = NULL, sonuc_durumu = 'bekleniyor'
      WHERE id = ?
    `, [katilimci_id]);
    
    // Eski dosyayi sil
    if (fs.existsSync(eskiTamYol)) {
      fs.unlinkSync(eskiTamYol);
    }
    
    console.log(`    PDF basariyla "${yeniOgrenci.ad_soyad}" icin atandi`);
    
    res.json({ 
      success: true, 
      message: ` PDF basariyla "${yeniOgrenci.ad_soyad}" ile eslestirildi!`
    });
    
  } catch (error) {
    console.error(' PDF yeniden eslestirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

//  Kurum - Tek Ogrenci Icin PDF Eslestir
app.post('/kurum/sinav-tek-ogrenci-eslestir', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    const pdfFile = req.file;
    
    if (!pdfFile) {
      return res.json({ success: false, message: 'PDF dosyasi yuklenmedi!' });
    }
    
    console.log(`\n TEK ORENCI ELETIRME`);
    console.log(`   Sinav ID: ${sinav_id}`);
    console.log(`   Ogrenci ID: ${ogrenci_id}`);
    console.log(`   Kaynak: ${kaynak}`);
    console.log(`   PDF: ${pdfFile.filename}`);
    
    // Ogrenci bilgilerini al
    let ogrenci;
    if (kaynak === 'kurum') {
      ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenci_id]);
    } else {
      ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    }
    
    if (!ogrenci) {
      return res.json({ success: false, message: 'Ogrenci bulunamadi!' });
    }
    
    // Sinav klasorunu olustur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sinavKlasoru)) {
      fs.mkdirSync(sinavKlasoru, { recursive: true });
    }
    
    // Dosya adini olustur
    const guvenliIsim = ogrenci.ad_soyad.replace(/[^a-zA-Z0-9gusocIUOC\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // Dosyayi tasi
    fs.copyFileSync(pdfFile.path, yeniDosyaYolu);
    fs.unlinkSync(pdfFile.path); // Gecici dosyayi sil
    
    // Veritabanini guncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, ogrenci_id, kaynak]);
    
    // Sinavin sonuc_yuklendi durumunu guncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`    Basarili: ${ogrenci.ad_soyad} icin PDF eslestirildi`);
    
    res.json({ 
      success: true, 
      message: ` ${ogrenci.ad_soyad} icin sonuc basariyla eslestirildi!`
    });
    
  } catch (error) {
    console.error(' Tek ogrenci eslestirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

//  Kurum - Sinav Sonuclarini Yayinla (Velilere gorunur hale getir)
app.post('/kurum/sinav-sonuclari-yayinla/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\n SINAV SONUCLARI YAYINLANIYOR:', sinavId);
    
    // Sinav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'Sinav bulunamadi!' });
    }
    
    if (!sinav.sonuc_yuklendi) {
      return res.json({ success: false, message: 'Henuz sonuc yuklenmemis!' });
    }
    
    if (sinav.sonuc_yayinlandi) {
      return res.json({ success: false, message: 'Sonuclar zaten yayinlanmis!' });
    }
    
    // Eslesmis sonuc sayisini kontrol et
    const eslesmisler = await dbAll(`
      SELECT COUNT(*) as sayi 
      FROM sinav_katilimcilari 
      WHERE sinav_id = ? AND pdf_path IS NOT NULL
    `, [sinavId]);
    
    const eslesmeSayisi = eslesmisler[0]?.sayi || 0;
    
    if (eslesmeSayisi === 0) {
      return res.json({ success: false, message: 'Hic eslesmis sonuc yok! Lutfen once eslestirme yapin.' });
    }
    
    // Sinavi yayinla
    await dbRun('UPDATE sinavlar SET sonuc_yayinlandi = 1 WHERE id = ?', [sinavId]);
    
    console.log(`    Yayinlandi: ${eslesmeSayisi} sonuc velilere gorunur hale geldi`);
    
    res.json({
      success: true,
      message: 'Sonuclar yayinlandi! ' + eslesmeSayisi + ' ogrencinin velisi artik sonuclari gorebilir.'
    });
    
  } catch (error) {
    console.error(' Yayinlama hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Kurum - Sinav Sonuc WhatsApp Bildirim Gonder
app.post('/kurum/sinav-sonuc-whatsapp-gonder/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sinav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'Sinav bulunamadi!' });
    }
    
    // Sonucu yuklenmis katilimcilari al (hem kurum hem veli ogrencileri)
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
      return res.json({ success: false, message: 'Sonucu yuklenmis ogrenci bulunamadi!' });
    }
    
    console.log(`\n WHATSAPP BILDIRIMLERI GONDERILIYOR`);
    console.log(`   Sinav: ${sinav.ad}`);
    console.log(`   Toplam katilimci: ${katilimcilar.length}\n`);
    
    let basarili = 0;
    let basarisiz = 0;
    
    // Her ogrenci icin veli telefonuna bildirim gonder
    for (const katilimci of katilimcilar) {
      // Veli telefonu oncelikli, yoksa ogrenci telefonu
      const telefon = katilimci.veli_telefon || katilimci.ogrenci_telefon;
      
      console.log(`    ${katilimci.ogrenci_adi} (Veli: ${katilimci.veli_adi || 'Bilinmiyor'})  ${telefon || 'TELEFON YOK'}`);
      
      if (!telefon) {
        console.log(`    ${katilimci.ogrenci_adi} - Telefon numarasi yok!`);
        basarisiz++;
        continue;
      }
      
      // WhatsApp mesajini olustur
      const mesaj = ` Sinav Sonucu Aciklandi

Sayin ${katilimci.veli_adi || 'Veli'},

${katilimci.ogrenci_adi} ogrencinizin sinav sonucu aciklanmistir.

 Sinav: ${sinav.ad}
 Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

 Sonucu goruntulemek icin sisteme giris yapin:
 ${req.protocol}://${req.get('host')}/login

Ã‚Â€Ã‚Â€Ã‚Â€Ã‚Â€Ã‚Â€
 Sinav Merkezi`;
      
      // WhatsApp gonder
      const result = await whatsappBildirimGonder(
        telefon,
        mesaj,
        'sinav_sonuc'
      );
      
      if (result.success) {
        console.log(`    ${katilimci.ogrenci_adi} - ${telefon}`);
        basarili++;
        
        // Bildirim durumunu guncelle
        await dbRun(
          'UPDATE sinav_katilimcilari SET sonuc_durumu = ?, whatsapp_gonderim_tarihi = datetime("now") WHERE id = ?',
          ['bildirildi', katilimci.id]
        );
      } else {
        console.log(`    ${katilimci.ogrenci_adi} - ${telefon} - ${result.message}`);
        basarisiz++;
      }
      
      // API rate limit icin kucuk gecikme
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\n Bildirim gonderimi tamamlandi!`);
    console.log(`   Basarili: ${basarili}`);
    console.log(`   Basarisiz: ${basarisiz}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} bildirim gonderildi, ${basarisiz} basarisiz.`,
      basarili: basarili,
      basarisiz: basarisiz
    });
    
  } catch (error) {
    console.error('WhatsApp bildirim hatasi:', error);
    res.json({ success: false, message: 'Bildirim gonderilirken bir hata olustu!' });
  }
});

// Veli - Sinav Sonuclari
app.get('/veli/sinav-sonuclari', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log(`\n SINAV SONUCLARI (Veli ID: ${req.session.userId}, Username: ${req.session.username})`);
    
    // 1. Veli'nin kendi ekledigi ogrenciler (ogrenciler tablosu)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`   Veli ekledi: ${veliOgrencileri.length} ogrenci`);
    
    // 2. Kurum tarafindan eklenen ogrenciler (TC eslesmesi ile)
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
    console.log(`   Kurum ekledi: ${kurumOgrencileri.length} ogrenci (TC eslestirme)`);
    
    // 3. Iki listeyi birlestir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    console.log(`    TOPLAM: ${ogrenciler.length} ogrenci`);
    
    if (ogrenciler.length === 0) {
      return res.render('veli/sinav-sonuclari', {
        user: { username: req.session.username, type: req.session.userType },
        sonuclar: [],
        ogrenciler: [],
        error: 'Henuz ogrenci kaydiniz bulunmuyor.',
        success: req.session.success
      });
    }
    
    // Veli'nin kendi ekledigi ogrencilerin sonuclari (ogrenciler tablosu)
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
    
    console.log(`    Veli ekledi: ${veliSonuclari.length} sonuc`);
    
    // Kurum tarafindan eklenen ogrencilerin sonuclari (ogrenci_kayitlari tablosu)
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
    
    console.log(`    Kurum ekledi: ${kurumSonuclari.length} sonuc`);
    
    // Iki kaynagi birlestir
    const sonuclar = [...veliSonuclari, ...kurumSonuclari].sort((a, b) => {
      return new Date(b.sinav_tarihi) - new Date(a.sinav_tarihi);
    });
    
    console.log(`    Toplam: ${sonuclar.length} sonuc`);
    
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
    console.error('Sinav sonuclari hatasi:', error);
    req.session.error = 'Sinav sonuclari yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sinav Sonuc PDF Indir
app.get('/veli/sinav-sonuc-indir/:katilimciId', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const katilimciId = req.params.katilimciId;
    
    // Once ogrenci_kaynak'a bak
    const katilimciBilgi = await dbGet('SELECT ogrenci_kaynak, ogrenci_id, pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    if (!katilimciBilgi) {
      return res.status(404).send('Sonuc bulunamadi!');
    }
    
    let yetkiVar = false;
    
    // Kaynak'a gore yetki kontrolu
    if (katilimciBilgi.ogrenci_kaynak === 'veli') {
      // Veli'nin kendi ekledigi ogrenci
      const ogrenci = await dbGet('SELECT veli_id FROM ogrenciler WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && ogrenci.veli_id === req.session.userId;
    } else {
      // Kurum ekledi, veli telefonuyla kontrol
      const user = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      const ogrenci = await dbGet('SELECT veli_telefon FROM ogrenci_kayitlari WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && user && user.telefon === ogrenci.veli_telefon;
    }
    
    if (!yetkiVar) {
      return res.status(403).send('Bu sonuca erisim yetkiniz yok!');
    }
    
    // PDF var mi kontrol et
    if (!katilimciBilgi.pdf_path || !fs.existsSync(katilimciBilgi.pdf_path)) {
      return res.status(404).send('PDF dosyasi bulunamadi!');
    }
    
    // PDF indirme kaydini guncelle
    const simdi = new Date().toISOString();
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET 
        pdf_goruldu = 1,
        pdf_gorunme_tarihi = ?,
        pdf_indirilme_sayisi = COALESCE(pdf_indirilme_sayisi, 0) + 1
      WHERE id = ?
    `, [simdi, katilimciId]);
    
    console.log(`\n PDF INDIRME KAYDI`);
    console.log(`   Katilimci ID: ${katilimciId}`);
    console.log(`   Tarih: ${simdi}`);
    console.log(`   Veli ID: ${req.session.userId}`);
    
    // PDF'i indir
    res.download(katilimciBilgi.pdf_path, path.basename(katilimciBilgi.pdf_path), (err) => {
      if (err) {
        console.error('PDF indirme hatasi:', err);
        res.status(500).send('PDF indirilemedi!');
      }
    });
    
  } catch (error) {
    console.error('PDF indirme hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Veli Profil
app.get('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Talep edilen sinavlari getir
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
    
    // Login hatalarini filtrele - sadece profil ile ilgili hatalari goster
    let error = req.session.error;
    if (error && (error.includes('Kullanici adi veya sifre') || error.includes('sifre hatali'))) {
      error = null; // Login hatalarini gosterme
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
    console.error('Profil hatasi:', error);
    req.session.error = 'Profil yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli Profil Guncelleme
app.post('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, telefon, current_password, new_password } = req.body;
    
    if (!ad_soyad) {
      req.session.error = 'Ad Soyad alani zorunludur';
      res.redirect('/veli/profil');
      return;
    }
    
    // ifre degistirme kontrolu
    if (new_password && new_password.trim() !== '') {
      if (!current_password || current_password.trim() === '') {
        req.session.error = 'ifre degistirmek icin mevcut sifrenizi girmelisiniz!';
        res.redirect('/veli/profil');
        return;
      }
      
      if (new_password.length < 6) {
        req.session.error = 'Yeni sifre en az 6 karakter olmalidir!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Mevcut sifreyi kontrol et
      const kullanici = await dbGet('SELECT password_hash FROM users WHERE id = ?', [req.session.userId]);
      const sifreDogruMu = await bcrypt.compare(current_password, kullanici.password_hash);
      
      if (!sifreDogruMu) {
        req.session.error = 'Mevcut sifreniz yanlis!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Yeni sifreyi hashle
      const yeniSifreHash = await bcrypt.hash(new_password, 10);
      
      // Profil ve sifreyi guncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ?, password_hash = ? WHERE id = ?',
        [ad_soyad, telefon, yeniSifreHash, req.session.userId]
      );
      
      console.log(` Veli sifre degistirdi: User ID ${req.session.userId}`);
      req.session.success = 'Profil bilgileriniz ve sifreniz basariyla guncellendi!';
    } else {
      // Sadece profil bilgilerini guncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ? WHERE id = ?',
        [ad_soyad, telefon, req.session.userId]
      );
      
      req.session.success = 'Profil bilgileriniz basariyla guncellendi!';
    }
    
    res.redirect('/veli/profil');
  } catch (error) {
    console.error('Profil guncelleme hatasi:', error);
    req.session.error = 'Profil guncellenirken bir hata olustu!';
    res.redirect('/veli/profil');
  }
});

// Veli - Ogrenci Ekle (GET)
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
    console.error('Ogrenci ekle sayfasi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Ogrenci Ekle (POST)
app.post('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    
    console.log('Ogrenci ekleme istegi:', { ad_soyad, tc_no, telefon, okul, sinif, veli_id: req.session.userId });
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Ogrenci adi soyadi, okul ve sinif zorunludur!';
      res.redirect('/veli/ogrenci-ekle');
      return;
    }
    
    // Ogrenci numarasi olustur
    const ogrenciNo = await generateOgrenciNo();
    
    // Ogrenci ekle
    const result = await dbRun(
      'INSERT INTO ogrenciler (ad_soyad, tc_no, telefon, okul, sinif, veli_id, ogrenci_no) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ad_soyad, tc_no, telefon, okul, sinif, req.session.userId, ogrenciNo]
    );
    
    console.log('Ogrenci eklendi! ID:', result.lastID, 'Ogrenci No:', ogrenciNo);
    
    req.session.success = `${ad_soyad} basariyla eklendi! Ogrenci No: ${ogrenciNo}`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Ogrenci ekleme hatasi:', error);
    req.session.error = 'Ogrenci eklenirken bir hata olustu: ' + error.message;
    res.redirect('/veli/ogrenci-ekle');
  }
});

// Veli - Ogrenci Duzenle (GET)
app.get('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [req.params.id, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Ogrenci bulunamadi!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Bu ogrenciye yetki verilmis rehber ogretmenleri getir
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
    console.error('Ogrenci duzenle sayfasi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Ogrenci Duzenle (POST)
app.post('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    const ogrenciId = req.params.id;
    
    // Ogrencinin bu veliye ait oldugunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Ogrenci bulunamadi veya size ait degil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Ogrenci adi soyadi, okul ve sinif zorunludur!';
      res.redirect(`/veli/ogrenci-duzenle/${ogrenciId}`);
      return;
    }
    
    // Ogrenci guncelle
    await dbRun(
      'UPDATE ogrenciler SET ad_soyad = ?, tc_no = ?, telefon = ?, okul = ?, sinif = ? WHERE id = ? AND veli_id = ?',
      [ad_soyad, tc_no, telefon, okul, sinif, ogrenciId, req.session.userId]
    );
    
    req.session.success = `${ad_soyad} basariyla guncellendi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Ogrenci guncelleme hatasi:', error);
    req.session.error = 'Ogrenci guncellenirken bir hata olustu!';
    res.redirect(`/veli/ogrenci-duzenle/${req.params.id}`);
  }
});

// Veli - Rehber Ogretmen Yetkisini Kaldir
app.post('/veli/rehber-yetki-kaldir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    console.log('  Yetki kaldirma istegi:', { talepId, veliId: req.session.userId });
    
    // Talebin bu veliye ait oldugunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    console.log(' Talep bulundu:', talep);
    
    if (!talep || talep.veli_id !== req.session.userId) {
      console.log(' Yetki kontrolu basarisiz');
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Talebi sil (yetkiyi kaldir)
    await dbRun('DELETE FROM ogrenci_talepleri WHERE id = ?', [talepId]);
    console.log(' Yetki basariyla kaldirildi');
    
    res.json({ success: true, message: 'Rehber ogretmen yetkisi kaldirildi!' });
  } catch (error) {
    console.error(' Yetki kaldirma hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Veli - Rehber Ogretmen Sinav Sonucu Gorme Yetkisini Degistir
app.post('/veli/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log(' Sonuc yetkisi degistirme istegi:', { talepId, yeniDurum: yeni_durum, veliId: req.session.userId });
    
    // Talebin bu veliye ait oldugunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    if (!talep || talep.veli_id !== req.session.userId) {
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Yetkiyi guncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(` Sinav sonucu gorme yetkisi ${yeni_durum == 1 ? 'acildi' : 'kapatildi'}`);
    res.json({ 
      success: true, 
      message: `Sinav sonucu gorme yetkisi ${yeni_durum == 1 ? 'acildi' : 'kapatildi'}!` 
    });
  } catch (error) {
    console.error('Yetki degistirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Kurum - Rehber Ogretmenler Listesi (Yetki Yonetimi)
app.get('/kurum/rehber-ogretmenler', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
  }
  
  try {
    // Tum onayli talepleri rehber ogretmene gore grupla
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
    
    // Rehber ogretmene gore grupla
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
    console.error('Rehber ogretmen listesi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Rehber Ogretmen Sinav Sonucu Gorme Yetkisini Degistir
app.post('/kurum/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log(' Kurum - Sonuc yetkisi degistirme:', { talepId, yeniDurum: yeni_durum });
    
    // Yetkiyi guncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(` Sinav sonucu gorme yetkisi ${yeni_durum == 1 ? 'acildi' : 'kapatildi'}`);
    res.json({ 
      success: true, 
      message: `Sinav sonucu gorme yetkisi ${yeni_durum == 1 ? 'acildi' : 'kapatildi'}!` 
    });
  } catch (error) {
    console.error('Yetki degistirme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu!' });
  }
});

// Veli - Ogrenci Sil
app.post('/veli/ogrenci-sil/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.id;
    
    // Ogrencinin bu veliye ait oldugunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Ogrenci bulunamadi veya size ait degil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Ogrenciyi sil
    await dbRun('DELETE FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    req.session.success = `${ogrenci.ad_soyad} basariyla silindi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Ogrenci silme hatasi:', error);
    req.session.error = 'Ogrenci silinirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Tum Sinav Takvimi (Tum Ogrenciler)
app.get('/veli/tum-sinav-takvimi', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    // Velinin tum ogrencilerini getir (her iki tablodan)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    const kurumOgrencileri = await dbAll(`
      SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif, tc_kimlik_no as tc_no
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
    `, [req.session.userId]);
    
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    // Her ogrenci icin sinav takvimini getir (her iki kaynaktan)
    let tumTakvim = [];
    try {
      // Veli ekledigi ogrencilerin sinavlari
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
      
      // Kurum ekledigi ogrencilerin sinavlari
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
      
      console.log(`\n Veli Sinav Takvimi (User ID: ${req.session.userId}):`);
      console.log(`   Veli ekledi: ${veliTakvim.length} sinav`);
      console.log(`   Kurum ekledi: ${kurumTakvim.length} sinav`);
      console.log(`   Toplam: ${tumTakvim.length} sinav`);
      if (tumTakvim.length > 0) {
        tumTakvim.forEach(t => {
          console.log(`   - ${t.sinav_adi} | ${t.ogrenci_ad_soyad} | ${t.tarih} (${t.kaynak})`);
        });
      }
    } catch (error) {
      console.log(' Sinav takvimi sorgusu hatasi:', error);
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
    console.error(' Sinav takvimi sayfasi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sinav Takvimi (Tek Ogrenci)
app.get('/veli/sinav-takvimi/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.ogrenci_id;
    
    // Ogrencinin bu veliye ait oldugunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Ogrenci bulunamadi veya size ait degil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Sinav takvimini getir (yeni sistem)
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
      
      console.log(`\n Ogrenci Sinav Takvimi (Ogrenci ID: ${ogrenciId}):`);
      console.log(`   Toplam ${takvim.length} sinav bulundu`);
    } catch (error) {
      console.log(' Sinav takvimi sorgusu hatasi:', error);
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
    console.error(' Sinav takvimi sayfasi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
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
    console.error('Talepler hatasi:', error);
    req.session.error = 'Talepler yuklenirken bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Talep Onayla/Reddet
app.post('/veli/talep/:id/:islem', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { id, islem } = req.params;
    
    const talep = await dbGet('SELECT * FROM ogrenci_talepleri WHERE id = ? AND veli_id = ?', [id, req.session.userId]);
    
    if (!talep) {
      req.session.error = 'Talep bulunamadi!';
      res.redirect('/veli/talepler');
      return;
    }
    
    if (islem === 'onayla') {
      // Talebi onayla - Iliski ogrenci_talepleri tablosunda durum='onaylandi' ile saklanir
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['onaylandi', id]);
      
      // Ogrenci bilgisini al
      const ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [talep.ogrenci_id]);
      
      // Rehber ogretmen bilgisini al
      const rehber = await dbGet('SELECT ad_soyad, brans FROM users WHERE id = ?', [talep.rehber_ogretmen_id]);
      
      req.session.success = `${ogrenci.ad_soyad} icin ${rehber.ad_soyad} (${rehber.brans}) rehber ogretmen talebi onaylandi!`;
    } else if (islem === 'reddet') {
      // Talebi reddet
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['reddedildi', id]);
      
      req.session.success = 'Talep reddedildi!';
    }
    
    res.redirect('/veli/talepler');
  } catch (error) {
    console.error('Talep isleme hatasi:', error);
    req.session.error = 'Talep islenirken bir hata olustu!';
    res.redirect('/veli/talepler');
  }
});

// Veli Dashboard
app.get('/veli/dashboard', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log('===========================================');
    console.log('📊 DASHBOARD YUKLEME');
    console.log('Session User ID:', req.session.userId);
    console.log('Session Username:', req.session.username);
    console.log('Session UserType:', req.session.userType);
    console.log('===========================================');
    
    // Kullanici bilgilerini al (telefon ve TC icin)
    const kullanici = await dbGet('SELECT username, telefon FROM users WHERE id = ?', [req.session.userId]);
    if (!kullanici) {
      req.session.error = 'Kullanici bilgileri bulunamadi!';
      return res.redirect('/login');
    }
    
    // TC kimlik numarasini belirle: once username'i dene, sonra telefon'u
    let tcKimlikNo = req.session.username;
    // Eger username sayisal degilse veya telefon varsa, telefon'u kullan
    if (kullanici.telefon && (!/^\d+$/.test(req.session.username) || req.session.username.length !== 11)) {
      // Telefon numarasindan TC cikar (telefon formati: 5XXXXXXXXX gibi)
      const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
      // Eger telefon 11 haneli ise TC olabilir
      if (telefonTemiz.length === 11) {
        tcKimlikNo = telefonTemiz;
      }
    }
    
    console.log(`🔍 TC Kimlik No: ${tcKimlikNo} (username: ${req.session.username}, telefon: ${kullanici.telefon})`);
    
    // TEK TABLO SISTEMI: Sadece ogrenci_kayitlari tablosundan cek
    // Hem veli_id ile bagli olanlar hem de veli telefonu ile eslesenler
    const ogrenciler = await dbAll(`
      SELECT
        id,
        ogrenci_adi_soyadi as ad_soyad,
        tc_kimlik_no as tc_no,
        sinif,
        veli_id,
        veli_telefon,
        'kurum' as kaynak
      FROM ogrenci_kayitlari
      WHERE veli_id = ? OR veli_telefon = ? OR veli_telefon = ?
    `, [req.session.userId, tcKimlikNo, kullanici.telefon]);
    console.log('Tek tablo sisteminden ' + ogrenciler.length + ' ogrenci bulundu');
    console.log(` TOPLAM ${ogrenciler.length} ogrenci`);
    
    // 4. Istatistikler
    // Tek tablo sistemi - tum ogrenciler kurum kaynagindan
    for (let ogrenci of ogrenciler) {
      const katilimlar = await dbAll(`
        SELECT s.ad AS sinav_adi, s.tarih AS sinav_tarihi, sk.pdf_path
        FROM sinav_katilimcilari sk
        JOIN sinavlar s ON sk.sinav_id = s.id
        WHERE sk.ogrenci_id = ? AND sk.ogrenci_kaynak = 'kurum'
      `, [ogrenci.id]);

      ogrenci.pdf_sonuc_sayisi = katilimlar.filter(k => k.pdf_path).length;
      ogrenci.excel_sonuc_sayisi = 0;
      ogrenci.sinavlar = katilimlar;
    }
    
    // Bekleyen talep sayisini al
    const bekleyenTalepler = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE veli_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    // Yaklasan sinavlar (sinav takvimi henuz kullanilmiyor, bos liste gonder)
    let yaklasanSinavlar = [];
    try {
      yaklasanSinavlar = await dbAll(`
        SELECT * FROM sinav_takvimi 
        WHERE tarih >= date('now') 
        ORDER BY tarih ASC 
        LIMIT 5
      `);
    } catch (sinavErr) {
      console.log(' Sinav takvimi sorgulanamadi (henuz kullanilmiyor)');
      yaklasanSinavlar = [];
    }
    
    console.log(' Dashboard render ediliyor!');
    // Dashboard'da gosterilecek username: Her zaman kullanicinin giris yaptigi username'i goster
    // Kullanici hangi username ile giris yaptiysa, o gosterilmeli
    const displayUsername = req.session.username;
    
    res.render('veli_dashboard', { 
      user: { username: displayUsername, type: req.session.userType },
      ogrenciler: ogrenciler,
      bekleyenTalepSayisi: bekleyenTalepler ? bekleyenTalepler.sayi : 0,
      yaklasanSinavlar: yaklasanSinavlar
    });
  } catch (error) {
    console.error(' Dashboard HATA:', error);
    // Hata durumunda bos listelerle render et (redirect dongusunu onlemek icin)
    // Kullanici bilgilerini tekrar al
    let displayUsername = req.session.username;
    try {
      const kullanici = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      // Eger username 11 haneli bir sayi degilse ve telefon 11 haneli ise, telefon'u goster
      if (!/^\d{11}$/.test(req.session.username) && kullanici && kullanici.telefon) {
        const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
        if (telefonTemiz.length === 11) {
          displayUsername = telefonTemiz;
        }
      }
    } catch (err) {
      console.error('Kullanici bilgisi alinamadi:', err);
    }
    
    res.render('veli_dashboard', { 
      user: { username: displayUsername, type: req.session.userType },
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
    
    // Istatistikler - ONAYLANMI ORENCILER
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
    
    // Sinav sonuclari sayisi (onayli ogrencilerin PDF sonuclari)
    const sinavSonucSayisi = await dbGet(`
      SELECT COUNT(DISTINCT sk.id) as sayi 
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_talepleri t ON sk.ogrenci_id = t.ogrenci_id AND sk.ogrenci_kaynak = 'veli'
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
    `, [req.session.userId]);
    
    // Bekleyen talepler sayisi
    const bekleyenTalepSayisi = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE rehber_ogretmen_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    res.render('rehber_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
      sinavlar: sinavlar,
      istatistikler: {
        ogrenci: ogrenciSayisi?.sayi || 0,
        veli: veliSayisi?.sayi || 0,
        sinavSonucSayisi: sinavSonucSayisi?.sayi || 0,
        bekleyenTalep: bekleyenTalepSayisi?.sayi || 0
      }
    });
  } catch (error) {
    console.error('Dashboard hatasi:', error);
    // Sonsuz donguyu onlemek icin bos veri ile render et
    res.render('rehber_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
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

// Sinav Yukleme
// Rehber - Sinav Yukleme Route'lari KALDIRILDI (Sadece kurum yapabilir)

// Rehber Ogretmen - Sinav Sonuclari
app.get('/rehber/sinav-sonuclari', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Onayli VE yetkisi aktif olan ogrencilerin sinav sonuclarini getir
    // Veli ogrencileri
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
    
    // Kurum ogrencileri icin (ogrenci_kaynak = 'kurum' olanlar)
    // Not: Kurum ogrencileri icin ogrenci_id NULL olabilir, bu durumda ad_soyad ile eslestirme yapilmali
    // imdilik sadece veli ogrencilerini gosteriyoruz
    // TODO: Kurum ogrencileri icin sinav_katilimcilari tablosuna ogrenci_ad_soyad kolonu eklenebilir
    
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
    console.error('Sinav sonuclari hatasi:', error);
    req.session.error = 'Sinav sonuclari yuklenirken bir hata olustu!';
    res.redirect('/rehber/dashboard');
  }
});

// Ogrenci Listesi
app.get('/rehber/ogrenciler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // VELI ORENCILERI (ogrenciler tablosundan)
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
    
    // KURUM ORENCILERI (ogrenci_kayitlari tablosundan - ogrenci_id NULL olanlar)
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
    
    // Birlestir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    res.render('ogrenci_listesi', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenciler: ogrenciler,
      activePage: 'ogrenciler'
    });
  } catch (error) {
    console.error('Ogrenci listesi hatasi:', error);
    req.session.error = 'Ogrenci listesi yuklenirken bir hata olustu!';
    res.redirect('/rehber/dashboard');
  }
});

// Ogrenci Detay/Profil
app.get('/rehber/ogrenci/:ogrenci_id', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Ogrenci bilgileri - VELI TARAFINDAN ONAYLANMI MI KONTROL ET
    const onay = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenciId, req.session.userId, 'onaylandi']
    );
    
    if (!onay) {
      req.session.error = 'Ogrenci bulunamadi veya size ait degil!';
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
      req.session.error = 'Ogrenci bulunamadi!';
      return res.redirect('/rehber/ogrenciler');
    }
    
    // PDF sinav sonuclari
    const pdfSonuclari = await dbAll(`
      SELECT * FROM sinav_sonuclari_pdf
      WHERE ogrenci_id = ?
      ORDER BY sinav_tarihi DESC, created_at DESC
    `, [ogrenciId]);
    
    // Excel/CSV sinav sonuclari
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
    console.error('Ogrenci detay hatasi:', error);
    req.session.error = 'Ogrenci bilgileri yuklenirken bir hata olustu!';
    res.redirect('/rehber/ogrenciler');
  }
});

// Rehber Ogretmen Profili
app.get('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Baska sayfalardan gelen hatalari filtrele - sadece profil ile ilgili hatalari goster
    let error = req.session.error;
    if (error && (
      error.includes('Kullanici adi veya sifre') || 
      error.includes('sifre hatali') ||
      error.includes('Veli listesi yuklenirken') ||
      error.includes('Ogrenci listesi yuklenirken') ||
      error.includes('Sinav sonuclari yuklenirken')
    )) {
      error = null; // Baska sayfalardan gelen hatalari gosterme
    }
    
    res.render('rehber_profil', {
      user: { username: req.session.username, type: req.session.userType },
      kullanici: kullanici,
      error: error,
      success: req.session.success,
      activePage: 'profil'
    });
    
    // Session'daki error ve success'i temizle
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Profil hatasi:', error);
    req.session.error = 'Profil yuklenirken bir hata olustu!';
    res.redirect('/rehber/dashboard');
  }
});

// Profil Guncelleme
app.post('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { ad_soyad, kurum, telefon, brans, mezuniyet } = req.body;
    
    // Zorunlu alanlari kontrol et
    if (!ad_soyad || !kurum || !telefon || !brans) {
      req.session.error = 'Lutfen tum zorunlu alanlari doldurun (Ad Soyad, Kurum, Telefon, Brans)';
      res.redirect('/rehber/profil');
      return;
    }
    
    await dbRun(
      'UPDATE users SET ad_soyad = ?, kurum = ?, telefon = ?, brans = ?, mezuniyet = ? WHERE id = ?',
      [ad_soyad, kurum, telefon, brans, mezuniyet, req.session.userId]
    );
    
    req.session.success = 'Profil bilgileriniz basariyla guncellendi!';
    res.redirect('/rehber/profil');
  } catch (error) {
    console.error('Profil guncelleme hatasi:', error);
    req.session.error = 'Profil guncellenirken bir hata olustu!';
    res.redirect('/rehber/profil');
  }
});

// Veli Iletisim Listesi
app.get('/rehber/veliler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Sadece onaylanmis ogrencilerin velilerini goster
    // Once veli ID'lerini al
    const veliIds = await dbAll(`
      SELECT DISTINCT t.veli_id
      FROM ogrenci_talepleri t
      WHERE t.rehber_ogretmen_id = ?
        AND t.durum = 'onaylandi'
        AND t.veli_id IS NOT NULL
    `, [req.session.userId]);
    
    if (veliIds.length === 0) {
      return res.render('veli_listesi', {
        user: { username: req.session.username, type: req.session.userType },
        veliler: [],
        activePage: 'veliler'
      });
    }
    
    // Her veli icin bilgileri ve ogrenci sayisini al
    const veliler = [];
    for (const veliIdRow of veliIds) {
      const veliId = veliIdRow.veli_id;
      
      // Veli bilgilerini al
      const veli = await dbGet('SELECT id, username, ad_soyad, email, telefon, created_at FROM users WHERE id = ? AND user_type = ?', [veliId, 'veli']);
      
      if (!veli) continue;
      
      // Ogrenci sayisini al
      const ogrenciSayisi = await dbGet(`
        SELECT COUNT(DISTINCT CASE WHEN t.ogrenci_id IS NOT NULL THEN t.ogrenci_id ELSE NULL END) as sayi
        FROM ogrenci_talepleri t
        WHERE t.veli_id = ?
          AND t.rehber_ogretmen_id = ?
          AND t.durum = 'onaylandi'
      `, [veliId, req.session.userId]);
      
      // Ogrenci isimlerini al
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
      
      // Gecersiz email ve telefon formatlarini filtrele
      let email = veli.email;
      if (email && (email.includes('@temp.com') || email.includes('.0@') || email.match(/^\d+\.0@/))) {
        email = null; // Gecersiz email'leri gosterme
      }
      
      let telefon = veli.telefon;
      if (telefon && (telefon.toString().endsWith('.0') || telefon.toString().includes('.0@'))) {
        telefon = null; // Gecersiz telefon formatlarini gosterme
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
    
    // Ad soyad'a gore sirala
    veliler.sort((a, b) => {
      const aAd = (a.ad_soyad || a.username || '').toLowerCase();
      const bAd = (b.ad_soyad || b.username || '').toLowerCase();
      return aAd.localeCompare(bAd);
    });
    
    res.render('veli_listesi', {
      user: { username: req.session.username, type: req.session.userType },
      veliler: veliler || [],
      activePage: 'veliler'
    });
  } catch (error) {
    console.error('Veli listesi hatasi:', error);
    req.session.error = 'Veli listesi yuklenirken bir hata olustu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber Ogretmen - Gelen Talepler
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
    console.error('Rehber talep listesi hatasi:', error);
    req.session.error = 'Talep listesi yuklenirken bir hata olustu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber Ogretmen - Talep Yanitla (Onayla/Reddet)
app.post('/rehber/talep-yanitla', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { talep_id, durum, yanit } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'Gecersiz parametreler!' });
    }
    
    // Talebin bu rehber ogretmene ait oldugunu kontrol et
    const talep = await dbGet(`
      SELECT t.*, u.telefon as veli_telefon, u.ad_soyad as veli_ad_soyad
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      WHERE t.id = ? AND t.rehber_ogretmen_id = ?
    `, [talep_id, req.session.userId]);
    
    if (!talep) {
      return res.json({ success: false, message: 'Talep bulunamadi veya size ait degil!' });
    }
    
    // Talebi guncelle
    await dbRun(`
      UPDATE ogrenci_talepleri 
      SET durum = ?, mesaj = ?
      WHERE id = ? AND rehber_ogretmen_id = ?
    `, [durum, yanit || '', talep_id, req.session.userId]);
    
    // WhatsApp bildirimi gonder (arka planda)
    if (talep.veli_telefon) {
      const mesaj = durum === 'onaylandi' 
        ? ` TALEBINIZ ONAYLANDI!\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
          `Rehber ogretmen talebinizi onayladi.\n\n` +
          ` Ogrenci: ${talep.ad_soyad}\n` +
          (yanit ? ` Rehber Ogretmen Yaniti: ${yanit}\n\n` : '') +
          `Artik rehber ogretmen ogrenciniz hakkinda bilgilere erisebilecektir.`
        : ` TALEBINIZ REDDEDILDI\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'Degerli Velimiz'},\n\n` +
          `Rehber ogretmen talebinizi reddetti.\n\n` +
          ` Ogrenci: ${talep.ad_soyad}\n` +
          (yanit ? ` Rehber Ogretmen Yaniti: ${yanit}\n\n` : '') +
          `Daha fazla bilgi icin lutfen rehber ogretmen ile iletisime geciniz.`;
      
      whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
        .then(result => console.log(' Veli WhatsApp bildirimi gonderildi:', result))
        .catch(error => console.error(' Veli WhatsApp bildirimi hatasi:', error));
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep basariyla onaylandi!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Rehber talep yanitlama hatasi:', error);
    res.json({ success: false, message: 'Talep islenirken bir hata olustu!' });
  }
});

// Ogrenci Ekleme - KALDIRILDI (Rehber ogretmen artik direkt ogrenci ekleyemez, sadece talep gonderebilir)
// app.get('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Ogrenci Arama API - KALDIRILDI (Ogrenci ekleme ozelligi kaldirildi)
// app.post('/rehber/ogrenci-ara', ...) - KALDIRILDI

// Ogrenci Ekleme Talebi Gonder (Rehber -> Veli) - YENI SISTEM
app.post('/rehber/ogrenci-talep', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    console.log('\n TALEP GONDERME ISTEI:', {
      userId: req.session.userId,
      ogrenci_id: req.body.ogrenci_id
    });
    
    // Profil kontrolu
    const kullanici = await dbGet('SELECT ad_soyad, kurum, telefon, brans FROM users WHERE id = ?', [req.session.userId]);
    console.log(' Kullanici Profili:', kullanici);
    
    if (!kullanici.ad_soyad || !kullanici.kurum || !kullanici.telefon || !kullanici.brans) {
      console.log(' Profil eksik!');
      return res.json({ success: false, message: 'Once profil bilgilerinizi eksiksiz doldurmalisiniz!' });
    }
    
    const { ogrenci_id } = req.body;
    
    if (!ogrenci_id) {
      console.log(' Ogrenci ID eksik!');
      return res.json({ success: false, message: 'Ogrenci ID eksik' });
    }
    
    // Ogrenciyi bul
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    console.log('Ã‚ÂŸÃ‚ÂÃ‚Â“ Ogrenci:', ogrenci);
    
    if (!ogrenci) {
      console.log(' Ogrenci bulunamadi!');
      return res.json({ success: false, message: 'Ogrenci bulunamadi' });
    }
    
    // Zaten onaylanmis mi?
    const onayliTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'onaylandi']
    );
    console.log(' Onayli talep kontrolu:', onayliTalep);
    
    if (onayliTalep) {
      console.log(' Zaten kayitli!');
      return res.json({ success: false, message: 'Bu ogrenci zaten size kayitli' });
    }
    
    // Bekleyen talep var mi kontrol et
    const bekleyenTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'beklemede']
    );
    console.log(' Bekleyen talep kontrolu:', bekleyenTalep);
    
    if (bekleyenTalep) {
      console.log(' Zaten bekleyen talep var!');
      return res.json({ success: false, message: 'Bu ogrenci icin zaten bekleyen bir talebiniz var' });
    }
    
    // Talep olustur (Veli onaylayacak) - Baska bransta atanmis olsa bile talep gonderilebilir
    console.log(' Talep olusturuluyor:', {
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
    
    console.log(' Talep basariyla olusturuldu!\n');
    
    res.json({ 
      success: true, 
      message: `${ogrenci.ad_soyad} icin talep veliye gonderildi! Veli onayladiginda bu ogrenciyi gorebilirsiniz.`
    });
  } catch (error) {
    console.error(' Talep gonderme hatasi:', error);
    res.json({ success: false, message: `Talep hatasi: ${error.message}` });
  }
});

// Ogrenci Ekleme POST - KALDIRILDI (Rehber ogretmen artik direkt ogrenci ekleyemez, sadece talep gonderebilir)
// app.post('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Sinav Sonuclari (Excel/CSV)
app.get('/veli/sinav-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Ogrenci kontrolu
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ogrencinin sonuclarina erisim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // Sinav sonuclarini cek
    const sonuclar = await dbAll(`
      SELECT ss.*, s.ad as sinav_adi, s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY ss.created_at DESC
    `, [ogrenciId]);
    
    // Sonuclari sinav bazinda grupla ve JSON parse et
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
    console.error('Sonuc goruntuleme hatasi:', error);
    req.session.error = 'Bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// PDF Sinav Sonuclari
app.get('/veli/pdf-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Ogrenci kontrolu
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ogrencinin sonuclarina erisim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // PDF sinav sonuclarini cek
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
    console.error('PDF sonuc goruntuleme hatasi:', error);
    req.session.error = 'Bir hata olustu!';
    res.redirect('/veli/dashboard');
  }
});

// Sinav Takvimi Sayfasi
app.get('/sinav-takvimi', async (req, res) => {
  try {
    // Tum sinavlari getir (hem tekil hem paket sinavlari)
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
    
    console.log(`\n SINAV TAKVIMI YUKLEME`);
    console.log(`   Toplam Sinav: ${sinavlar.length}`);
    console.log(`   Paket Sinavlari: ${sinavlar.filter(s => s.paket_id).length}`);
    console.log(`   Tekil Sinavlar: ${sinavlar.filter(s => !s.paket_id).length}`);
    
    res.render('sinav-takvimi', {
      title: 'Sinav Takvimi',
      user: req.session.userId ? { 
        username: req.session.username,
        type: req.session.userType 
      } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Sinav takvimi hatasi:', error);
    res.status(500).send('Bir hata olustu: ' + error.message);
  }
});

// ESKI Sinav Paketleri Route - KALDIRILDI (Yeni route satir 729'da)

// ============ DUYURU YONETIMI (KURUM) ============

// Kurum - Duyuru Yonetimi Sayfasi
app.get('/kurum/duyurular', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
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
    console.error('Duyuru yonetimi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - Duyuru Ekle (POST)
app.post('/kurum/duyuru-ekle', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz erisim!' });
  }
  
  try {
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'Baslik zorunludur!' });
    }
    
    await dbRun(
      'INSERT INTO duyurular (baslik, icerik, tarih, sira, aktif) VALUES (?, ?, ?, ?, ?)',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0]
    );
    
    console.log(`\n YENI DUYURU EKLENDI`);
    console.log(`   Baslik: ${baslik}`);
    
    req.session.success = 'Duyuru basariyla eklendi!';
    res.json({ success: true, message: 'Duyuru basariyla eklendi!' });
  } catch (error) {
    console.error('Duyuru ekleme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Kurum - Duyuru Guncelle (POST)
app.post('/kurum/duyuru-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz erisim!' });
  }
  
  try {
    const duyuruId = req.params.id;
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'Baslik zorunludur!' });
    }
    
    await dbRun(
      'UPDATE duyurular SET baslik = ?, icerik = ?, tarih = ?, sira = ?, aktif = ? WHERE id = ?',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0, duyuruId]
    );
    
    console.log(`\n DUYURU GUNCELLENDI`);
    console.log(`   ID: ${duyuruId}`);
    console.log(`   Baslik: ${baslik}`);
    
    req.session.success = 'Duyuru basariyla guncellendi!';
    res.json({ success: true, message: 'Duyuru basariyla guncellendi!' });
  } catch (error) {
    console.error('Duyuru guncelleme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Kurum - Duyuru Sil (POST)
app.post('/kurum/duyuru-sil/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz erisim!' });
  }
  
  try {
    const duyuruId = req.params.id;
    
    await dbRun('DELETE FROM duyurular WHERE id = ?', [duyuruId]);
    
    console.log(`\n DUYURU SILINDI`);
    console.log(`   ID: ${duyuruId}`);
    
    req.session.success = 'Duyuru basariyla silindi!';
    res.json({ success: true, message: 'Duyuru basariyla silindi!' });
  } catch (error) {
    console.error('Duyuru silme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Duyurular Route (Genel - Herkes gorebilir)
app.get('/duyurular', async (req, res) => {
  try {
    const duyurular = await dbAll('SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC');

    res.render('duyurular', {
      title: 'Duyurular',
      user: req.session.userId ? { type: req.session.userType } : null,
      duyurular: duyurular || []
    });
  } catch (error) {
    console.error('Duyurular hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// ============ KURUMSAL SAYFALAR YONETIMI ============

// API - Kurumsal Sayfalar Listesi (Auth gerektirmiyor - dashboard zaten korumali)
app.get('/api/kurumsal-sayfalar', async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    res.json({ success: true, sayfalar: sayfalar });
  } catch (error) {
    console.error('API kurumsal sayfalar hatasi:', error);
    res.status(500).json({ success: false, message: 'Sayfalar yuklenemedi!', error: error.message });
  }
});

// Kurum - Kurumsal Sayfalar Yonetimi
app.get('/kurum/kurumsal-sayfalar', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya erisim yetkiniz yok!');
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
    console.error('Kurumsal sayfalar yonetimi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - Kurumsal Sayfa Guncelle
app.post('/kurum/kurumsal-sayfa-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz erisim!' });
  }
  
  try {
    const sayfaId = req.params.id;
    const { sayfa_adi, baslik, icerik, seo_baslik, seo_aciklama, sira, aktif } = req.body;
    
    if (!sayfa_adi || !baslik) {
      return res.json({ success: false, message: 'Sayfa adi ve baslik zorunludur!' });
    }
    
    console.log('\n KURUMSAL SAYFA GUNCELLEME:');
    console.log(`   ID: ${sayfaId}`);
    console.log(`   Sayfa Adi: ${sayfa_adi}`);
    console.log(`   Baslik: ${baslik}`);
    console.log(`   Icerik: ${icerik ? icerik.substring(0, 100) + '...' : 'BO'}`);
    console.log(`   Icerik Uzunlugu: ${icerik ? icerik.length : 0} karakter`);
    console.log(`   Aktif: ${aktif}`);
    
    await dbRun(
      `UPDATE kurumsal_sayfalar 
       SET sayfa_adi = ?, baslik = ?, icerik = ?, seo_baslik = ?, seo_aciklama = ?, 
           sira = ?, aktif = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [sayfa_adi, baslik, icerik || '', seo_baslik || '', seo_aciklama || '', sira || 0, aktif ? 1 : 0, sayfaId]
    );
    
    console.log('    VERITABANINA KAYDEDILDI!');
    
    res.json({ success: true, message: 'Sayfa basariyla guncellendi!' });
  } catch (error) {
    console.error('Kurumsal sayfa guncelleme hatasi:', error);
    res.json({ success: false, message: 'Bir hata olustu: ' + error.message });
  }
});

// Genel - Kurumsal Sayfalar (Frontend - Dinamik)
app.get('/hakkimizda', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['hakkimizda']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadi!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Hakkimizda hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

app.get('/iletisim', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['iletisim']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadi!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Iletisim hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

app.get('/sinav-merkezleri', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['sinav-merkezleri']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamadi!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('Sinav merkezleri hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// PDF Test Route (Gelistirme/Test icin)
app.get('/test-pdf', (req, res) => {
  res.render('test-pdf', {
    title: 'PDF Test - Sinav Sonucu Parse',
    user: req.session.userId ? { type: req.session.userType } : null
  });
});

// Test PDF Upload Route
app.post('/test-pdf-upload', pdfUpload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Lutfen bir PDF dosyasi yukleyin!' });
    }

    // PDF'i oku
    const dataBuffer = fs.readFileSync(req.file.path);
    
    // PDF'i parse et
    const pdfData = await pdfParse(dataBuffer);
    
    // Text icerigini al
    const text = pdfData.text;
    
    // Ogrenci bilgilerini cikar (regex ile)
    const ogrenciMatch = text.match(/Ogrenci\s+Numara\s+Sinif\s+([^\n]+)\s+(\d+)\s+(\w+)/);
    const puanMatch = text.match(/\s*([\d,]+)/);
    
    // Ders detaylarini cikar
    const dersler = [];
    const dersRegex = /(Turkce|Tarih-1|Cografya-1|Felsefe|Din Kul\. ve Ahl\. Bil\.|Fizik|Kimya|Biyoloji|TYT Fen)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+)/g;
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
      rawText: text.substring(0, 2000) // Ilk 2000 karakter
    };
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('PDF parse hatasi:', error);
    res.status(500).json({ 
      success: false, 
      error: 'PDF parse edilirken hata olustu: ' + error.message 
    });
  }
});

// Cevap Anahtarlari Route
app.get('/cevap-anahtarlari', async (req, res) => {
  try {
    // Cevap anahtari yuklenmis TUM sinavlari al
    const sinavlar = await dbAll(
      `SELECT * FROM sinavlar 
       WHERE cevap_anahtari_pdf IS NOT NULL 
       AND cevap_anahtari_pdf != '' 
       ORDER BY tarih DESC`,
      []
    );
    
    res.render('cevap-anahtarlari', {
      title: 'Cevap Anahtarlari',
      user: req.session.userId ? { type: req.session.userType, username: req.session.username } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Cevap anahtarlari hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Rehber - Toplu Sinav Yukleme KALDIRILDI (Sadece kurum yapabilir)

// Gelismis ogrenci isim eslestirme fonksiyonu
function eslesmeSkoru(isim1, isim2) {
  if (!isim1 || !isim2) return 0;
  
  // Isimleri normalize et
  const normalize = (str) => {
    return str
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/i/g, 'i')
      .replace(/g/g, 'g')
      .replace(/u/g, 'u')
      .replace(/s/g, 's')
      .replace(/o/g, 'o')
      .replace(/c/g, 'c');
  };
  
  const n1 = normalize(isim1);
  const n2 = normalize(isim2);
  
  // Tam eslesme
  if (n1 === n2) return 100;
  
  // Kelime kelime karsilastir
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
  
  // Levenshtein mesafesi ile ince ayar (basit yaklasim)
  if (skor > 50) {
    const uzunlukFarki = Math.abs(n1.length - n2.length);
    return Math.max(0, skor - uzunlukFarki * 2);
  }
  
  return skor;
}

// Sinav katilimcilari icin ozel eslestirme fonksiyonu
async function sinavKatilimciEslestir(pdfOgrenciAdi, sinavId) {
  if (!pdfOgrenciAdi || !sinavId) return null;
  
  // Sadece bu sinava katilan ogrencileri cek
  const katilimcilar = await dbAll(`
    SELECT ok.* 
    FROM ogrenci_kayitlari ok
    INNER JOIN sinav_katilimcilari sk ON ok.id = sk.ogrenci_id
    WHERE sk.sinav_id = ?
  `, [sinavId]);
  
  if (!katilimcilar || katilimcilar.length === 0) return null;
  
  let enIyiEslesme = null;
  let enIyiSkor = 0;
  
  // Isim varyasyonlari olustur (Ad Soyad / Soyad Ad)
  const nameVariations = [pdfOgrenciAdi];
  const parts = pdfOgrenciAdi.trim().split(/\s+/);
  
  if (parts.length === 2) {
    // "BEREN OZCAN"  ["BEREN OZCAN", "OZCAN BEREN"]
    nameVariations.push(`${parts[1]} ${parts[0]}`);
  } else if (parts.length === 3) {
    // "AHMED N AR"  ["AHMED N AR", "AR AHMED N", "N AR AHMED"]
    nameVariations.push(`${parts[2]} ${parts[0]} ${parts[1]}`);
    nameVariations.push(`${parts[1]} ${parts[2]} ${parts[0]}`);
  }
  
  console.log(` "${pdfOgrenciAdi}" icin eslestirme yapiliyor...`);
  console.log(`   Isim varyasyonlari:`, nameVariations);
  
  // Her katilimci icin skor hesapla
  for (const katilimci of katilimcilar) {
    const dbName = (katilimci.ogrenci_adi_soyadi || '').trim().toUpperCase();
    
    for (const variation of nameVariations) {
      const variationUpper = variation.toUpperCase();
      let skor = 0;
      
      // 1. Tam eslesme (100 puan)
      if (dbName === variationUpper) {
        skor = 100;
      }
      // 2. Baslangic eslesmesi (80 puan)
      else if (dbName.startsWith(variationUpper) || variationUpper.startsWith(dbName)) {
        skor = 80;
      }
      // 3. Icerik eslesmesi (60 puan)
      else if (dbName.includes(variationUpper) || variationUpper.includes(dbName)) {
        skor = 60;
      }
      // 4. Kelime bazli eslesme (40 puan)
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
        console.log(`    Yeni en iyi eslesme: "${dbName}" (Skor: ${skor})`);
      }
    }
  }
  
  // Minimum %55 eslesme gerekli
  if (enIyiSkor >= 55) {
    console.log(` En iyi eslesme (${enIyiSkor} puan): "${enIyiEslesme.ogrenci_adi_soyadi}"`);
    return enIyiEslesme;
  } else {
    console.log(` Yeterli eslesme bulunamadi (en yuksek: ${enIyiSkor})`);
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
    if (skor > enYuksekSkor && skor >= 60) { // Minimum %60 eslesme gerekli
      enYuksekSkor = skor;
      enIyiEslesme = ogrenci;
    }
  });
  
  return enIyiEslesme;
}

// YENI: Ilk Sayfa Analizi - Potansiyel Isim Adaylari
// Rehber - Toplu Sinav Analiz KALDIRILDI (Sadece kurum yapabilir)

// Rehber - Toplu Sinav Yukleme KALDIRILDI (Sadece kurum yapabilir)

// ============================================
// KURUMSAL ICERIK YONETIMI (ADMIN PANEL)
// ============================================

// Kurumsal icerik listesi (Admin)
// DEPRECATED: Admin paneli yonlendirmeleri - Artik /kurum/ panelini kullanin
app.get('/admin/kurumsal-icerik', requireAuth, (req, res) => {
  console.log(' ESKI ROUTE: /admin/kurumsal-icerik  /kurum/kurumsal-sayfalar yonlendiriliyor');
  res.redirect('/kurum/kurumsal-sayfalar');
});

app.get('/admin/kurumsal-icerik/duzenle/:id', requireAuth, (req, res) => {
  console.log(` ESKI ROUTE: /admin/kurumsal-icerik/duzenle/${req.params.id}  /kurum/kurumsal-sayfa-duzenle/${req.params.id} yonlendiriliyor`);
  res.redirect(`/kurum/kurumsal-sayfa-duzenle/${req.params.id}`);
});

// DEPRECATED: Admin paneli POST/DELETE route'lari kaldirildi
// Artik /kurum/kurumsal-sayfa-guncelle/:id kullaniliyor

//  YENI SISTEM: Manuel Eslestirme Ekrani
app.get('/kurum/sinav-manuel-eslestirme/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    const sadeceEslesmemis = req.query.sadece_eslesmemis === '1';
    
    // Sinavi al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sinav bulunamadi!');
    }
    
    // Sayfa dosyalarini bul (yeni sistem: sinav_${sinavId} klasorunde)
    const sayfalarDir = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    let sayfalar = [];
    
    if (fs.existsSync(sayfalarDir)) {
      const allFiles = fs.readdirSync(sayfalarDir);
      sayfalar = allFiles
        .filter(f => {
          // Sadece sayfa dosyalarini al (ogrenci_ ile baslayanlari ve orijinal dosyalari haric tut)
          return f.includes('sayfa_') && 
                 f.endsWith('.pdf') && 
                 !f.startsWith('ogrenci_') && 
                 !f.includes('orijinal_');
        })
        .sort((a, b) => {
          // Sayfa numaralarina gore sirala
          const numA = parseInt(a.match(/sayfa_(\d+)_/)?.[1] || '0');
          const numB = parseInt(b.match(/sayfa_(\d+)_/)?.[1] || '0');
          return numA - numB;
        })
        .map(f => {
          const fullPath = path.join(sayfalarDir, f);
          // View icin relative path
          return fullPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
        });
    }
    
    // Eger "sadece eslesmemis" modundaysa, sadece eslesmemis sayfalari filtrele
    if (sadeceEslesmemis) {
      // Hangi sayfalarin eslestigini kontrol et
      const eslesmisKayitlar = await dbAll(`
        SELECT pdf_path FROM sinav_katilimcilari 
        WHERE sinav_id = ? AND pdf_path IS NOT NULL AND pdf_path != ''
      `, [sinavId]);
      
      // Eslesmis sayfa numaralarini bul
      // pdf_path formati: .../ogrenci_ID_sayfa_NUMARA.pdf
      const eslesmisSayfaNumaralari = new Set();
      eslesmisKayitlar.forEach(kayit => {
        if (kayit.pdf_path) {
          // Sayfa numarasini cikar: ogrenci_3237_sayfa_8.pdf -> 8
          const sayfaMatch = kayit.pdf_path.match(/sayfa_(\d+)\.pdf/);
          if (sayfaMatch) {
            eslesmisSayfaNumaralari.add(parseInt(sayfaMatch[1]));
          }
        }
      });
      
      // Sadece eslesmemis sayfalari al
      sayfalar = sayfalar.filter(sayfa => {
        // Sayfa path'inden sayfa numarasini cikar
        // Format: uploads/sinav-sonuclari/sinav_58/sinav_58_sayfa_1_123456.pdf
        const sayfaMatch = sayfa.match(/sayfa_(\d+)_/);
        if (sayfaMatch) {
          const sayfaNo = parseInt(sayfaMatch[1]);
          // Eger bu sayfa numarasi eslesmis sayfalar arasinda yoksa, goster
          return !eslesmisSayfaNumaralari.has(sayfaNo);
        }
        // Eger sayfa numarasi bulunamazsa, goster (guvenlik icin)
        return true;
      });
      
      console.log(`📋 Sadece eslesmemis sayfalar: ${sayfalar.length} (Eslesmis: ${eslesmisSayfaNumaralari.size}, Toplam: ${sayfalar.length + eslesmisSayfaNumaralari.size})`);
    }
    
    // Katilimcilari al (pdf_path ile birlikte - eslesme durumunu kontrol icin)
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
    
    console.log(`\n MANUEL ELETIRME - KATILIMCI LISTESI (Sinav ID: ${sinavId})`);
    console.log(`   Toplam Katilimci: ${katilimcilar.length}`);
    const eslesmisSayisi = katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').length;
    console.log(`   Eslesmis Katilimci: ${eslesmisSayisi}`);
    if (eslesmisSayisi > 0) {
      console.log(`   Eslesmis Ogrenciler:`);
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
    console.error('Manuel eslestirme ekrani hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

//  Eslesenleri Kontrol Et Sayfasi
app.get('/kurum/sinav-eslesen-kontrol/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // Sinavi al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sinav bulunamadi!');
    }
    
    // Eslesmis katilimcilari al (pdf_path dolu olanlar)
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
    
    console.log(`\n ELEEN KONTROL SAYFASI`);
    console.log(`   Sinav ID: ${sinavId}`);
    console.log(`   Eslesmis Sayisi: ${eslesmisler.length}`);
    
    res.render('kurum/sinav-eslesen-kontrol', {
      user: req.session,
      sinav: sinav,
      eslesmisler: eslesmisler
    });
    
  } catch (error) {
    console.error('Eslesen kontrol sayfasi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

//  Eslesmeyi Kaldir
app.post('/kurum/sinav-eslestirme-kaldir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    
    console.log(`\n ELEMEYI KALDIR`);
    console.log(`   Sinav ID: ${sinav_id}`);
    console.log(`   Ogrenci ID: ${ogrenci_id} (${kaynak})`);
    
    // pdf_path'i NULL yap ve sonuc_durumu'nu beklemede'ye cek
    const result = await dbRun(`
      UPDATE sinav_katilimcilari
      SET pdf_path = NULL, sonuc_durumu = 'beklemede'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [sinav_id, ogrenci_id, kaynak]);
    
    console.log(`    Basarili: ${result.changes} satir guncellendi`);
    
    if (result.changes === 0) {
      console.log(`     UYARI: Hicbir satir guncellenmedi!`);
      return res.json({ success: false, error: 'Eslesme bulunamadi!' });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error(' Eslesme kaldirma hatasi:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

//  TOPLU VELI HESABI OLUTURMA
app.post('/kurum/toplu-veli-hesap-olustur', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('\n TOPLU VELI HESABI OLUTURMA BALADI');
    
    // Tum ogrencileri al (sadece kurum ogrencileri - tc_no olanlar)
    const ogrenciler = await dbAll(`
      SELECT id, ogrenci_adi_soyadi, tc_kimlik_no, sinif, telefon, veli_adi, veli_telefon
      FROM ogrenci_kayitlari
      WHERE tc_kimlik_no IS NOT NULL AND tc_kimlik_no != ''
      ORDER BY sinif, ogrenci_adi_soyadi
    `);
    
    console.log(`    ${ogrenciler.length} ogrenci bulundu`);
    
    let olusturulan = 0;
    let mevcutOlanlar = 0;
    let hatalar = 0;
    
    for (const ogrenci of ogrenciler) {
      try {
        // Kontrol et: Bu TC ile kullanici var mi?
        const mevcutUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        if (mevcutUser) {
          mevcutOlanlar++;
          continue;
        }
        
        // ifreyi hashle (ilk sifre = TC)
        const hashedPassword = await bcrypt.hash(ogrenci.tc_kimlik_no, 10);
        
        // Veli hesabi olustur
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

        // ogrenci_kayitlari tablosundaki kaydin veli_id'sini guncelle (tek tablo sistemi)
        await dbRun(`
          UPDATE ogrenci_kayitlari SET veli_id = ? WHERE id = ?
        `, [veliUser.id, ogrenci.id]);

        olusturulan++;
        
      } catch (error) {
        console.error(`    Hata (${ogrenci.ogrenci_adi_soyadi}):`, error.message);
        hatalar++;
      }
    }
    
    console.log(`\n TOPLU VELI HESABI OLUTURMA TAMAMLANDI`);
    console.log(`    Olusturulan: ${olusturulan}`);
    console.log(`     Mevcut olanlar: ${mevcutOlanlar}`);
    console.log(`    Hatalar: ${hatalar}`);
    
    res.json({ 
      success: true, 
      olusturulan, 
      mevcutOlanlar, 
      hatalar,
      toplam: ogrenciler.length
    });
    
  } catch (error) {
    console.error(' Toplu veli hesabi olusturma hatasi:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

//  YENI SISTEM: Sayfa Eslestirme Kaydet
app.post('/kurum/sinav-sayfa-eslestir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, sayfa_yolu, ogrenci_id, kaynak } = req.body;
    
    console.log(`\n TEK SAYFA ELETIRME`);
    console.log(`   Sinav ID: ${sinav_id}`);
    console.log(`   Ogrenci ID: ${ogrenci_id} (${kaynak})`);
    console.log(`   Sayfa Yolu: ${sayfa_yolu}`);
    
    // sinav_katilimcilari tablosunu guncelle
    const result = await dbRun(`
      UPDATE sinav_katilimcilari
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [sayfa_yolu, sinav_id, ogrenci_id, kaynak]);
    
    console.log(`    Basarili: ${result.changes} satir guncellendi`);
    
    if (result.changes === 0) {
      console.log(`     UYARI: Hicbir satir guncellenmedi! WHERE kosulu tutmadi.`);
    }
    
    res.json({ success: true, changes: result.changes });
    
  } catch (error) {
    console.error(' Sayfa eslestirme hatasi:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

//  YENI SISTEM: Yeni Sonuc Yukleme Sayfasi
app.get('/kurum/sinav-sonuc-yukle-yeni/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sinav bulunamadi!');
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
    console.error('Sonuc yukleme sayfasi hatasi:', error);
    res.status(500).send('Bir hata olustu!');
  }
});

// Kurum - PDF Sayfalara Ayir (Yeni Sistem)
app.post('/kurum/sinav-sonuc-yukle-sayfalara-ayir', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id } = req.body;
    
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sinav ID eksik!' });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi yuklenmedi!' });
    }
    
    console.log('📄 PDF sayfalara ayriliyor:', req.file.originalname);
    console.log('📋 Sinav ID:', sinav_id);
    
    // PDF'i yukle
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`📊 Toplam sayfa: ${totalPages}`);
    
    // Sonuc klasorunu olustur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // ESKI SAYFALARI TEMIZLE (yeni PDF yuklenirken)
    // Sadece sayfa dosyalarini sil (ogrenci_ ile baslayanlari ve orijinal dosyalari koru)
    try {
      const existingFiles = fs.readdirSync(sonucKlasoru);
      const oldSayfaFiles = existingFiles.filter(f => 
        f.includes('sayfa_') && f.endsWith('.pdf') && !f.startsWith('ogrenci_')
      );
      
      if (oldSayfaFiles.length > 0) {
        console.log(`🗑️  ${oldSayfaFiles.length} eski sayfa dosyasi temizleniyor...`);
        oldSayfaFiles.forEach(file => {
          try {
            fs.unlinkSync(path.join(sonucKlasoru, file));
          } catch (err) {
            console.warn(`     ${file} silinemedi:`, err.message);
          }
        });
      }
    } catch (cleanupError) {
      console.warn('Eski dosya temizleme hatasi (devam ediliyor):', cleanupError);
    }
    
    // Her sayfayi ayri PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya adi: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join(sonucKlasoru, sayfaFileName);
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`   ✓ Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join(sonucKlasoru, orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // Veritabanina kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // Gecici dosyayi sil
    try {
      fs.unlinkSync(req.file.path);
    } catch (unlinkError) {
      console.warn('Gecici dosya silinemedi:', unlinkError);
    }
    
    console.log(` PDF basariyla ${totalPages} sayfaya ayrildi!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // Akilli eslestirme (analiz/pattern secimi) ekranina yonlendir
        redirectTo: `/kurum/sinav-isim-pattern-secimi/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error(' PDF ayirma hatasi:', error);
    
    // Gecici dosyayi temizle
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Gecici dosya silinemedi:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'PDF sayfalara ayrilirken bir hata olustu!' 
    });
  }
});

// Kurum - Isim Pattern Secimi
app.get('/kurum/sinav-isim-pattern-secimi/:id', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sinav bulunamadi!');
    }
    
    // Ilk PDF sayfasini bul (sayfalara ayrilmis PDF'lerden)
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(404).send('PDF sayfalari bulunamadi! Lutfen once PDF yukleyin.');
    }
    
    // Ilk sayfa PDF'ini bul
    const files = fs.readdirSync(sonucKlasoru);
    const ilkSayfa = files.find(f => f.includes('sayfa_1_') && f.endsWith('.pdf'));
    
    if (!ilkSayfa) {
      return res.status(404).send('Ilk PDF sayfasi bulunamadi!');
    }
    
    const ilkPdfPath = path.join(sonucKlasoru, ilkSayfa);
    
    // View icin relative path (uploads/ ile baslayan kismi al)
    const ilkPdfPathRelative = ilkPdfPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
    
    // Isim adaylarini cikar
    const isimAdaylari = await extractNameCandidates(ilkPdfPath);
    
    res.render('kurum/sinav-isim-pattern-secimi', {
      user: req.session,
      sinavId: sinavId,
      sinav: sinav,
      ilkPdfPath: ilkPdfPathRelative,
      isimAdaylari: isimAdaylari || []
    });
    
  } catch (error) {
    console.error('Isim pattern secimi sayfasi hatasi:', error);
    res.status(500).send('Bir hata olustu: ' + error.message);
  }
});

// Kurum - Otomatik Eslestirme (Pattern Seciminden Sonra)
app.post('/kurum/sinav-otomatik-eslestir-pattern', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const { sinav_id, pattern_index, selected_text } = req.body;
    
    if (!sinav_id || pattern_index === null || !selected_text) {
      return res.status(400).json({ success: false, error: 'Eksik parametreler!' });
    }
    
    console.log('\n🎯 Otomatik Eslestirme Baslatiliyor...');
    console.log('📋 Sinav ID:', sinav_id);
    console.log(' Secilen Pattern:', selected_text);
    
    // Sinav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'Sinav bulunamadi!' });
    }
    
    // Katilimcilari al
    const kurumKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak,
             ok.ogrenci_adi_soyadi as ad_soyad
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
    `, [sinav_id]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak,
             o.ad_soyad
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
    `, [sinav_id]);
    
    const katilimcilar = [
      ...kurumKatilimcilari.map(k => ({ ...k, ogrenci_id: k.ogrenci_id })),
      ...veliKatilimcilari.map(k => ({ ...k, ogrenci_id: k.ogrenci_id }))
    ];
    
    // PDF sayfalarini bul
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(400).json({ success: false, error: 'PDF sayfalari bulunamadi!' });
    }
    
    const files = fs.readdirSync(sonucKlasoru)
      .filter(f => f.includes('sayfa_') && f.endsWith('.pdf'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/sayfa_(\d+)_/)?.[1] || '0');
        const numB = parseInt(b.match(/sayfa_(\d+)_/)?.[1] || '0');
        return numA - numB;
      });
    
    console.log(`📄 ${files.length} sayfa bulundu`);
    
    let eslesen = 0;
    let eslesmeyen = 0;
    const eslesmeler = [];
    
    // Pattern bilgilerini al (isimAdaylari'dan pattern_index ile)
    // Ilk sayfadan pattern bilgisini al
    const ilkSayfaYolu = path.join(sonucKlasoru, files[0]);
    const ilkSayfaText = (await extractTextHybrid(ilkSayfaYolu)).text;
    const ilkSayfaLines = ilkSayfaText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Pattern'deki satir numarasini bul (selected_text'i iceren satir)
    let patternLineNumber = -1;
    for (let i = 0; i < ilkSayfaLines.length; i++) {
      if (ilkSayfaLines[i].includes(selected_text) || selected_text.includes(ilkSayfaLines[i])) {
        patternLineNumber = i;
        break;
      }
    }
    
    // Eger bulunamazsa, pattern_index'i kullan
    if (patternLineNumber === -1 && pattern_index !== null) {
      patternLineNumber = parseInt(pattern_index);
    }
    
    console.log(`📍 Pattern satir numarasi: ${patternLineNumber} (${patternLineNumber >= 0 ? ilkSayfaLines[patternLineNumber] : 'bulunamadi'})`);
    
    // Her sayfayi isle
    for (let i = 0; i < files.length; i++) {
      const sayfaDosyasi = files[i];
      const sayfaYolu = path.join(sonucKlasoru, sayfaDosyasi);
      const sayfaNo = i + 1;
      
      try {
        // PDF'den text cikar
        const extractionResult = await extractTextHybrid(sayfaYolu);
        const text = extractionResult.text;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // Coklu strateji ile isim cikar
        let extractedName = '';
        let extractionMethod = '';
        
        // STRATEJI 1: Pattern satir numarasindan direkt al
        if (patternLineNumber >= 0 && lines[patternLineNumber]) {
          extractedName = lines[patternLineNumber].trim();
          extractionMethod = 'pattern_line';
        }
        
        // STRATEJI 2: selected_text'i iceren satiri bul
        if (!extractedName || extractedName.length < 5) {
          for (const line of lines) {
            const normalizedLine = line.toUpperCase().trim();
            const normalizedSelected = selected_text.toUpperCase().trim();
            
            // Tam eslesme veya kismi eslesme
            if (normalizedLine.includes(normalizedSelected) || 
                normalizedSelected.includes(normalizedLine) ||
                normalizedLine.replace(/\s+/g, '') === normalizedSelected.replace(/\s+/g, '')) {
              extractedName = line.trim();
              extractionMethod = 'text_match';
              break;
            }
          }
        }
        
        // STRATEJI 3: Pattern satirinin yakinindaki satirlari kontrol et (±2 satir)
        if (!extractedName || extractedName.length < 5) {
          if (patternLineNumber >= 0) {
            for (let offset = -2; offset <= 2; offset++) {
              const checkLine = patternLineNumber + offset;
              if (checkLine >= 0 && checkLine < lines.length && lines[checkLine]) {
                const candidate = lines[checkLine].trim();
                // Isim gibi gorunuyor mu? (2-4 kelime, buyuk harf baslangic)
                if (candidate.length >= 8 && candidate.length <= 50) {
                  const words = candidate.split(/\s+/);
                  if (words.length >= 2 && words.length <= 4) {
                    // Ilk kelime buyuk harfle basliyor mu?
                    if (/^[A-ZCGIOSU]/.test(words[0])) {
                      extractedName = candidate;
                      extractionMethod = `pattern_nearby_${offset}`;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
        
        // STRATEJI 4: Ilk 15 satirda isim benzeri pattern ara
        if (!extractedName || extractedName.length < 5) {
          for (let j = 0; j < Math.min(15, lines.length); j++) {
            const candidate = lines[j].trim();
            // Isim pattern'i: 2-4 kelime, her kelime buyuk harfle basliyor
            const namePattern = /^([A-ZCGIOSU][a-zcgiosu]+(?:\s+[A-ZCGIOSU][a-zcgiosu]+){1,3})$/;
            const upperPattern = /^([A-ZCGIOSU]{2,}(?:\s+[A-ZCGIOSU]{2,}){1,3})$/;
            
            if ((namePattern.test(candidate) || upperPattern.test(candidate)) && 
                candidate.length >= 8 && candidate.length <= 50) {
              // Gereksiz kelimeleri kontrol et
              const lower = candidate.toLowerCase();
              if (!lower.includes('ogrenci') && !lower.includes('numara') && 
                  !lower.includes('sinif') && !lower.includes('sonuc')) {
                extractedName = candidate;
                extractionMethod = `early_line_${j}`;
                break;
              }
            }
          }
        }
        
        // Hala bulunamazsa, selected_text'i direkt kullan
        if (!extractedName || extractedName.length < 5) {
          extractedName = selected_text;
          extractionMethod = 'fallback';
        }
        
        if (!extractedName || extractedName.length < 5) {
          console.log(`    Sayfa ${sayfaNo}: Isim cikarilamadi`);
          eslesmeyen++;
          continue;
        }
        
        // Ismi temizle
        const cleanName = cleanExtractedName(extractedName);
        
        if (!cleanName || cleanName.length < 5) {
          console.log(`    Sayfa ${sayfaNo}: Temizlenmis isim cok kisa: "${cleanName}"`);
          eslesmeyen++;
          continue;
        }
        
        // En iyi eslesmeyi bul (threshold'u dusurduk)
        const match = findBestMatch(cleanName, katilimcilar);
        
        // Threshold'u 0.60'a dusurduk (daha fazla eslesme icin)
        if (match && match.similarity >= 0.60) {
          // Eslesme bulundu - kaydet
          const finalPath = path.join(sonucKlasoru, `ogrenci_${match.ogrenci.ogrenci_id}_sayfa_${sayfaNo}.pdf`);
          fs.copyFileSync(sayfaYolu, finalPath);
          
          await dbRun(`
            UPDATE sinav_katilimcilari 
            SET pdf_path = ?, sonuc_durumu = 'yuklendi'
            WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
          `, [finalPath, sinav_id, match.ogrenci.ogrenci_id, match.ogrenci.kaynak]);
          
          eslesen++;
          eslesmeler.push({
            sayfa: sayfaNo,
            ogrenci: match.ogrenci.ad_soyad,
            extracted: cleanName,
            original: extractedName,
            method: extractionMethod,
            confidence: match.similarity
          });
          console.log(`    Sayfa ${sayfaNo}: "${cleanName}" → "${match.ogrenci.ad_soyad}" (${(match.similarity * 100).toFixed(0)}%, ${extractionMethod})`);
        } else {
          console.log(`    Sayfa ${sayfaNo}: "${cleanName}" eslesmedi (en iyi: ${match ? (match.similarity * 100).toFixed(0) + '%' : 'yok'})`);
          eslesmeyen++;
        }
        
      } catch (error) {
        console.error(`Sayfa ${sayfaNo} islenirken hata:`, error);
        eslesmeyen++;
      }
    }
    
    // Sinav durumunu guncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(` Eslestirme tamamlandi: ${eslesen} basarili, ${eslesmeyen} basarisiz`);
    
    res.json({
      success: true,
      data: {
        eslesen,
        eslesmeyen,
        toplam: files.length,
        eslesmeler: eslesmeler.slice(0, 10) // Ilk 10'unu goster
      }
    });
    
  } catch (error) {
    console.error('Otomatik eslestirme hatasi:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Otomatik eslestirme sirasinda bir hata olustu!' 
    });
  }
});

// Isim adaylarini cikaran fonksiyon (autoMatcher.js'den uyarlanmis)
async function extractNameCandidates(pdfPath) {
  try {
    console.log(`\n🔍 Isim adaylari cikariliyor: ${path.basename(pdfPath)}`);
    
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;
    
    const candidates = [];
    const seen = new Set();
    const lines = text.split('\n');
    
    // Tum satirlarda isim ara
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      
      // Pattern 1: Basi buyuk harfli isimler (Ahmet Mehmet Yilmaz)
      const matches1 = line.match(/\b([A-ZCGIOSU][a-zcgiosu]+(?:\s+[A-ZCGIOSU][a-zcgiosu]+){1,2})\b/g);
      if (matches1) {
        matches1.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('ogrenci') && !lower.includes('sinav') && !lower.includes('sonuc') && !lower.includes('numara')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Basi Buyuk Harf',
                lineNumber: lineIndex + 1,
                confidence: 80
              });
            }
          }
        });
      }
      
      // Pattern 2: Tam buyuk harfli isimler (ALI VELI CELIK)
      const matches2 = line.match(/\b([A-ZCGIOSU]{2,}(?:\s+[A-ZCGIOSU]{2,}){1,2})\b/g);
      if (matches2) {
        matches2.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('sonuc') && !lower.includes('sinav') && !lower.includes('belge') && !lower.includes('deneme')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Tam Buyuk Harf',
                lineNumber: lineIndex + 1,
                confidence: 90
              });
            }
          }
        });
      }
    }
    
    // Guvene gore sirala ve ilk 10'u al
    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidates = candidates.slice(0, 10);
    
    console.log(`    ${topCandidates.length} adet isim adayi bulundu`);
    
    return topCandidates;
    
  } catch (error) {
    console.error(' Isim adaylari cikarma hatasi:', error);
    return [];
  }
}

// Kurum - Sinav listesi (koleksiyon sayfas)
app.get('/kurum/sinavlar', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY created_at DESC');
    
    res.render('kurum/sinavlar', {
      user: { username: req.session.username, type: req.session.userType },
      sinavlar: sinavlar,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sinav listesi hatas:', error);
    req.session.error = 'Sinav listesi yklenirken bir hata olustu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Sinav detay
app.get('/kurum/sinav-detay/:id', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      req.session.error = 'Sinav bulunamadi!';
      return res.redirect('/kurum/sinavlar');
    }
    
    // Katlmclar (kurum ve veli)
    const kurumKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak, sk.pdf_path, sk.sonuc_durumu, sk.pdf_goruldu, sk.pdf_gorunme_tarihi, sk.pdf_indirilme_sayisi,
             ok.ogrenci_adi_soyadi as ad_soyad, ok.sinif, ok.telefon, ok.veli_adi
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak, sk.pdf_path, sk.sonuc_durumu, sk.pdf_goruldu, sk.pdf_gorunme_tarihi, sk.pdf_indirilme_sayisi,
             o.ad_soyad, o.sinif, o.telefon, NULL as veli_adi
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    // Snf listesi (renci ekleme filtresi)
    const siniflar = ['1','2','3','4','5','6','7','8','9','10','11','12','Mezun'];
    
    // renci havuzu (kurum + veli) seim listesi iin
    // Zaten eklenmis ogrencileri filtrele
    const mevcutKatilimciKeys = new Set(
      katilimcilar.map(k => `${k.kaynak}_${k.ogrenci_id}`)
    );
    
    const kurumOgrencileri = await dbAll(`SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif FROM ogrenci_kayitlari ORDER BY ad_soyad ASC`);
    const veliOgrencileri = await dbAll(`SELECT id, ad_soyad, sinif FROM ogrenciler ORDER BY ad_soyad ASC`);
    
    // Duplicate kontrolu icin: ayni isim ve sinifa sahip ogrencileri birlestir
    const ogrenciMap = new Map();
    
    // Once kurum ogrencilerini ekle
    kurumOgrencileri
      .filter(o => !mevcutKatilimciKeys.has(`kurum_${o.id}`))
      .forEach(o => {
        const key = `${(o.ad_soyad || '').toLowerCase().trim()}_${(o.sinif || '').trim()}`;
        if (!ogrenciMap.has(key)) {
          ogrenciMap.set(key, { unique_id: `kurum_${o.id}`, ad_soyad: o.ad_soyad, sinif: o.sinif || '', kaynak: 'kurum' });
        }
      });
    
    // Sonra veli ogrencilerini ekle (eger ayni isim ve sinif yoksa)
    veliOgrencileri
      .filter(o => !mevcutKatilimciKeys.has(`veli_${o.id}`))
      .forEach(o => {
        const key = `${(o.ad_soyad || '').toLowerCase().trim()}_${(o.sinif || '').trim()}`;
        if (!ogrenciMap.has(key)) {
          ogrenciMap.set(key, { unique_id: `veli_${o.id}`, ad_soyad: o.ad_soyad, sinif: o.sinif || '', kaynak: 'veli' });
        }
      });
    
    const tumOgrenciler = Array.from(ogrenciMap.values()).sort((a, b) => 
      (a.ad_soyad || '').localeCompare(b.ad_soyad || '')
    );
    
    // Istatistikleri hesapla
    const toplam = katilimcilar.length;
    const eslesmis = katilimcilar.filter(k => k.pdf_path && k.sonuc_durumu !== 'beklemede').length;
    const eslesmemis = toplam - eslesmis;
    const oran = toplam > 0 ? Math.round((eslesmis / toplam) * 100) : 0;
    
    const istatistikler = {
      toplam,
      eslesmis,
      eslesmemis,
      oran
    };
    
    res.render('kurum/sinav-detay', {
      user: { username: req.session.username, type: req.session.userType },
      sinav,
      katilimcilar,
      siniflar,
      tumOgrenciler,
      istatistikler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Sinav detay hatas:', error);
    req.session.error = 'Sinav detaylar yklenirken bir hata olustu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sinav durumu guncelle
app.post('/kurum/sinav-durumu-guncelle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const { sinav_durumu } = req.body || {};

    if (!sinav_durumu) {
      return res.status(400).json({ success: false, message: 'Sinav durumu gerekli!' });
    }

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'Sinav bulunamadi!' });
    }

    await dbRun('UPDATE sinavlar SET sinav_durumu = ? WHERE id = ?', [sinav_durumu, sinavId]);
    return res.json({ success: true, message: 'Sinav durumu guncellendi!' });
  } catch (error) {
    console.error('Sinav durumu guncelleme hatasi:', error);
    return res.status(500).json({ success: false, message: 'Sinav durumu guncellenirken hata olustu!' });
  }
});

// Kurum - Cevap anahtari yukle
app.post('/kurum/cevap-anahtari-yukle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), answerKeyUpload.single('cevapAnahtari'), async (req, res) => {
  try {
    const sinavId = req.params.id;

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'Sinav bulunamadi!' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF dosyasi gerekli!' });
    }

    const relativePath = req.file.path.replace(/^\.?\/?/, '');
    await dbRun('UPDATE sinavlar SET cevap_anahtari_pdf = ? WHERE id = ?', [relativePath, sinavId]);

    return res.json({ success: true, message: 'Cevap anahtari yuklendi!' });
  } catch (error) {
    console.error('Cevap anahtari yukleme hatasi:', error);
    return res.status(500).json({ success: false, message: 'Cevap anahtari yuklenirken hata olustu!' });
  }
});

// Kurum - Sinav ekle
app.post('/kurum/sinav-ekle', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const { ad, tarih, sinif, aciklama } = req.body;
    if (!ad || !tarih) {
      req.session.error = 'Sinav ad ve tarih zorunludur!';
      return res.redirect('/kurum/sinavlar');
    }
    
    await dbRun(
      `INSERT INTO sinavlar (ad, tarih, sinif, aciklama, durum, katilimci_sayisi, sonuc_yuklendi, sonuclar_aciklandi) 
       VALUES (?, ?, ?, ?, 'taslak', 0, 0, 0)`,
      [ad.trim(), tarih, sinif || null, aciklama || null]
    );
    
    req.session.success = 'Sinav eklendi!';
    res.redirect('/kurum/sinavlar');
  } catch (error) {
    console.error('Sinav ekleme hatasi:', error);
    req.session.error = 'Sinav eklenirken bir hata olustu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sinav katilimcisi ekle (coklu)
app.post('/kurum/sinav-katilimci-ekle', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const { sinav_id, ogrenci_ids } = req.body;
    if (!sinav_id || !Array.isArray(ogrenci_ids) || ogrenci_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Sinav veya ogrenci bilgisi eksik!' });
    }
    // Mevcut katilimcilari onbellege al (cift kaydi engelle)
    const mevcut = await dbAll("SELECT ogrenci_id, ogrenci_kaynak FROM sinav_katilimcilari WHERE sinav_id = ?", [sinav_id]);
    const mevcutSet = new Set(mevcut.map(m => `${m.ogrenci_kaynak}_${m.ogrenci_id}`));
    
    // Duplicate kontrolu: ayni ogrenci birden fazla kez secilmisse sadece birini al
    const uniqueOgrenciIds = [...new Set(ogrenci_ids)];
    
    let added = 0;
    let skipped = 0;
    for (const raw of uniqueOgrenciIds) {
      if (!raw || typeof raw !== 'string' || !raw.includes('_')) continue;
      const [kaynak, idStr] = raw.split('_');
      const ogrenciId = parseInt(idStr, 10);
      if (!ogrenciId || (kaynak !== 'kurum' && kaynak !== 'veli')) continue;
      const key = `${kaynak}_${ogrenciId}`;
      if (mevcutSet.has(key)) { skipped++; continue; }
      await dbRun("INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak, sonuc_durumu) VALUES (?, ?, ?, ?)", [sinav_id, ogrenciId, kaynak, 'beklemede']);
      mevcutSet.add(key);
      added++;
    }
    
    // Mevcut duplicate kayitlari temizle (ayni sinav_id, ogrenci_id, ogrenci_kaynak kombinasyonundan sadece birini tut)
    try {
      // Once tum kayitlari al
      const allRecords = await dbAll(`
        SELECT rowid, sinav_id, ogrenci_id, ogrenci_kaynak 
        FROM sinav_katilimcilari 
        WHERE sinav_id = ?
        ORDER BY rowid
      `, [sinav_id]);
      
      // Her kombinasyon icin ilk kaydi tut, digerlerini sil
      const seen = new Set();
      const toDelete = [];
      
      for (const record of allRecords) {
        const key = `${record.sinav_id}_${record.ogrenci_id}_${record.ogrenci_kaynak}`;
        if (seen.has(key)) {
          toDelete.push(record.rowid);
        } else {
          seen.add(key);
        }
      }
      
      // Duplicate kayitlari sil
      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => '?').join(',');
        await dbRun(`DELETE FROM sinav_katilimcilari WHERE rowid IN (${placeholders})`, toDelete);
      }
    } catch (cleanupError) {
      console.error('Duplicate temizleme hatasi (devam ediliyor):', cleanupError);
      // Hata olsa bile devam et
    }
    
    await dbRun("UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?", [sinav_id, sinav_id]);
    
    const message = added > 0 
      ? `${added} ogrenci basariyla eklendi.${skipped > 0 ? ` ${skipped} ogrenci zaten ekliydi.` : ''}`
      : skipped > 0 
        ? `${skipped} ogrenci zaten ekliydi.`
        : 'Hicbir ogrenci eklenemedi.';
    
    res.json({ success: true, added, skipped, message });
  } catch (error) {
    console.error('Sinav katlmc ekleme hatas:', error);
    res.status(500).json({ success: false, error: 'Katlmc eklenemedi!', message: error.message });
  }
});

// Kurum - Sinav katilimci sil
app.post('/kurum/sinav-katilimci-sil/:id', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const katilimciId = req.params.id;
    const kayit = await dbGet('SELECT sinav_id FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    await dbRun('DELETE FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    if (kayit && kayit.sinav_id) {
      await dbRun(
        'UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?',
        [kayit.sinav_id, kayit.sinav_id]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Sinav katlmc silme hatas:', error);
    res.status(500).json({ success: false, error: 'Katlmc silinemedi!' });
  }
});

// Kurum - Sinav sil
app.post('/kurum/sinav-sil/:id', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    await dbRun('DELETE FROM sinavlar WHERE id = ?', [sinavId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Sinav silme hatas:', error);
    res.status(500).json({ success: false, error: 'Sinav silinemedi!' });
  }
});

// ============================================
// KURUM - SITE AYARLARI
// ============================================

// Kurumsal Sayfalar Listesi
app.get('/kurum/kurumsal-sayfalar', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
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
    console.error('Kurumsal sayfalar listesi hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurumsal Sayfa Duzenle (GET)
app.get('/kurum/kurumsal-sayfa-duzenle/:id', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE id = ?', [req.params.id]);
    
    if (!sayfa) {
      req.session.error = 'Sayfa bulunamadi!';
      return res.redirect('/kurum/kurumsal-sayfalar');
    }
    
    res.render('kurum/kurumsal-sayfa-duzenle', {
      user: { username: req.session.username, type: req.session.userType },
      sayfa: sayfa
    });
  } catch (error) {
    console.error('Sayfa duzenle hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/kurum/kurumsal-sayfalar');
  }
});

// Site Ayarlari Sayfasi (GET)
app.get('/kurum/site-ayarlari', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
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
    console.error('Site ayarlari sayfa hatasi:', error);
    req.session.error = 'Sayfa yuklenirken bir hata olustu!';
    res.redirect('/kurum/dashboard');
  }
});

// Site Ayarlari Guncelle (POST)
app.post('/kurum/site-ayarlari', requireAuth, requireRole(['kurum_yonetici', 'kurum_admin']), async (req, res) => {
  try {
    const { site_adi, site_adres, site_telefon, site_email, site_aciklama } = req.body;
    
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adi', site_adi]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adres', site_adres]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_telefon', site_telefon]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_email', site_email]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_aciklama', site_aciklama]);
    
    console.log(' Site ayarlari guncellendi');
    req.session.success = 'Site ayarlari basariyla guncellendi!';
    res.redirect('/kurum/site-ayarlari');
  } catch (error) {
    console.error('Site ayarlari guncelleme hatasi:', error);
    req.session.error = 'Ayarlar guncellenirken bir hata olustu!';
    res.redirect('/kurum/site-ayarlari');
  }
});

// Sunucuyu baslat
// Railway icin 0.0.0.0 kullan (tum network interface'lerde dinle)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(' Sunucu basariyla baslatildi!');
  console.log(` Port: ${PORT}`);
  console.log(` URL: http://0.0.0.0:${PORT}`);
  console.log(` Veritabani: ${DB_PATH}`);
  console.log(` Environment: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log('='.repeat(50));
});

// Error handler for server
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(` Port ${PORT} zaten kullanimda!`);
  } else {
    console.error(' Sunucu baslatma hatasi:', err);
  }
  process.exit(1);
});

// Graceful shutdown
// Rehber - Manuel Eslestirme KALDIRILDI (Sadece kurum yapabilir)

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('Veritabani kapatma hatasi:', err);
    } else {
      console.log('Database connected:', DB_PATH);
    }
    process.exit(0);
  });
});

















