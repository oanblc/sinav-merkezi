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

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');
// SESSION_SECRET - Railway için fallback (production'da mutlaka environment variable kullanın!)
// Railway'de NODE_ENV otomatik production olmayabilir, bu yüzden fallback ekliyoruz
const SESSION_SECRET = process.env.SESSION_SECRET || 'railway-temp-secret-' + Date.now() + '-change-this-in-production';
const ENABLE_ADMIN_RESET = process.env.ENABLE_ADMIN_RESET === 'true';

if (!SESSION_SECRET) {
  console.error('❌ HATA: SESSION_SECRET environment variable is required!');
  console.error('📝 Railway Dashboard → Your Project → Variables → Add:');
  console.error('   Key: SESSION_SECRET');
  console.error('   Value: [güçlü bir secret key - en az 32 karakter]');
  console.error('💡 Örnek: openssl rand -hex 32');
  console.error('⚠️  Production ortamında SESSION_SECRET mutlaka ayarlanmalıdır!');
  process.exit(1);
}

// ============================================
// RAILWAY PROXY CONFIGURATION
// ============================================
// Railway Metal Edge proxy kullanÃƒÂ„Ã‚Â±yor, Express'e gÃƒÂƒÃ‚Â¼venmesini sÃƒÂƒÃ‚Â¶yle
app.set('trust proxy', 1);

// ============================================
// RATE LIMITING - DDoS KORUMASI
// ============================================

// Genel rate limit (tÃƒÂƒÃ‚Â¼m istekler iÃƒÂƒÃ‚Â§in)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 1000, // IP baÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±na maksimum 1000 istek
  message: 'ÃƒÂƒÃ‚Â‡ok fazla istek gÃƒÂƒÃ‚Â¶nderdiniz. LÃƒÂƒÃ‚Â¼tfen 15 dakika sonra tekrar deneyin.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Login rate limit (brute force korumasÃƒÂ„Ã‚Â±)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 5, // IP baÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±na maksimum 5 deneme
  message: 'ÃƒÂƒÃ‚Â‡ok fazla giriÃƒÂ…Ã‚ÂŸ denemesi. LÃƒÂƒÃ‚Â¼tfen 15 dakika sonra tekrar deneyin.',
  skipSuccessfulRequests: true,
});

// File upload rate limit
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 50, // IP baÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±na maksimum 50 upload
  message: 'ÃƒÂƒÃ‚Â‡ok fazla dosya yÃƒÂƒÃ‚Â¼kleme isteÃƒÂ„Ã‚ÂŸi. LÃƒÂƒÃ‚Â¼tfen 1 saat sonra tekrar deneyin.',
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
// WHATSAPP BÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°M SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â°
// ============================================

// WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (Whapi.cloud API kullanarak)
async function whatsappBildirimGonder(telefon, mesaj, bildirimTipi = 'genel') {
  console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â± ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â');
  console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â± WHATSAPP BÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°M - Whapi.cloud');
  console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â± ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â');
  console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â AlÃƒÂ„Ã‚Â±cÃƒÂ„Ã‚Â±: ${telefon}`);
  console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Mesaj: ${mesaj}`);
  console.log(`ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â·ÃƒÂ¯Ã‚Â¸Ã‚Â  Tip: ${bildirimTipi}`);
  console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â± ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â\n');
  
  try {
    // WhatsApp ayarlarınÃƒÂ„Ã‚Â± al
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.api_token) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  WhatsApp API token bulunamadı, sadece log yazÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor');
      
      // Bildirim geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸine kaydet (simÃƒÂƒÃ‚Â¼lasyon)
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
         VALUES (?, ?, ?, 'simulasyon', datetime('now'))`,
        [bildirimTipi, telefon, mesaj]
      );
      
      return { success: true, message: 'Bildirim gÃƒÂƒÃ‚Â¶nderildi (simÃƒÂƒÃ‚Â¼lasyon - API token yok)' };
    }
    
    // Whapi.cloud API'ye istek gÃƒÂƒÃ‚Â¶nder
    const https = require('https');
    const url = require('url');
    
    // Telefon numarasÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± formatla (Whapi.cloud formatÃƒÂ„Ã‚Â±: 905551234567@s.whatsapp.net)
    let formattedPhone = telefon.replace(/[^0-9]/g, ''); // Sadece rakamlar
    if (!formattedPhone.startsWith('90')) {
      formattedPhone = '90' + formattedPhone; // TÃƒÂƒÃ‚Â¼rkiye kodu ekle
    }
    formattedPhone = formattedPhone + '@s.whatsapp.net';
    
    // API URL'ini dÃƒÂƒÃ‚Â¼zelt
    const baseUrl = (ayarlar.api_url || 'https://gate.whapi.cloud').replace(/\/$/, '');
    const apiUrl = `${baseUrl}/messages/text`;
    
    const postData = JSON.stringify({
      to: formattedPhone,
      body: mesaj
    });
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¡ API URL:', apiUrl);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Formatted Phone:', formattedPhone);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¦ POST Data:', postData);
    
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
          console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Whapi.cloud API YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±:', res.statusCode);
          console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¦ Response:', data);
          
          if (res.statusCode === 200 || res.statusCode === 201) {
            // BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â± - Bildirim geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸine kaydet
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, created_at) 
               VALUES (?, ?, ?, 'basarili', datetime('now'))`,
              [bildirimTipi, telefon, mesaj]
            );
            
            resolve({ success: true, message: 'WhatsApp bildirimi başarıyla gÃƒÂƒÃ‚Â¶nderildi!' });
          } else {
            // API hatasÃƒÂ„Ã‚Â±
            const errorMsg = `API Error: ${res.statusCode} - ${data}`;
            console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ', errorMsg);
            
            await dbRun(
              `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
               VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
              [bildirimTipi, telefon, mesaj, errorMsg]
            );
            
            resolve({ success: false, message: 'WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderilemedi', error: errorMsg });
          }
        });
      });
      
      req.on('error', async (error) => {
        console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Whapi.cloud baÃƒÂ„Ã‚ÂŸlantÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
        
        // Hata durumunu kaydet
        try {
          await dbRun(
            `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
             VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
            [bildirimTipi, telefon, mesaj, error.message]
          );
        } catch (logError) {
          console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Bildirim geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸi kayıt hatasÃƒÂ„Ã‚Â±:', logError);
        }
        
        resolve({ success: false, message: 'BaÃƒÂ„Ã‚ÂŸlantÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±', error: error.message });
      });
      
      req.write(postData);
      req.end();
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ WhatsApp bildirim hatasÃƒÂ„Ã‚Â±:', error);
    
    // Hata durumunu kaydet
    try {
      await dbRun(
        `INSERT INTO bildirim_gecmisi (bildirim_tipi, alici_telefon, mesaj, durum, hata_mesaji, created_at) 
         VALUES (?, ?, ?, 'basarisiz', ?, datetime('now'))`,
        [bildirimTipi, telefon, mesaj, error.message]
      );
    } catch (logError) {
      console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Bildirim geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸi kayıt hatasÃƒÂ„Ã‚Â±:', logError);
    }
    
    return { success: false, message: 'Bildirim gÃƒÂƒÃ‚Â¶nderilemedi', error: error.message };
  }
}

// Yeni talep bildirimi oluştur
function talepBildirimMesaji(veli, sinav) {
  return `ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â” YENÃƒÂ„Ã‚Â° SINAV TALEBÃƒÂ„Ã‚Â°

ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Veli: ${veli.ad_soyad}
ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Telefon: ${veli.telefon}
ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â§ E-posta: ${veli.email}

ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš Sınav: ${sinav.ad}
ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â° Fiyat: ${sinav.fiyat} TL
ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

ÃƒÂ¢Ã‚ÂÃ‚Â±ÃƒÂ¯Ã‚Â¸Ã‚Â  Talep ZamanÃƒÂ„Ã‚Â±: ${new Date().toLocaleString('tr-TR')}

LÃƒÂƒÃ‚Â¼tfen bu talebi deÃƒÂ„Ã‚ÂŸerlendirin ve yanÃƒÂ„Ã‚Â±tlayÃƒÂ„Ã‚Â±n.`;
}

// ============================================
// GELIÃƒÂ…Ã‚ÂMIÃƒÂ…Ã‚Â PDF TEXT EXTRACTION
// ============================================

// Bozuk text tespit et
function isGarbledText(text) {
  if (!text || text.length === 0) return true;
  
  // 1. AynÃƒÂ„Ã‚Â± karakterin 10+ kez tekrarÃƒÂ„Ã‚Â± (DYBNDYBNDYBN...)
  if (text.match(/(.)\1{9,}/)) {
    console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Tespit: Tekrarlayan karakter paterni');
    return true;
  }
  
  // 2. 2-3 karakterlik tekrar (DYBN DYBN DYBN...)
  if (text.match(/(.{2,4})\1{5,}/)) {
    console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Tespit: Tekrarlayan string paterni');
    return true;
  }
  
  // 3. ÃƒÂƒÃ‚Â‡ok az sesli harf (encoding sorunlarÃƒÂ„Ã‚Â±nda sesliler kaybolur)
  const vowelCount = (text.match(/[AEIOUÃƒÂƒÃ‚ÂœÃƒÂƒÃ‚Â–IÃƒÂ„Ã‚Â°aeÃƒÂ„Ã‚Â±ouÃƒÂƒÃ‚Â¼ÃƒÂƒÃ‚Â¶]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars > 50 && vowelCount / totalChars < 0.15) {
    console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Tespit: ÃƒÂƒÃ‚Â‡ok az sesli harf (${vowelCount}/${totalChars})`);
    return true;
  }
  
  return false;
}

// Alternatif PDF okuma (ÃƒÂ…Ã‚ÂŸimdilik devre dÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â± - gelecekte OCR eklenebilir)
async function extractTextWithAlternative(pdfPath) {
  console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Alternatif extraction ÃƒÂ…Ã‚ÂŸu anda desteklenmiyor');
  console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¡ PDF\'i farklÃƒÂ„Ã‚Â± formatta export edin veya manuel giriÃƒÂ…Ã‚ÂŸ kullanÃƒÂ„Ã‚Â±n');
  return null;
}

// Hibrit extraction: ÃƒÂƒÃ‚Â–nce pdf-parse, bozuksa PDF.js
async function extractTextHybrid(pdfPath) {
  // 1. ÃƒÂƒÃ‚Â–nce pdf-parse dene
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const text1 = data.text;
  
  // Bozuk mu kontrol et
  if (!isGarbledText(text1)) {
    console.log('   ÃƒÂ¢Ã‚ÂœÃ‚Â… pdf-parse başarılı');
    return { text: text1, method: 'pdf-parse' };
  }
  
  console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â pdf-parse bozuk text ÃƒÂƒÃ‚Â¼retti');
  
  // 2. Alternatif yÃƒÂƒÃ‚Â¶ntem dene (ÃƒÂ…Ã‚ÂŸimdilik sadece uyarÃƒÂ„Ã‚Â±)
  await extractTextWithAlternative(pdfPath);
  
  // 3. Bozuk text ile devam et ama iÃƒÂ…Ã‚ÂŸaretle
  console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Bozuk text ile devam ediliyor - Manuel kontrol gerekli');
  return { text: text1, method: 'pdf-parse-garbled', garbled: true };
}

// ============================================
// AKILLI EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â° - YARDIMCI FONKSÃƒÂ„Ã‚Â°YONLAR
// ============================================

/**
 * ÃƒÂ„Ã‚Â°sim gibi gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼yor mu kontrol et
 */
function looksLikeName(line) {
  // ÃƒÂƒÃ‚Â–nce ismi rakamlardan ayÃƒÂ„Ã‚Â±r (ÃƒÂƒÃ‚Â¶rn: "ALÃƒÂ„Ã‚Â° OSMAN ÃƒÂƒÃ‚Â‡ÃƒÂƒÃ‚Â–ZELÃƒÂ„Ã‚Â°08-A" ÃƒÂ¢Ã‚Â†Ã‚Â’ "ALÃƒÂ„Ã‚Â° OSMAN ÃƒÂƒÃ‚Â‡ÃƒÂƒÃ‚Â–ZELÃƒÂ„Ã‚Â°")
  const cleanedLine = line.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  const words = cleanedLine.split(/\s+/);
  const wordCount = words.length;
  
  // Kelime sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± kontrolÃƒÂƒÃ‚Â¼ (daha esnek)
  if (wordCount < 2 || wordCount > 6) return false;
  
  // Uzunluk kontrolÃƒÂƒÃ‚Â¼ (daha esnek)
  if (cleanedLine.length < 5 || cleanedLine.length > 60) return false;
  
  // TÃƒÂƒÃ‚Â¼rkÃƒÂƒÃ‚Â§e harfler kontrolÃƒÂƒÃ‚Â¼
  if (!cleanedLine.match(/^[A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœa-zÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±ÃƒÂƒÃ‚Â¶ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼\s]+$/)) return false;
  
  // Blacklist: BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k kelimeleri (daha kapsamlÃƒÂ„Ã‚Â±)
  if (cleanedLine.match(/BELGESÃƒÂ„Ã‚Â°|SINAV|SONUÃƒÂƒÃ‚Â‡|PUAN|OKUL|DERS|NET|DOÃƒÂ„Ã‚ÂRU|YANLIÃƒÂ…Ã‚Â|BOÃƒÂ…Ã‚Â|SIRA|ORTALAMA|ÃƒÂ„Ã‚Â°LÃƒÂƒÃ‚Â‡E|KURUM|LÃƒÂ„Ã‚Â°SE|ORTAOKUL|DENEME|NUMARA|GENEL|DERECE|KATILIM|BAÃƒÂ…Ã‚ÂARI|ANALÃƒÂ„Ã‚Â°Z|CEVAP|SORU/i)) return false;
  
  // En az bir boÃƒÂ…Ã‚ÂŸluk olmalÃƒÂ„Ã‚Â± (ad-soyad)
  if (!cleanedLine.includes(' ')) return false;
  
  return true;
}

/**
 * ÃƒÂ„Ã‚Â°smi temizle (rakamlarÃƒÂ„Ã‚Â± ve ÃƒÂƒÃ‚Â¶zel karakterleri kaldÃƒÂ„Ã‚Â±r)
 */
function cleanExtractedName(name) {
  if (!name) return '';
  
  // 1. ÃƒÂƒÃ‚Â–nce sondaki rakam-harf kombinasyonlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizle (08-A, 123, vs)
  let clean = name.replace(/\d+[-]?[A-Z]?$/g, '').trim();
  
  // 2. TÃƒÂƒÃ‚Â¼m rakamlarÃƒÂ„Ã‚Â± temizle
  clean = clean.replace(/\d+/g, '');
  
  // 3. ÃƒÂƒÃ‚Â–zel karakterleri temizle (TÃƒÂƒÃ‚Â¼rkÃƒÂƒÃ‚Â§e harfler hariÃƒÂƒÃ‚Â§)
  clean = clean.replace(/[^\wÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚ÂœÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±ÃƒÂƒÃ‚Â¶ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼\s]/g, '');
  
  // 4. BaÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±ndaki/sonundaki gereksiz kelimeleri temizle
  clean = clean.replace(/^(Öğrenci|ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â°|Ogrenci|OGRENCI|Ad|AD|Adı|ADI|Soyad|SOYAD|Soyadı|SOYADI)\s*/gi, '');
  clean = clean.replace(/\s*(Numara|NUMARA|SÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f|SINIF|SÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±fÃƒÂ„Ã‚Â±|SINIFI)$/gi, '');
  
  // 5. Fazla boÃƒÂ…Ã‚ÂŸluklarÃƒÂ„Ã‚Â± temizle
  clean = clean.replace(/\s+/g, ' ').trim();
  
  // 6. BÃƒÂƒÃ‚Â¼yÃƒÂƒÃ‚Â¼k harfe ÃƒÂƒÃ‚Â§evir
  clean = clean.toUpperCase();
  
  // 7. ÃƒÂƒÃ‚Â‡ok kÃƒÂ„Ã‚Â±sa veya ÃƒÂƒÃ‚Â§ok uzunsa geÃƒÂƒÃ‚Â§ersiz
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
 * String benzerliÃƒÂ„Ã‚ÂŸi hesapla (0-1 arasÃƒÂ„Ã‚Â±, 1 = tam eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme)
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
 * En iyi eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeyi bul
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
  
  // Threshold'u düşürdük (0.60) - daha fazla eşleşme için
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
      cb(new Error('Sadece PDF dosyasÃƒÂ„Ã‚Â± yÃƒÂƒÃ‚Â¼kleyebilirsiniz!'), false);
    }
  }
});

// Cevap anahtarı upload (ayrı klasör)
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
      cb(new Error('Sadece PDF dosyası yükleyebilirsiniz!'), false);
    }
  }
});

// VeritabanÃƒÂ„Ã‚Â± baÃƒÂ„Ã‚ÂŸlantÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('VeritabanÃƒÂ„Ã‚Â± baÃƒÂ„Ã‚ÂŸlantÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', err);
  } else {
    console.log('Database connected:', DB_PATH);
  }
});

// VeritabanÃƒÂ„Ã‚Â± tablolarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± oluştur
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
  
  // Mevcut veritabanÃƒÂ„Ã‚Â±na yeni sÃƒÂƒÃ‚Â¼tunlarÃƒÂ„Ã‚Â± ekle (eÃƒÂ„Ã‚ÂŸer yoksa)
  db.run(`ALTER TABLE users ADD COLUMN ad_soyad TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN kurum TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  // Veli ilk giriÃƒÂ…Ã‚ÂŸ kontrolÃƒÂƒÃ‚Â¼ iÃƒÂƒÃ‚Â§in password_changed kolonu
  db.run(`ALTER TABLE users ADD COLUMN password_changed INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN brans TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN uzmanlik_alani TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN mezuniyet TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE users ADD COLUMN profil_foto TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
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
  
  // Mevcut veritabanÃƒÂ„Ã‚Â±na yeni sÃƒÂƒÃ‚Â¼tunlarÃƒÂ„Ã‚Â± ekle
  db.run(`ALTER TABLE ogrenciler ADD COLUMN telefon TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN okul TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN sinif TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE ogrenciler ADD COLUMN ogrenci_no TEXT UNIQUE`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
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
  
  // SatÃƒÂ„Ã‚Â±nalma tablosuna PayTR kolonlarÃƒÂ„Ã‚Â± ekle
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
  
  // Mevcut sinavlar tablosuna yeni kolonlarÃƒÂ„Ã‚Â± ekle (eÃƒÂ„Ã‚ÂŸer yoksa)
  db.run(`ALTER TABLE sinavlar ADD COLUMN durum TEXT DEFAULT 'taslak'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â durum kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuclar_aciklandi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â sonuclar_aciklandi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN katilimci_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â katilimci_sayisi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sonuc_yuklendi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â sonuc_yuklendi kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN cevap_anahtari_pdf TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â cevap_anahtari_pdf kolonu zaten var veya hata:', err.message);
  });
  db.run(`ALTER TABLE sinavlar ADD COLUMN sinav_durumu TEXT DEFAULT 'BaÃƒÂ…Ã‚ÂŸvuru aÃƒÂ…Ã‚ÂŸamasÃƒÂ„Ã‚Â±nda'`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â sinav_durumu kolonu zaten var veya hata:', err.message);
  });
  
  // Sınav KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â± Tablosu (Sınav-Öğrenci ÃƒÂ„Ã‚Â°liÃƒÂ…Ã‚ÂŸkisi + PDF Sonuçları)
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
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ogrenci_kaynak kolonu zaten var veya hata:', err.message);
  });
  
  // PDF gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼ntÃƒÂƒÃ‚Â¼lenme takibi iÃƒÂƒÃ‚Â§in kolonlar ekle
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_goruldu INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â pdf_goruldu kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_gorunme_tarihi DATETIME`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â pdf_gorunme_tarihi kolonu zaten var veya hata:', err.message);
  });
  
  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_indirilme_sayisi INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â pdf_indirilme_sayisi kolonu zaten var veya hata:', err.message);
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
  
  // Sınav Talepleri Tablosu (SatÃƒÂ„Ã‚Â±n alma sistemi kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±)
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
  
  // PayTR Ayarları Tablosu - KALDIRILDÃƒÂ„Ã‚Â° (Talep sistemi kullanÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor)
  
  // ============ SINAV PAKETLERÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â° ============
  
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
  
  // Paket-Sınav ÃƒÂ„Ã‚Â°liÃƒÂ…Ã‚ÂŸkisi (Many-to-Many)
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
  
  // Paket-Öğrenci AtamalarÃƒÂ„Ã‚Â±
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
  
  console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Sınav Paketleri tablolarÃƒÂ„Ã‚Â± oluşturuldu');
  
  // Kurumsal ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§erik YÃƒÂƒÃ‚Â¶netimi Tablosu
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
  
  // VarsayÃƒÂ„Ã‚Â±lan kurumsal iÃƒÂƒÃ‚Â§erikleri ekle (eÃƒÂ„Ã‚ÂŸer yoksa)
  db.get(`SELECT COUNT(*) as count FROM kurumsal_icerik`, (err, row) => {
    if (!err && row.count === 0) {
      const defaultPages = [
        {
          sayfa_adi: 'hakkimizda',
          baslik: 'TÃƒÂƒÃ‚Â¼rkiye\'nin SimÃƒÂƒÃ‚Â¼lasyon Sınav Merkezi',
          alt_baslik: '30 yÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â±k eÃƒÂ„Ã‚ÂŸitim tecrÃƒÂƒÃ‚Â¼besiyle, gerÃƒÂƒÃ‚Â§ek sınav ortamÃƒÂ„Ã‚Â±nda ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerimizi geleceÃƒÂ„Ã‚ÂŸe hazÃƒÂ„Ã‚Â±rlÃƒÂ„Ã‚Â±yoruz.',
          icerik: 'Sınav Merkezi, TÃƒÂƒÃ‚Â¼rkiye\'nin ÃƒÂƒÃ‚Â¶nde gelen simÃƒÂƒÃ‚Â¼lasyon sınav organizasyonlarÃƒÂ„Ã‚Â±ndan biridir. 1995 yÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±ndan bu yana ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerimize gerÃƒÂƒÃ‚Â§ek sınav deneyimi yaÃƒÂ…Ã‚ÂŸatarak, onlarÃƒÂ„Ã‚Â± en iyi ÃƒÂ…Ã‚ÂŸekilde geleceÃƒÂ„Ã‚ÂŸe hazÃƒÂ„Ã‚Â±rlamaktayÃƒÂ„Ã‚Â±z.',
          meta_description: 'TÃƒÂƒÃ‚Â¼rkiye\'nin ÃƒÂƒÃ‚Â¶nde gelen simÃƒÂƒÃ‚Â¼lasyon sınav merkezi. 30 yÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â±k tecrÃƒÂƒÃ‚Â¼be ile LGS, YKS ve tÃƒÂƒÃ‚Â¼m sınavlar iÃƒÂƒÃ‚Â§in profesyonel deneme sınavlarÃƒÂ„Ã‚Â±.',
          meta_keywords: 'sınav merkezi, deneme sınavÃƒÂ„Ã‚Â±, LGS, YKS, simÃƒÂƒÃ‚Â¼lasyon sınavÃƒÂ„Ã‚Â±',
          aktif: 1,
          sira: 1
        },
        {
          sayfa_adi: 'iletisim',
          baslik: 'ÃƒÂ„Ã‚Â°letiÃƒÂ…Ã‚ÂŸim',
          alt_baslik: 'Bizimle iletiÃƒÂ…Ã‚ÂŸime geÃƒÂƒÃ‚Â§in',
          icerik: 'SorularÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±z ve talepleriniz iÃƒÂƒÃ‚Â§in bizimle iletiÃƒÂ…Ã‚ÂŸime geÃƒÂƒÃ‚Â§ebilirsiniz.',
          meta_description: 'Sınav Merkezi iletiÃƒÂ…Ã‚ÂŸim bilgileri',
          meta_keywords: 'iletiÃƒÂ…Ã‚ÂŸim, telefon, e-posta, adres',
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
      
      console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… VarsayÃƒÂ„Ã‚Â±lan kurumsal iÃƒÂƒÃ‚Â§erikler oluşturuldu');
    }
  });
  
  console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Kurumsal ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§erik YÃƒÂƒÃ‚Â¶netimi tablosu oluşturuldu');
  
  // Öğrenci KayıtlarÃƒÂ„Ã‚Â± Tablosu (Kurum iÃƒÂƒÃ‚Â§in)
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
      odeme_durumu TEXT DEFAULT 'BEKLÃƒÂ„Ã‚Â°YOR',
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
  
  // Bildirim GeÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸi Tablosu
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
  // AKILLI ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENME SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â° TABLOLARI
  // ============================================
  
  // PDF Pattern ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenme Tablosu
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
  
  // BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirmeler Tablosu (ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenme iÃƒÂƒÃ‚Â§in)
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
  
  // PDF YapÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± HafÃƒÂ„Ã‚Â±zasÃƒÂ„Ã‚Â±
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
  
  console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenme Sistemi tablolarÃƒÂ„Ã‚Â± hazÃƒÂ„Ã‚Â±r');
  
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
  
  // SatÃƒÂ„Ã‚Â±n alÃƒÂ„Ã‚Â±nabilir sınavlar tablosu
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
  
  // HakkÃƒÂ„Ã‚Â±mÃƒÂ„Ã‚Â±zda ve site ayarları
  db.run(`
    CREATE TABLE IF NOT EXISTS site_ayarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anahtar TEXT UNIQUE NOT NULL,
      deger TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // VarsayÃƒÂ„Ã‚Â±lan site ayarlarınÃƒÂ„Ã‚Â± ekle
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adi', 'Sınav Merkezi')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adres', 'Ankara, TÃƒÂƒÃ‚Â¼rkiye')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_telefon', '+90 (312) 123 45 67')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_email', 'info@sinavmerkezi.com')`);
  db.run(`INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_aciklama', '30 yÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â±k eÃƒÂ„Ã‚ÂŸitim tecrÃƒÂƒÃ‚Â¼besiyle ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerimizi geleceÃƒÂ„Ã‚ÂŸe hazÃƒÂ„Ã‚Â±rlÃƒÂ„Ã‚Â±yoruz.')`);

  
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
  
  // VarsayÃƒÂ„Ã‚Â±lan kurumsal sayfalarÃƒÂ„Ã‚Â± ekle (eÃƒÂ„Ã‚ÂŸer yoksa)
  db.run(`
    INSERT OR IGNORE INTO kurumsal_sayfalar (sayfa_slug, sayfa_adi, baslik, icerik, sira)
    VALUES 
    ('hakkimizda', 'HakkÃƒÂ„Ã‚Â±mÃƒÂ„Ã‚Â±zda', 'Sınav Merkezi HakkÃƒÂ„Ã‚Â±nda', 
    '<div class="row mb-5">
      <div class="col-lg-6">
        <h3 class="mb-4">Misyonumuz</h3>
        <p class="lead">Sınav Merkezi olarak, ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin akademik baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± en ÃƒÂƒÃ‚Â¼st dÃƒÂƒÃ‚Â¼zeye ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±karmak ve onlarÃƒÂ„Ã‚Â± geleceÃƒÂ„Ã‚ÂŸe hazÃƒÂ„Ã‚Â±rlamak iÃƒÂƒÃ‚Â§in kapsamlÃƒÂ„Ã‚Â± sınav hizmetleri sunuyoruz.</p>
        <p>30 yÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â±k eÃƒÂ„Ã‚ÂŸitim tecrÃƒÂƒÃ‚Â¼bemizle, ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerimize en kaliteli sınav deneyimini yaÃƒÂ…Ã‚ÂŸatmayÃƒÂ„Ã‚Â± hedefliyoruz.</p>
      </div>
      <div class="col-lg-6">
        <h3 class="mb-4">Vizyonumuz</h3>
        <p class="lead">TÃƒÂƒÃ‚Â¼rkiye''nin en gÃƒÂƒÃ‚Â¼venilir ve yenilikÃƒÂƒÃ‚Â§i sınav merkezi olmak.</p>
        <p>Modern teknoloji ve deneyimli kadromuzla, eÃƒÂ„Ã‚ÂŸitim sektÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nde fark yaratan hizmetler sunmaya devam ediyoruz.</p>
      </div>
    </div>
    <div class="row mb-5">
      <div class="col-12">
        <h3 class="mb-4">Neden Biz?</h3>
        <div class="row">
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-award-fill text-primary" style="font-size: 3rem;"></i>
              <h5 class="mt-3">30+ YÃƒÂ„Ã‚Â±l TecrÃƒÂƒÃ‚Â¼be</h5>
              <p>EÃƒÂ„Ã‚ÂŸitim sektÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nde kÃƒÂƒÃ‚Â¶klÃƒÂƒÃ‚Â¼ geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸ</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-people-fill text-success" style="font-size: 3rem;"></i>
              <h5 class="mt-3">10,000+ Öğrenci</h5>
              <p>Binlerce ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciye hizmet</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-mortarboard-fill text-info" style="font-size: 3rem;"></i>
              <h5 class="mt-3">Uzman Kadro</h5>
              <p>Deneyimli eÃƒÂ„Ã‚ÂŸitim ekibi</p>
            </div>
          </div>
          <div class="col-md-3 mb-3">
            <div class="text-center">
              <i class="bi bi-graph-up-arrow text-warning" style="font-size: 3rem;"></i>
              <h5 class="mt-3">YÃƒÂƒÃ‚Â¼ksek BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±</h5>
              <p>KanÃƒÂ„Ã‚Â±tlanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ sonuÃƒÂƒÃ‚Â§lar</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="col-12">
        <h3 class="mb-4">Hizmetlerimiz</h3>
        <ul class="list-unstyled">
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Deneme SınavlarÃƒÂ„Ã‚Â± (TYT, AYT, LGS)</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Dijital SonuÃƒÂƒÃ‚Â§ Takibi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> KiÃƒÂ…Ã‚ÂŸiselleÃƒÂ…Ã‚ÂŸtirilmiÃƒÂ…Ã‚ÂŸ Performans RaporlarÃƒÂ„Ã‚Â±</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Veli Bilgilendirme Sistemi</li>
          <li class="mb-2"><i class="bi bi-check-circle-fill text-success me-2"></i> Online Sınav Platformu</li>
        </ul>
      </div>
    </div>', 1),
    ('iletisim', 'ÃƒÂ„Ã‚Â°letiÃƒÂ…Ã‚ÂŸim', 'ÃƒÂ„Ã‚Â°letiÃƒÂ…Ã‚ÂŸim', '<p><strong>Adres:</strong> ÃƒÂ„Ã‚Â°stanbul, TÃƒÂƒÃ‚Â¼rkiye</p><p><strong>Email:</strong> info@sinavmerkezi.com</p><p><strong>Telefon:</strong> 0 (505) 354 12 30</p>', 2),
    ('sinav-merkezleri', 'Sınav Merkezleri', 'Sınav Merkezlerimiz', '<p>TÃƒÂƒÃ‚Â¼m TÃƒÂƒÃ‚Â¼rkiye genelinde sınav merkezlerimiz bulunmaktadır.</p>', 3)
  `);
  
  // Eski sınav_takvimi tablosu kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â± - yeni yapÃƒÂ„Ã‚Â± aÃƒÂ…Ã‚ÂŸaÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±da
  
  db.run(`
    CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT NOT NULL,
      sinif TEXT NOT NULL,
      sinav_tarihi DATETIME NOT NULL,
      durum TEXT DEFAULT 'SonuÃƒÂƒÃ‚Â§ aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±klandÃƒÂ„Ã‚Â±',
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
      console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Kolon ekleme hatasÃƒÂ„Ã‚Â±:', err);
    } else if (!err) {
      console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… sonuc_goruntuleme_aktif kolonu eklendi');
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
  
  // Cevap anahtarlarÃƒÂ„Ã‚Â± tablosu
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
  
  // Eksik kolonlarÃƒÂ„Ã‚Â± ekle (ALTER TABLE)
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN rehber_ogretmen_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â rehber_ogretmen_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… ogrenci_talepleri.rehber_ogretmen_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE ogrenci_talepleri ADD COLUMN ogrenci_id INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ogrenci_id kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… ogrenci_talepleri.ogrenci_id kolonu eklendi');
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN pdf_isim TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  db.run(`ALTER TABLE sinav_sonuclari_pdf ADD COLUMN sayfa_no INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // SÃƒÂƒÃ‚Â¼tun zaten var, sorun yok
    }
  });
  
  // Sınav paketlerine fiyat kolonu ekle
  db.run(`ALTER TABLE sinav_paketleri ADD COLUMN fiyat REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â sinav_paketleri.fiyat kolonu zaten var veya hata:', err.message);
    } else if (!err) {
      console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… sinav_paketleri.fiyat kolonu eklendi');
    }
  });
});

// VeritabanÃƒÂ„Ã‚Â± yardÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± fonksiyonlarÃƒÂ„Ã‚Â± (Promise wrapper)
// Öğrenci NumarasÃƒÂ„Ã‚Â± OluÃƒÂ…Ã‚ÂŸturma Fonksiyonu
async function generateOgrenciNo() {
  const yil = new Date().getFullYear();
  
  // Bu yÃƒÂ„Ã‚Â±l eklenen son ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci numarasÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± bul
  const sonOgrenci = await dbGet(
    `SELECT ogrenci_no FROM ogrenciler 
     WHERE ogrenci_no LIKE ? 
     ORDER BY ogrenci_no DESC LIMIT 1`,
    [`${yil}%`]
  );
  
  let sira = 1;
  if (sonOgrenci && sonOgrenci.ogrenci_no) {
    // Son 4 haneyi al ve 1 artÃƒÂ„Ã‚Â±r
    const sonSira = parseInt(sonOgrenci.ogrenci_no.substring(4));
    sira = sonSira + 1;
  }
  
  // YÃƒÂ„Ã‚Â±l + 4 haneli sÃƒÂ„Ã‚Â±ra numarasÃƒÂ„Ã‚Â±
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
 * TC bazlÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci tekrarlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizler
 * AynÃƒÂ„Ã‚Â± TC'ye sahip ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler varsa, kurum kaydÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â¶ncelikli tutar
 * @param {Array} veliOgrencileri - Veli tarafÃƒÂ„Ã‚Â±ndan eklenen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler
 * @param {Array} kurumOgrencileri - Kurum tarafÃƒÂ„Ã‚Â±ndan eklenen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler
 * @returns {Array} TemizlenmiÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci listesi
 */
function temizleOgrenciTekrarlari(veliOgrencileri = [], kurumOgrencileri = []) {
  const tcMap = new Map();
  const tcSizOgrenciler = [];
  let tekrarSayisi = 0;
  
  // ÃƒÂƒÃ‚Â–nce kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerini ekle (ÃƒÂƒÃ‚Â¶ncelikli)
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
  
  // Sonra veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerini ekle (sadece TC tekrar etmeyenler)
  veliOgrencileri.forEach(ogr => {
    const tc = ogr.tc_no ? String(ogr.tc_no).replace('.0', '').trim() : null;
    if (tc && tc !== '' && tc !== 'null' && tc !== 'undefined') {
      if (!tcMap.has(tc)) {
        tcMap.set(tc, ogr);
      } else {
        tekrarSayisi++;
        console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  Tekrar: ${ogr.ad_soyad || ogr.ogrenci_adi} (TC: ${tc}) - Kurum kaydÃƒÂ„Ã‚Â± kullanÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor`);
      }
    } else {
      // TC yok, direkt ekle
      tcSizOgrenciler.push(ogr);
    }
  });
  
  // TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri birleÃƒÂ…Ã‚ÂŸtir ve isme gÃƒÂƒÃ‚Â¶re sÃƒÂ„Ã‚Â±rala
  const temizlenmis = [...Array.from(tcMap.values()), ...tcSizOgrenciler];
  temizlenmis.sort((a, b) => {
    const adA = (a.ad_soyad || a.ogrenci_adi || '').toLowerCase();
    const adB = (b.ad_soyad || b.ogrenci_adi || '').toLowerCase();
    return adA.localeCompare(adB, 'tr');
  });
  
  if (tekrarSayisi > 0) {
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â¹ ${tekrarSayisi} tekrar temizlendi`);
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
      site_adres: 'Ankara, TÃƒÂƒÃ‚Â¼rkiye',
      site_telefon: '+90 (312) 123 45 67',
      site_email: 'info@sinavmerkezi.com',
      site_aciklama: '30 yÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â±k eÃƒÂ„Ã‚ÂŸitim tecrÃƒÂƒÃ‚Â¼besiyle ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerimizi geleceÃƒÂ„Ã‚ÂŸe hazÃƒÂ„Ã‚Â±rlÃƒÂ„Ã‚Â±yoruz.'
    };
  }
  next();
});

// ============================================
// AKILLI EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â° - STRATEJÃƒÂ„Ã‚Â°LER
// ============================================

/**
 * STRATEJÃƒÂ„Ã‚Â° 1: ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenilmiÃƒÂ…Ã‚ÂŸ Pattern (En HÃƒÂ„Ã‚Â±zlÃƒÂ„Ã‚Â±)
 * Daha ÃƒÂƒÃ‚Â¶nce başarılı olan pattern'leri kullanÃƒÂ„Ã‚Â±r
 */
async function strategy1_LearnedPattern(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš GeÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenmelere bakÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor...');
  
  try {
    // Bu kurumun geÃƒÂƒÃ‚Â§miÃƒÂ…Ã‚ÂŸ başarılı pattern'lerini al
    const learnedPattern = await dbGet(`
      SELECT name_line_number, name_position_type, success_rate, use_count
      FROM pdf_learning_patterns
      WHERE kurum_id = ? 
        AND success_rate >= 0.85
      ORDER BY use_count DESC, success_rate DESC
      LIMIT 1
    `, [kurumId]);
    
    if (!learnedPattern) {
      console.log('   ÃƒÂ¢Ã‚Â„Ã‚Â¹ÃƒÂ¯Ã‚Â¸Ã‚Â ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenilmiÃƒÂ…Ã‚ÂŸ pattern yok');
      return null;
    }
    
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â– ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenilmiÃƒÂ…Ã‚ÂŸ pattern: SatÃƒÂ„Ã‚Â±r ${learnedPattern.name_line_number} (BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±: ${(learnedPattern.success_rate * 100).toFixed(0)}%, KullanÃƒÂ„Ã‚Â±m: ${learnedPattern.use_count}x)`);
    
    // ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenilmiÃƒÂ…Ã‚ÂŸ satÃƒÂ„Ã‚Â±rdan ismi ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar
    const extractedName = lines[learnedPattern.name_line_number];
    
    if (!extractedName) {
      console.log('   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â SatÃƒÂ„Ã‚Â±r bulunamadı');
      return null;
    }
    
    // ÃƒÂ„Ã‚Â°smi temizle
    const cleanName = cleanExtractedName(extractedName);
    
    // KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larla eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtir
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
    
    console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenilmiÃƒÂ…Ã‚ÂŸ pattern eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmedi');
    return null;
  } catch (error) {
    console.error('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Strateji 1 hatasÃƒÂ„Ã‚Â±:', error.message);
    return null;
  }
}

/**
 * STRATEJÃƒÂ„Ã‚Â° 2: VeritabanÃƒÂ„Ã‚Â± Benzerlik TaramasÃƒÂ„Ã‚Â± (Ana YÃƒÂƒÃ‚Â¶ntem)
 * TÃƒÂƒÃ‚Â¼m satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± tarayÃƒÂ„Ã‚Â±p veritabanÃƒÂ„Ã‚Â±ndaki ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerle karÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±laÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±r
 */
async function strategy2_DatabaseSimilarity(lines, katilimcilar, kurumId, sinavId) {    console.log('Database connected:', DB_PATH);
  
  let bestMatch = null;
  let bestSimilarity = 0;
  let bestLineNumber = -1;
  let bestExtractedName = '';
  
  // ÃƒÂ„Ã‚Â°lk 50 satÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â± tara
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    
    // BoÃƒÂ…Ã‚ÂŸ satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± atla
    if (!line || line.length < 5) continue;
    
    // ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• GELÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚ÂMÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â PARSE: SatÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â± farklÃƒÂ„Ã‚Â± ÃƒÂ…Ã‚ÂŸekillerde parse et
    const parsedNames = [];
    
    // 1. Direkt satÃƒÂ„Ã‚Â±r
    parsedNames.push({ text: line, source: 'direct' });
    
    // 2. Rakamlardan ÃƒÂƒÃ‚Â¶nceki kÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±m (ÃƒÂƒÃ‚Â¶rn: "ALÃƒÂ„Ã‚Â° OSMAN ÃƒÂƒÃ‚Â‡ÃƒÂƒÃ‚Â–ZELÃƒÂ„Ã‚Â°08-A" ÃƒÂ¢Ã‚Â†Ã‚Â’ "ALÃƒÂ„Ã‚Â° OSMAN ÃƒÂƒÃ‚Â‡ÃƒÂƒÃ‚Â–ZELÃƒÂ„Ã‚Â°")
    const beforeNumber = line.match(/^([A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœa-zÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±ÃƒÂƒÃ‚Â¶ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼\s]+?)(?=\d|$)/);
    if (beforeNumber && beforeNumber[1].trim().length >= 5) {
      parsedNames.push({ text: beforeNumber[1].trim(), source: 'before_number' });
    }
    
    // 3. Kelime tabanlÃƒÂ„Ã‚Â± parse (birleÃƒÂ…Ã‚ÂŸik satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± bÃƒÂƒÃ‚Â¶l)
    // "ÖğrenciNumaraSÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±fALÃƒÂ„Ã‚Â° OSMAN ÃƒÂƒÃ‚Â‡ÃƒÂƒÃ‚Â–ZELÃƒÂ„Ã‚Â°08-A" gibi durumlar iÃƒÂƒÃ‚Â§in
    const words = line.split(/(?=[A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ][a-zÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±ÃƒÂƒÃ‚Â¶ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼])/);
    words.forEach(w => {
      const clean = cleanExtractedName(w);
      if (clean && clean.length >= 5 && clean.split(' ').length >= 2) {
        parsedNames.push({ text: w, source: 'word_split' });
      }
    });
    
    // Her parse edilmiÃƒÂ…Ã‚ÂŸ ismi test et
    for (const parsed of parsedNames) {
      // ÃƒÂ„Ã‚Â°sim gibi mi kontrol et
      if (!looksLikeName(parsed.text)) continue;
      
      const cleanLine = cleanExtractedName(parsed.text);
      if (!cleanLine) continue;
      
      // Her katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± ile karÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±laÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±r
      for (const katilimci of katilimcilar) {
        const similarity = stringSimilarity(cleanLine, katilimci.ad_soyad);
        
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = katilimci;
          bestLineNumber = i;
          bestExtractedName = cleanLine;
          console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â Yeni aday: "${cleanLine}" ÃƒÂ¢Ã‚Â†Ã‚Â’ "${katilimci.ad_soyad}" (${(similarity * 100).toFixed(0)}%, kaynak: ${parsed.source})`);
        }
      }
    }
  }
  
  if (bestMatch && bestSimilarity >= 0.70) { // EÃƒÂ…Ã‚ÂŸiÃƒÂ„Ã‚ÂŸi 0.70'e dÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼rdÃƒÂƒÃ‚Â¼k
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme bulundu: "${bestMatch.ad_soyad}" (Benzerlik: ${(bestSimilarity * 100).toFixed(0)}%, SatÃƒÂ„Ã‚Â±r: ${bestLineNumber})`);
    
    return {
      ogrenciId: bestMatch.ogrenci_id,
      ogrenciAd: bestMatch.ad_soyad,
      kaynak: bestMatch.kaynak,
      extractedName: bestExtractedName,
      confidence: bestSimilarity,
      lineNumber: bestLineNumber
    };
  }
  
  console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Yeterli benzerlik bulunamadı (En iyi: ${(bestSimilarity * 100).toFixed(0)}%)`);
  return null;
}

/**
 * STRATEJÃƒÂ„Ã‚Â° 3: Pozisyon TabanlÃƒÂ„Ã‚Â±
 * PDF'deki pozisyona gÃƒÂƒÃ‚Â¶re isim tahmini yapar
 */
async function strategy3_PositionBased(lines, katilimcilar, kurumId, sinavId, pdfPath) {
  console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â PDF koordinatlarÃƒÂ„Ã‚Â±na bakÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor...');
  
  // ÃƒÂ„Ã‚Â°lk 15 satÃƒÂ„Ã‚Â±rda, en ÃƒÂƒÃ‚Â§ok kelime sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±na sahip satÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â± bul
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
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Pozisyon eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi: "${match.ogrenci.ad_soyad}"`);
      return {
        ogrenciId: match.ogrenci.ogrenci_id,
        ogrenciAd: match.ogrenci.ad_soyad,
        kaynak: match.ogrenci.kaynak,
        extractedName: cleanLine,
        confidence: match.similarity * 0.9, // Pozisyon tabanlÃƒÂ„Ã‚Â± biraz daha dÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼k gÃƒÂƒÃ‚Â¼ven
        lineNumber: candidate.index
      };
    }
  }
  
  console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Pozisyon tabanlÃƒÂ„Ã‚Â± eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z');
  return null;
}

/**
 * STRATEJÃƒÂ„Ã‚Â° 4: GeliÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ Regex Pattern'leri
 */
async function strategy4_AdvancedRegex(lines, katilimcilar, kurumId, sinavId) {
  console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â¤ Regex pattern\'leri deneniyor...');
  
  const patterns = [
    /(?:Öğrenci|ADI|SOYADI|ÃƒÂ„Ã‚Â°SÃƒÂ„Ã‚Â°M)[:\s]+([A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ\s]{10,40})/i,
    /(?:Ad Soyad)[:\s]+([A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ\s]{10,40})/i,
    /^([A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ]+\s+[A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ]+(?:\s+[A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ]+)?)\s+\d/,
    /\d+\s+([A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ]+\s+[A-ZÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Âœ]+)/
  ];
  
  for (const pattern of patterns) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const match_result = lines[i].match(pattern);
      
      if (match_result && match_result[1]) {
        const extractedName = cleanExtractedName(match_result[1]);
        const match = findBestMatch(extractedName, katilimcilar);
        
        if (match && match.similarity >= 0.75) {
          console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Regex eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi: "${match.ogrenci.ad_soyad}"`);
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
  
  console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Regex eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z');
  return null;
}

/**
 * STRATEJÃƒÂ„Ã‚Â° 5: Fuzzy Search (En agresif)
 */
async function strategy5_FuzzySearch(lines, katilimcilar, kurumId, sinavId) {
  console.log('   ÃƒÂ°Ã‚ÂŸÃ‚ÂŒÃ‚Â«ÃƒÂ¯Ã‚Â¸Ã‚Â Fuzzy search yapÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor (agresif)...');
  
  // TÃƒÂƒÃ‚Â¼m PDF textini birleÃƒÂ…Ã‚ÂŸtir ve her katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±yÃƒÂ„Ã‚Â± ara
  const fullText = lines.join(' ').toUpperCase();
  
  for (const katilimci of katilimcilar) {
    const nameWords = katilimci.ad_soyad.toUpperCase().split(/\s+/);
    
    // ÃƒÂ„Ã‚Â°smin tÃƒÂƒÃ‚Â¼m kelimeleri PDF'de var mÃƒÂ„Ã‚Â±?
    const allWordsExist = nameWords.every(word => fullText.includes(word));
    
    if (allWordsExist && nameWords.length >= 2) {
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Fuzzy eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme: "${katilimci.ad_soyad}" (tÃƒÂƒÃ‚Â¼m kelimeler bulundu)`);
      
      return {
        ogrenciId: katilimci.ogrenci_id,
        ogrenciAd: katilimci.ad_soyad,
        kaynak: katilimci.kaynak,
        extractedName: katilimci.ad_soyad,
        confidence: 0.70, // DÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼k gÃƒÂƒÃ‚Â¼ven
        lineNumber: -1
      };
    }
  }
  
  console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Fuzzy search baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z');
  return null;
}

// ============================================
// AKILLI ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENME SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â° FONKSÃƒÂ„Ã‚Â°YONLARI
// ============================================

/**
 * BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â± pattern'i ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸren
 */
async function learnSuccessfulPattern(kurumId, sinavId, result, strategyName) {
  try {
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â“ ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENME: BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â± pattern kaydediliyor...`);
    
    // Sınav tipini al
    const sinav = await dbGet('SELECT sinav_turu FROM sinavlar WHERE id = ?', [sinavId]);
    
    // Var olan pattern'i gÃƒÂƒÃ‚Â¼ncelle veya yeni ekle
    const existing = await dbGet(`
      SELECT id, success_rate, use_count 
      FROM pdf_learning_patterns 
      WHERE kurum_id = ? AND name_line_number = ?
    `, [kurumId, result.lineNumber]);
    
    if (existing) {
      // BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â± oranÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle (moving average)
      const newSuccessRate = (existing.success_rate * existing.use_count + result.confidence) / (existing.use_count + 1);
      
      await dbRun(`
        UPDATE pdf_learning_patterns 
        SET success_rate = ?, 
            use_count = use_count + 1,
            last_used = datetime('now')
        WHERE id = ?
      `, [newSuccessRate, existing.id]);
      
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Pattern güncellendi (Yeni baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±: ${(newSuccessRate * 100).toFixed(0)}%)`);
    } else {
      // Yeni pattern ekle
      await dbRun(`
        INSERT INTO pdf_learning_patterns 
        (kurum_id, sinav_tipi, name_line_number, name_position_type, success_rate)
        VALUES (?, ?, ?, ?, ?)
      `, [kurumId, sinav?.sinav_turu || 'unknown', result.lineNumber, strategyName, result.confidence]);
      
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Yeni pattern ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenildi (SatÃƒÂ„Ã‚Â±r: ${result.lineNumber})`);
    }
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸrenme hatasÃƒÂ„Ã‚Â±:', error);
  }
}

/**
 * BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±zlÃƒÂ„Ã‚Â±ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â± kaydet (gelecekte analiz iÃƒÂƒÃ‚Â§in)
 */
async function logMatchingFailure(sinavId, lines, reason) {
  try {
    const attemptedNames = lines.slice(0, 10).join(' | ');
    
    await dbRun(`
      INSERT INTO matching_failures (sinav_id, attempted_name, failure_reason)
      VALUES (?, ?, ?)
    `, [sinavId, attemptedNames.substring(0, 200), reason]);
    
    console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±zlÃƒÂ„Ã‚Â±k kaydedildi (gelecek analiz iÃƒÂƒÃ‚Â§in)');
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±zlÃƒÂ„Ã‚Â±k kayıt hatasÃƒÂ„Ã‚Â±:', error);
  }
}

/**
 * ANA CASCADE MATCHING SÃƒÂ„Ã‚Â°STEMÃƒÂ„Ã‚Â°
 * ÃƒÂƒÃ‚Â‡ok KatmanlÃƒÂ„Ã‚Â± AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme - Strateji 1 baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z olursa Strateji 2'ye geÃƒÂƒÃ‚Â§er
 */
async function intelligentCascadeMatching(pdfText, sinavId, kurumId, pdfPath) {
  console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â  AKILLI EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME BAÃƒÂ…Ã‚ÂLADI');
  
  try {
    // 1. Sınava katÃƒÂ„Ã‚Â±lan ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri al
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
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¥ Sınava katÃƒÂ„Ã‚Â±lan: ${katilimcilar.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci`);
    
    if (katilimcilar.length === 0) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Sınava katÃƒÂ„Ã‚Â±lan ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci bulunamadı!');
      return null;
    }
    
    // PDF'den tÃƒÂƒÃ‚Â¼m satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar
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
    
    // Her stratejiyi sÃƒÂ„Ã‚Â±rayla dene
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â Strateji ${i+1}: ${strategy.name}`);
      
      try {
        result = await strategy(lines, katilimcilar, kurumId, sinavId, pdfPath);
        
        // Strateji 1 ve 2 iÃƒÂƒÃ‚Â§in daha dÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼k eÃƒÂ…Ã‚ÂŸik, diÃƒÂ„Ã‚ÂŸerleri iÃƒÂƒÃ‚Â§in 0.75
        const minConfidence = (i === 0 || i === 1) ? 0.70 : 0.75;
        
        if (result && result.confidence >= minConfidence) {
          usedStrategy = strategy.name;
          console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Strateji ${i+1} BAÃƒÂ…Ã‚ÂARILI! (GÃƒÂƒÃ‚Â¼ven: ${(result.confidence * 100).toFixed(0)}%)`);
          
          // BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â± stratejiyi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸren
          await learnSuccessfulPattern(kurumId, sinavId, result, strategy.name);
          break;
        } else {
          console.log(`ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Strateji ${i+1} yeterli gÃƒÂƒÃ‚Â¼vende deÃƒÂ„Ã‚ÂŸil (Mevcut: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'yok'}, Gereken: ${(minConfidence * 100).toFixed(0)}%)`);
        }
      } catch (error) {
        console.error(`ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Strateji ${i+1} hatasÃƒÂ„Ã‚Â±:`, error.message);
      }
    }
    
    // HiÃƒÂƒÃ‚Â§bir strateji iÃƒÂ…Ã‚ÂŸe yaramadıysa
    if (!result || result.confidence < 0.70) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ TÃƒÂƒÃ‚ÂœM STRATEJÃƒÂ„Ã‚Â°LER BAÃƒÂ…Ã‚ÂARISIZ - Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme gerekli');
      console.log(`   En iyi sonuÃƒÂƒÃ‚Â§: ${result?.confidence ? (result.confidence * 100).toFixed(0) + '%' : 'Bulunamadı'}`);
      await logMatchingFailure(sinavId, lines, 'all_strategies_failed');
      return null;
    }
    
    return {
      ...result,
      usedStrategy: usedStrategy
    };
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Cascade matching hatasÃƒÂ„Ã‚Â±:', error);
    return null;
  }
}

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads')); // PDF dosyalarÃƒÂ„Ã‚Â±na erişim iÃƒÂƒÃ‚Â§in
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// EJS cache'i devre dÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â± bÃƒÂ„Ã‚Â±rak (development iÃƒÂƒÃ‚Â§in)
app.set('view cache', false);

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProd, // production'da HTTPS zorunlu, local gelistirmede false
    httpOnly: true, // XSS korumasÃƒÂ„Ã‚Â±
    maxAge: 24 * 60 * 60 * 1000, // 24 saat
    sameSite: 'lax' // CSRF riskini azaltmak icin
  },
  proxy: true // Railway proxy desteÃƒÂ„Ã‚ÂŸi
}));

// Upload klasÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer yapÃƒÂ„Ã‚Â±landÃƒÂ„Ã‚Â±rmasÃƒÂ„Ã‚Â±
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
      cb(new Error('Sadece Excel ve CSV dosyalarÃƒÂ„Ã‚Â± yÃƒÂƒÃ‚Â¼klenebilir!'));
    }
  }
});

// YardÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± fonksiyonlar
function requireAuth(req, res, next) {
  console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â’ requireAuth middleware:');
  console.log('   Session ID:', req.session.userId);
  console.log('   User Type:', req.session.userType);
  
  if (req.session.userId) {
    console.log('   ÃƒÂ¢Ã‚ÂœÃ‚Â… Kimlik doÃƒÂ„Ã‚ÂŸrulandÃƒÂ„Ã‚Â±\n');
    next();
  } else {
    console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Kimlik doÃƒÂ„Ã‚ÂŸrulanamadı, login\'e yÃƒÂƒÃ‚Â¶nlendiriliyor\n');
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
    req.session.error = 'Bu sayfaya erişim yetkiniz yok!';
    // Kurum rolleri için kurum dashboard'a yönlendir, diğerleri ana sayfaya
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
  
  // Öğrenci adı kolonunu bul
  if (!ogrenciAdiKolonu) {
    const keys = Object.keys(data[0]);
    ogrenciAdiKolonu = keys.find(key => {
      const keyLower = String(key).toLowerCase();
      return ['ad', 'isim', 'name', 'ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci', 'student', 'ad soyad', 'ad_soyad'].some(kelime => 
        keyLower.includes(kelime)
      );
    });
  }
  
  if (!ogrenciAdiKolonu) return [];
  
  // TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri ÃƒÂƒÃ‚Â§ek
  const tumOgrenciler = await dbAll('SELECT * FROM ogrenciler');
  const ogrenciMap = {};
  tumOgrenciler.forEach(ogr => {
    const normalized = normalizeIsim(ogr.ad_soyad).toLowerCase();
    ogrenciMap[normalized] = ogr;
  });
  
  // EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme yap
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
  
  // ÃƒÂ„Ã‚Â°lk satÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â± baÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k olarak al
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = cell.value;
  });
  
  // DiÃƒÂ„Ã‚ÂŸer satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± oku
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k satÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± atla
    
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

// Health check endpoint (Railway için)
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
  // EÃƒÂ„Ã‚ÂŸer giriÃƒÂ…Ã‚ÂŸ yapmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸsa ve force parametresi yoksa dashboard'a yÃƒÂƒÃ‚Â¶nlendir
  if (req.session.userId && !req.query.force) {
    if (req.session.userType === 'veli') {
      return res.redirect('/veli/dashboard');
    } else if (req.session.userType === 'rehber_ogretmen') {
      return res.redirect('/rehber/dashboard');
    } else if (req.session.userType === 'admin') {
      return res.redirect('/admin/dashboard');
    }
  }
  
  // Anasayfa verilerini ÃƒÂƒÃ‚Â§ek
  try {
    let slider = [];
    let duyurular = [];
    let satinAlinabilirSinavlar = [];
    let toplamOgrenci = { sayi: 0 };
    let toplamSinav = { sayi: 0 };
    
    try {
      slider = await dbAll('SELECT * FROM slider WHERE aktif = 1 ORDER BY sira ASC');
    } catch (e) {
      console.log('Slider hatasÃƒÂ„Ã‚Â±:', e.message);
    }
    
    try {
      duyurular = await dbAll('SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC LIMIT 6');
    } catch (e) {
      console.log('Duyurular hatasÃƒÂ„Ã‚Â±:', e.message);
    }
    
    try {
      // Yeni sınavlar tablosundan ÃƒÂƒÃ‚Â§ek (fiyat > 0 olanlar satÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±k)
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
      console.log('Sınavlar hatasÃƒÂ„Ã‚Â±:', e.message);
      satinAlinabilirSinavlar = [];
    }
    
    let sinavPaketleri = [];
    try {
      // Aktif sınav paketlerini ÃƒÂƒÃ‚Â§ek
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
      console.log('Sınav paketleri hatasÃƒÂ„Ã‚Â±:', e.message);
    }
    
    // ÃƒÂ„Ã‚Â°statistikler
    try {
      toplamOgrenci = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler') || { sayi: 0 };
    } catch (e) {
      console.log('Öğrenci sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', e.message);
    }
    
    try {
      toplamSinav = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar') || { sayi: 0 };
    } catch (e) {
      console.log('Sınav sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', e.message);
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
    console.error('Anasayfa hatasÃƒÂ„Ã‚Â±:', error);
    // Hata olsa bile anasayfayÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶ster
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
      console.error('Template render hatasÃƒÂ„Ã‚Â±:', renderError);
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

// Sınav Paketleri SayfasÃƒÂ„Ã‚Â±
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
    console.error('Sınav paketleri hatasÃƒÂ„Ã‚Â±:', error);
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

// Kurum - Sınav Paketleri (yönetim listesi)
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
    
    // Kurum yönetim listesi admin şablonunu kullan
    res.render('kurum/sinav-paketleri', {
      paketler: paketler || [],
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      success: null,
      error: null,
      isYonetim: true
    });
  } catch (error) {
    console.error('Kurum sınav paketleri hatası:', error);
    res.render('kurum/sinav-paketleri', {
      paketler: [],
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      success: null,
      error: 'Sınav paketleri alınamadı',
      isYonetim: true
    });
  }
});

// Eski kurum paketleri linki yeni yönetime yönlendir
app.get('/kurum/sinav-paketleri', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), (req, res) => {
  return res.redirect('/kurum/sinav-paketleri-yonet');
});

// Kurum - Yeni Sınav Paketi Oluştur (form sayfası)
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
    console.error('Sınav paketi oluştur sayfası hatası:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Kurum - Sınav Paketi Kaydet
app.post('/kurum/sinav-paketi-kaydet', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const { ad, aciklama, sinif, fiyat, sinav_ids } = req.body || {};
    if (!ad) return res.status(400).json({ success: false, message: 'Paket adı zorunludur!' });
    const sinavIds = Array.isArray(sinav_ids) ? sinav_ids : [];
    const pkgFiyat = parseFloat(fiyat) || 0;

    const result = await dbRun(`INSERT INTO sinav_paketleri (ad, aciklama, sinif, toplam_sinav_sayisi, aktif, fiyat, kurum_id) VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [ad.trim(), aciklama || null, sinif || null, sinavIds.length, pkgFiyat, req.session.userId || null]);
    const paketId = result.lastID;

    for (const sid of sinavIds) {
      await dbRun('INSERT INTO paket_sinavlari (paket_id, sinav_id) VALUES (?, ?)', [paketId, sid]);
    }

    return res.json({ success: true, message: 'Paket oluşturuldu', paketId });
  } catch (error) {
    console.error('Sınav paketi kaydetme hatası:', error);
    return res.status(500).json({ success: false, message: 'Paket oluşturulamadı' });
  }
});

// Kurum - Sınav Paketi Düzenle (form)
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

    // Seçili sınavlar
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
    console.error('Sınav paketi düzenle sayfası hatası:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Kurum - Sınav Paketi Güncelle
app.post('/kurum/sinav-paketi-guncelle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const { ad, aciklama, sinif, fiyat, sinav_ids } = req.body || {};
    if (!ad) return res.status(400).json({ success: false, message: 'Paket adı zorunludur!' });
    const sinavIds = Array.isArray(sinav_ids) ? sinav_ids : [];
    const pkgFiyat = parseFloat(fiyat) || 0;

    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ?', [paketId]);
    if (!paket) return res.status(404).json({ success: false, message: 'Paket bulunamadı!' });

    await dbRun('UPDATE sinav_paketleri SET ad = ?, aciklama = ?, sinif = ?, fiyat = ?, toplam_sinav_sayisi = ? WHERE id = ?',
      [ad.trim(), aciklama || null, sinif || null, pkgFiyat, sinavIds.length, paketId]);

    await dbRun('DELETE FROM paket_sinavlari WHERE paket_id = ?', [paketId]);
    for (const sid of sinavIds) {
      await dbRun('INSERT INTO paket_sinavlari (paket_id, sinav_id) VALUES (?, ?)', [paketId, sid]);
    }

    return res.json({ success: true, message: 'Paket güncellendi' });
  } catch (error) {
    console.error('Sınav paketi güncelleme hatası:', error);
    return res.status(500).json({ success: false, message: 'Paket güncellenemedi' });
  }
});

// Kurum - Sınav Paketi Aktif/Pasif
app.post('/kurum/sinav-paketi-aktif/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    const { aktif } = req.body || {};

    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ? AND (kurum_id = ? OR ? IS NULL)', [paketId, req.session.userId || null, req.session.userId || null]);
    if (!paket) return res.status(404).json({ success: false, message: 'Paket bulunamadı!' });

    await dbRun('UPDATE sinav_paketleri SET aktif = ? WHERE id = ?', [aktif ? 1 : 0, paketId]);
    return res.json({ success: true, message: `Paket ${aktif ? 'aktifleştirildi' : 'pasifleştirildi'}` });
  } catch (error) {
    console.error('Sınav paketi aktif/pasif hatası:', error);
    return res.status(500).json({ success: false, message: 'Güncellenemedi' });
  }
});

// Kurum - Sınav Paketi Sil
app.post('/kurum/sinav-paketi-sil/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const paketId = req.params.id;
    await dbRun('DELETE FROM sinav_paketleri WHERE id = ?', [paketId]);
    return res.json({ success: true, message: 'Paket silindi' });
  } catch (error) {
    console.error('Sınav paketi silme hatası:', error);
    return res.status(500).json({ success: false, message: 'Paket silinemedi' });
  }
});

// Kurum - Sınav Paketi Detay
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

    // Öğrenci listesi ve atamalar karmaşık; şimdilik boş liste
    const ogrenciler = [];

    res.render('kurum/sinav-paketi-detay', {
      user: { username: req.session.username, type: req.session.userType, id: req.session.userId },
      paket,
      sinavlar,
      ogrenciler
    });
  } catch (error) {
    console.error('Sınav paketi detay hatası:', error);
    res.redirect('/kurum/sinav-paketleri');
  }
});

// Sınav Talep GÃƒÂƒÃ‚Â¶nderme - GiriÃƒÂ…Ã‚ÂŸ Zorunlu DeÃƒÂ„Ã‚ÂŸil
app.post('/sinav-talep-gonder', async (req, res) => {
  try {
    const { sinav_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // EÃƒÂ„Ã‚ÂŸer giriÃƒÂ…Ã‚ÂŸ yapÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸsa
    
    // SınavÃƒÂ„Ã‚Â± kontrol et
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.json({ success: false, message: 'Sınav bulunamadı!' });
    }
    
    // DURUM 1: GiriÃƒÂ…Ã‚ÂŸ yapÃƒÂ„Ã‚Â±lmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ - Yeni hesap oluştur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolÃƒÂƒÃ‚Â¼ (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'LÃƒÂƒÃ‚Â¼tfen tÃƒÂƒÃ‚Â¼m bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik oluştur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha ÃƒÂƒÃ‚Â¶nce kullanÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ mÃƒÂ„Ã‚Â±?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // ÃƒÂ…Ã‚Âifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username oluştur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabÃƒÂ„Ã‚Â± oluştur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Yeni veli hesabÃƒÂ„Ã‚Â± oluşturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
      
      // Otomatik giriÃƒÂ…Ã‚ÂŸ yapma (session oluşturma)
      // req.session.userId = veli_id;
      // req.session.username = username;
      // req.session.userType = 'veli';
    }
    
    // DURUM 2: Daha ÃƒÂƒÃ‚Â¶nce talep gÃƒÂƒÃ‚Â¶nderilmiÃƒÂ…Ã‚ÂŸ mi kontrol et
    const mevcutTalep = await dbGet(
      'SELECT * FROM sinav_talepleri WHERE veli_id = ? AND sinav_id = ? AND durum != "reddedildi"',
      [veli_id, sinav_id]
    );
    
    if (mevcutTalep) {
      return res.json({ success: false, message: 'Bu sınav iÃƒÂƒÃ‚Â§in zaten bir talebiniz bulunmaktadır!' });
    }
    
    // Talep kaydet
    await dbRun(
      `INSERT INTO sinav_talepleri (veli_id, sinav_id, durum, aciklama, talep_tarihi) 
       VALUES (?, ?, 'beklemede', ?, datetime('now'))`,
      [veli_id, sinav_id, aciklama || '']
    );
    
    // Veli bilgilerini al (WhatsApp bildirimi iÃƒÂƒÃ‚Â§in)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarınÃƒÂ„Ã‚Â± kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesajÃƒÂ„Ã‚Â± oluştur
      const mesaj = talepBildirimMesaji(veliDetay, sinav);
      
      // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (arka planda, hata olsa bile kullanıcıya başarılı dÃƒÂƒÃ‚Â¶n)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'yeni_talep')
        .then(result => {
          console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ WhatsApp bildirimi hatasÃƒÂ„Ã‚Â± (arka plan):', error);
        });
    } else {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  WhatsApp ayarları yapÃƒÂ„Ã‚Â±lmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ, bildirim gÃƒÂƒÃ‚Â¶nderilmedi');
    }
    
    res.json({ 
      success: true, 
      message: `${sinav.ad} iÃƒÂƒÃ‚Â§in talebiniz başarıyla gÃƒÂƒÃ‚Â¶nderildi! En kÃƒÂ„Ã‚Â±sa sÃƒÂƒÃ‚Â¼rede deÃƒÂ„Ã‚ÂŸerlendirilecektir.`,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Talep gÃƒÂƒÃ‚Â¶nderme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Talep gÃƒÂƒÃ‚Â¶nderilirken bir hata oluştu: ' + error.message });
  }
});

// Paket Talebi GÃƒÂƒÃ‚Â¶nder
app.post('/paket-talep-gonder', async (req, res) => {
  try {
    const { paket_id, ad_soyad, email, telefon, password, aciklama } = req.body;
    let veli_id = req.session.userId; // EÃƒÂ„Ã‚ÂŸer giriÃƒÂ…Ã‚ÂŸ yapÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸsa
    
    // Paketi kontrol et
    const paket = await dbGet('SELECT * FROM sinav_paketleri WHERE id = ? AND aktif = 1', [paket_id]);
    if (!paket) {
      return res.json({ success: false, message: 'Paket bulunamadı!' });
    }
    
    // DURUM 1: GiriÃƒÂ…Ã‚ÂŸ yapÃƒÂ„Ã‚Â±lmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ - Yeni hesap oluştur veya temp hesap kullan
    if (!veli_id) {
      // Zorunlu alanlar kontrolÃƒÂƒÃ‚Â¼ (sadece ad_soyad ve telefon)
      if (!ad_soyad || !telefon) {
        return res.json({ 
          success: false, 
          message: 'LÃƒÂƒÃ‚Â¼tfen tÃƒÂƒÃ‚Â¼m bilgileri eksiksiz doldurun!' 
        });
      }
      
      // Email ve password yoksa, otomatik oluştur
      const tempEmail = email || `${telefon.replace(/\D/g, '')}@temp.com`;
      const tempPassword = password || telefon.replace(/\D/g, '').slice(-6);
      
      // E-posta daha ÃƒÂƒÃ‚Â¶nce kullanÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ mÃƒÂ„Ã‚Â±?
      const mevcutKullanici = await dbGet('SELECT id FROM users WHERE email = ?', [tempEmail]);
      if (mevcutKullanici) {
        veli_id = mevcutKullanici.id;
      } else {
        // ÃƒÂ…Ã‚Âifre hash'le
        const password_hash = await bcrypt.hash(tempPassword, 10);
        
        // Username oluştur (telefondan)
        const username = telefon.replace(/\D/g, '') + '_' + Date.now();
        
        // Yeni veli hesabÃƒÂ„Ã‚Â± oluştur
        const result = await dbRun(
          `INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, created_at) 
           VALUES (?, ?, ?, 'veli', ?, ?, datetime('now'))`,
          [username, tempEmail, password_hash, ad_soyad, telefon]
        );
        
        veli_id = result.lastID;
        
        console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Yeni veli hesabÃƒÂ„Ã‚Â± oluşturuldu: ${tempEmail} (ID: ${veli_id})`);
      }
    }
    
    // Paket iÃƒÂƒÃ‚Â§indeki sınavlarÃƒÂ„Ã‚Â± al
    const paketSinavlari = await dbAll(
      'SELECT sinav_id FROM paket_sinavlari WHERE paket_id = ?',
      [paket_id]
    );
    
    if (paketSinavlari.length === 0) {
      return res.json({ success: false, message: 'Paket iÃƒÂƒÃ‚Â§inde sınav bulunamadı!' });
    }
    
    // Her sınav iÃƒÂƒÃ‚Â§in talep oluştur
    let olusturulanTalep = 0;
    for (const ps of paketSinavlari) {
      // Daha ÃƒÂƒÃ‚Â¶nce talep gÃƒÂƒÃ‚Â¶nderilmiÃƒÂ…Ã‚ÂŸ mi kontrol et
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
      return res.json({ success: false, message: 'Bu paket iÃƒÂƒÃ‚Â§in zaten tÃƒÂƒÃ‚Â¼m sınavlara talebiniz bulunmaktadır!' });
    }
    
    // Veli bilgilerini al (WhatsApp bildirimi iÃƒÂƒÃ‚Â§in)
    const veliDetay = await dbGet('SELECT * FROM users WHERE id = ?', [veli_id]);
    
    // WhatsApp API ayarlarınÃƒÂ„Ã‚Â± kontrol et
    const whatsappAyarlari = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (whatsappAyarlari && whatsappAyarlari.phone_number) {
      // Bildirim mesajÃƒÂ„Ã‚Â± oluştur
      const mesaj = `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¦ YENÃƒÂ„Ã‚Â° PAKET TALEBÃƒÂ„Ã‚Â°\n\n` +
        `Merhaba,\n\n` +
        `${veliDetay.ad_soyad || veliDetay.username} adlÃƒÂ„Ã‚Â± veli "${paket.ad}" paketi iÃƒÂƒÃ‚Â§in talep gÃƒÂƒÃ‚Â¶nderdi.\n\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¦ Paket: ${paket.ad}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš SÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f: ${paket.sinif || 'BelirtilmemiÃƒÂ…Ã‚ÂŸ'}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Sınav SayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±: ${paketSinavlari.length}\n` +
        `${aciklama ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ AÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±klama: ${aciklama}\n` : ''}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Telefon: ${veliDetay.telefon || 'BelirtilmemiÃƒÂ…Ã‚ÂŸ'}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â§ Email: ${veliDetay.email || 'BelirtilmemiÃƒÂ…Ã‚ÂŸ'}\n\n` +
        `LÃƒÂƒÃ‚Â¼tfen kurum panelinden talebi deÃƒÂ„Ã‚ÂŸerlendirin.`;
      
      // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (arka planda, hata olsa bile kullanıcıya başarılı dÃƒÂƒÃ‚Â¶n)
      whatsappBildirimGonder(whatsappAyarlari.phone_number, mesaj, 'paket_talebi')
        .then(result => {
          console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… WhatsApp bildirimi sonucu:', result);
        })
        .catch(error => {
          console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ WhatsApp bildirimi hatasÃƒÂ„Ã‚Â± (arka plan):', error);
        });
    } else {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  WhatsApp ayarları yapÃƒÂ„Ã‚Â±lmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ, bildirim gÃƒÂƒÃ‚Â¶nderilmedi');
    }
    
    res.json({ 
      success: true, 
      message: `${paket.ad} paketi iÃƒÂƒÃ‚Â§in ${olusturulanTalep} sınav talebi başarıyla gÃƒÂƒÃ‚Â¶nderildi! En kÃƒÂ„Ã‚Â±sa sÃƒÂƒÃ‚Â¼rede deÃƒÂ„Ã‚ÂŸerlendirilecektir.`,
      yeniHesap: (ad_soyad && email) ? true : false,
      veli_id: veli_id
    });
    
  } catch (error) {
    console.error('Paket talep gÃƒÂƒÃ‚Â¶nderme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Talep gÃƒÂƒÃ‚Â¶nderilirken bir hata oluştu: ' + error.message });
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
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â GÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â DENEMESÃƒÂ„Ã‚Â°:');
    console.log('   Kullanıcı Adı:', username);
    console.log('Database connected:', DB_PATH);
    if (user) {
      console.log('   Kullanıcı Tipi:', user.user_type);
      console.log('   Hash KarÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±laÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±rma:', await bcrypt.compare(password, user.password_hash) ? 'BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±' : 'BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z');
    }
    
    if (user && await bcrypt.compare(password, user.password_hash)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.userType = user.user_type;
      
      console.log('   ÃƒÂ¢Ã‚ÂœÃ‚Â… GÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â BAÃƒÂ…Ã‚ÂARILI!');
      console.log('   Session ID:', req.session.userId);
      
      // ÃƒÂ„Ã‚Â°lk giriÃƒÂ…Ã‚ÂŸ kontrolÃƒÂƒÃ‚Â¼ (password_changed = 0 veya NULL)
      if (user.user_type === 'veli' && (user.password_changed === 0 || user.password_changed === null)) {
        console.log('   ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â ÃƒÂ„Ã‚Â°LK GÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â - ÃƒÂ…Ã‚Âifre değiştirme ekranÃƒÂ„Ã‚Â±na yÃƒÂƒÃ‚Â¶nlendiriliyor\n');
        return res.redirect('/sifre-degistir');
      }
      
      console.log('   YÃƒÂƒÃ‚Â¶nlendirme:', user.user_type + ' dashboard\n');
      
      if (user.user_type === 'veli') {
        return res.redirect('/veli/dashboard');
      } else if (user.user_type === 'rehber_ogretmen') {
        return res.redirect('/rehber/dashboard');
      } else if (user.user_type === 'kurum_yonetici') {
        return res.redirect('/kurum/dashboard');
      }
    }
    
    console.log('   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ GÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â BAÃƒÂ…Ã‚ÂARISIZ!\n');
    req.session.error = 'Kullanıcı adı veya şifre hatalı!';
    res.redirect('/login');
  } catch (error) {
    console.error('Login hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Giriş sırasında bir hata oluştu!';
    res.redirect('/login');
  }
});

// ÃƒÂ…Ã‚Âifre DeÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸtirme SayfasÃƒÂ„Ã‚Â± (ÃƒÂ„Ã‚Â°lk GiriÃƒÂ…Ã‚ÂŸ)
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
    // ÃƒÂ…Ã‚Âifre kontrolÃƒÂƒÃ‚Â¼
    if (yeni_sifre.length < 6) {
      req.session.error = 'ÃƒÂ…Ã‚Âifre en az 6 karakter olmalıdır!';
      return res.redirect('/sifre-degistir');
    }
    
    if (yeni_sifre !== yeni_sifre_tekrar) {
      req.session.error = 'ÃƒÂ…Ã‚Âifreler uyuşmuyor!';
      return res.redirect('/sifre-degistir');
    }
    
    // Yeni şifreyi hashle
    const hashedPassword = await bcrypt.hash(yeni_sifre, 10);
    
    // VeritabanÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(`
      UPDATE users 
      SET password_hash = ?, password_changed = 1 
      WHERE id = ?
    `, [hashedPassword, req.session.userId]);
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â ÃƒÂ…Ã‚ÂÃƒÂ„Ã‚Â°FRE DEÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°`);
    console.log(`   User ID: ${req.session.userId}`);
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… ÃƒÂ…Ã‚Âifre başarıyla değiştirildi\n`);
    
    req.session.success = 'ÃƒÂ…Ã‚Âifreniz başarıyla değiştirildi!';
    
    // Kullanıcı tipine gÃƒÂƒÃ‚Â¶re yÃƒÂƒÃ‚Â¶nlendir
    const user = await dbGet('SELECT user_type FROM users WHERE id = ?', [req.session.userId]);
    
    if (user.user_type === 'veli') {
      return res.redirect('/veli/dashboard');
    } else {
      return res.redirect('/');
    }
    
  } catch (error) {
    console.error('ÃƒÂ…Ã‚Âifre değiştirme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'ÃƒÂ…Ã‚Âifre değiştirme sırasında bir hata oluştu!';
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
    // Kullanıcı adı kontrolÃƒÂƒÃ‚Â¼
    const existingUser = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existingUser) {
      req.session.error = existingUser.username === username 
        ? 'Bu kullanıcı adı zaten kullanÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor!'
        : 'Bu e-posta adresi zaten kullanÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor!';
      return res.redirect('/register');
    }
    
    // ÃƒÂ…Ã‚Âifreyi hashle
    const passwordHash = await bcrypt.hash(password, 10);
    
    // KullanıcıyÃƒÂ„Ã‚Â± kaydet
    await dbRun('INSERT INTO users (username, email, password_hash, user_type) VALUES (?, ?, ?, ?)', 
      [username, email, passwordHash, user_type]);
    
    req.session.success = 'Kayıt başarılı! Giriş yapabilirsiniz.';
    res.redirect('/login');
  } catch (error) {
    console.error('Register hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Kayıt sırasında bir hata oluştu!';
    res.redirect('/register');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ÃƒÂƒÃ‚Â–NEMLÃƒÂ„Ã‚Â°: Bu endpoint'i production'da kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±n veya şifreleyin!
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
    res.send('ÃƒÂ¢Ã‚ÂœÃ‚Â… Admin şifresi sÃƒÂ„Ã‚Â±fÃƒÂ„Ã‚Â±rlandÃƒÂ„Ã‚Â±! Username: kurum_admin, Password: Admin2024!');
  } catch (error) {
    res.status(500).send('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Hata: ' + error.message);
  }
});

// Kurum Dashboard
app.get('/kurum/dashboard', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // ÃƒÂ„Ã‚Â°statistikler
    const sinavSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar');
    const sinavAktif = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 0 AND katilimci_sayisi > 0');
    const sinavTamamlandi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 1');
    const sinavTaslak = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE katilimci_sayisi = 0');
    const toplamKatilimci = await dbGet('SELECT SUM(katilimci_sayisi) as toplam FROM sinavlar');
    const takvimSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar'); // DÃƒÂƒÃ‚Â¼zeltildi: sinav_takvimi ÃƒÂ¢Ã‚Â†Ã‚Â’ sinavlar
    const veliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM users WHERE user_type = "veli"');
    
    // TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± (kurum + veli kayıtlarÃƒÂ„Ã‚Â±)
    const ogrenciKurumSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    const ogrenciVeliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler');
    const ogrenciSayisi = { sayi: (ogrenciKurumSayisi.sayi || 0) + (ogrenciVeliSayisi.sayi || 0) };
    const ogrenciKayitSayisi = ogrenciKurumSayisi; // Kurum kayıtlarÃƒÂ„Ã‚Â± iÃƒÂƒÃ‚Â§in ayrÃƒÂ„Ã‚Â±
    
    const talepBeklemede = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "beklemede"');
    const talepOnaylandi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "onaylandi"');
    const talepReddedildi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "reddedildi"');
    const talepToplam = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri');
    
    // Paket ÃƒÂ„Ã‚Â°statistikleri
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
    console.error('Kurum dashboard hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// PayTR Entegrasyon SayfasÃƒÂ„Ã‚Â± - KALDIRILDI (Gerek yok)

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
    console.error('WhatsApp ayarları hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('WhatsApp ayarları kaydetme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Ayarlar kaydedilirken bir hata oluştu!';
    res.redirect('/kurum/whatsapp-ayarlari');
  }
});

// Kurum - WhatsApp Test Bildirimi
// Test iÃƒÂƒÃ‚Â§in manuel endpoint (GEÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚Â°CÃƒÂ„Ã‚Â° - ÃƒÂƒÃ‚Â¼retimde kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±lmalÃƒÂ„Ã‚Â±)
app.post('/test-whatsapp-mesaj', async (req, res) => {
  try {
    const { telefon, mesaj } = req.body;
    
    if (!telefon || !mesaj) {
      return res.json({ success: false, message: 'Telefon ve mesaj gerekli!' });
    }
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Âª ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â');
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Âª MANUEL TEST MESAJI GÃƒÂƒÃ‚Â–NDERÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°YOR');
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Âª ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â');
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Telefon: ${telefon}`);
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â Mesaj: ${mesaj}`);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Âª ÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚ÂÃƒÂ¢Ã‚Â•Ã‚Â\n');
    
    const result = await whatsappBildirimGonder(telefon, mesaj, 'test_manuel');
    
    res.json(result);
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Test mesajÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
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
        message: 'WhatsApp ayarları yapÃƒÂ„Ã‚Â±lmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ veya telefon numarasÃƒÂ„Ã‚Â± eksik!' 
      });
    }
    
    const testMesaj = `ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Âª TEST BÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°MÃƒÂ„Ã‚Â°

Bu bir test mesajÃƒÂ„Ã‚Â±dÃƒÂ„Ã‚Â±r.

ÃƒÂ¢Ã‚ÂœÃ‚Â… WhatsApp API entegrasyonunuz başarıyla ÃƒÂƒÃ‚Â§alÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±yor!

ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… Test ZamanÃƒÂ„Ã‚Â±: ${new Date().toLocaleString('tr-TR')}`;
    
    const result = await whatsappBildirimGonder(ayarlar.phone_number, testMesaj, 'test');
    
    if (result.success) {
      return res.json({ 
        success: true, 
        message: 'Test mesajÃƒÂ„Ã‚Â± başarıyla gÃƒÂƒÃ‚Â¶nderildi! Console loglarÃƒÂ„Ã‚Â± kontrol edin.' 
      });
    } else {
      return res.json({ 
        success: false, 
        message: 'Test mesajÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶nderilemedi: ' + result.message 
      });
    }
  } catch (error) {
    console.error('Test bildirimi hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Test sırasında bir hata oluştu: ' + error.message });
  }
});

// Kurum - Talep YÃƒÂƒÃ‚Â¶netimi
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
    
    // Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Talepleri (Hem kurum hem veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri)
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
    
    // ÃƒÂ„Ã‚Â°ki listeyi birleÃƒÂ…Ã‚ÂŸtir
    const talepler = [...sinavTalepleri, ...rehberTalepleri].sort((a, b) => {
      // ÃƒÂƒÃ‚Â–nce duruma gÃƒÂƒÃ‚Â¶re sÃƒÂ„Ã‚Â±rala
      const durumOrder = { 'beklemede': 1, 'onaylandi': 2, 'reddedildi': 3 };
      const durumDiff = durumOrder[a.durum] - durumOrder[b.durum];
      if (durumDiff !== 0) return durumDiff;
      
      // Sonra tarihe gÃƒÂƒÃ‚Â¶re sÃƒÂ„Ã‚Â±rala (en yeni en ÃƒÂƒÃ‚Â¼stte)
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
    console.error('Talep listesi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Talep YÃƒÂƒÃ‚Â¶netimi (Alias - /kurum/talepler ile aynÃƒÂ„Ã‚Â±)
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
    console.error('Talep listesi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Talep YanÃƒÂ„Ã‚Â±tla (Onayla/Reddet)
app.post('/kurum/talep-yanitla', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { talep_id, durum, yanit, talep_tipi } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'GeÃƒÂƒÃ‚Â§ersiz parametreler!' });
    }
    
    // Talep tipine gÃƒÂƒÃ‚Â¶re farklÃƒÂ„Ã‚Â± tablolardan gÃƒÂƒÃ‚Â¼ncelle
    if (talep_tipi === 'rehber') {
      // Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen talebi
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
      
      // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `ÃƒÂ¢Ã‚ÂœÃ‚Â… REHBER ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRETMEN TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
            `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¨ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â« Öğrenci: ${talep.ogrenci_adi}\n` +
            `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš Rehber: ${talep.rehber_ad_soyad || 'Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen'}\n` +
            `ÃƒÂ¢Ã‚ÂœÃ‚Â… Durum: OnaylandÃƒÂ„Ã‚Â±\n\n` +
            (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Kurum YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
            `Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen yetkisi aktif hale getirilmiÃƒÂ…Ã‚ÂŸtir.`
          : `ÃƒÂ¢Ã‚ÂÃ‚ÂŒ REHBER ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRETMEN TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z REDDEDÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
            `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¨ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â« Öğrenci: ${talep.ogrenci_adi}\n` +
            `ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Durum: Reddedildi\n\n` +
            (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Kurum YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
            `Daha fazla bilgi iÃƒÂƒÃ‚Â§in lÃƒÂƒÃ‚Â¼tfen bizimle iletiÃƒÂ…Ã‚ÂŸime geÃƒÂƒÃ‚Â§iniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
          .then(result => console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderildi:', result))
          .catch(error => console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ WhatsApp bildirimi hatasÃƒÂ„Ã‚Â±:', error));
      }
      
    } else {
      // Sınav talebi (eski kod)
      await dbRun(
        `UPDATE sinav_talepleri 
         SET durum = ?, yanit = ?, yanitlanma_tarihi = datetime('now')
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al (WhatsApp bildirimi iÃƒÂƒÃ‚Â§in)
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
      
      // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (arka planda)
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `ÃƒÂ¢Ã‚ÂœÃ‚Â… TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
            `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš Sınav: ${talep.sinav_adi}\n` +
            `ÃƒÂ¢Ã‚ÂœÃ‚Â… Durum: OnaylandÃƒÂ„Ã‚Â±\n\n` +
            (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Kurum YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
            `Sınav erişiminiz aktif hale getirilmiÃƒÂ…Ã‚ÂŸtir. ÃƒÂ„Ã‚Â°yi sınavlar dileriz! ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â“`
          : `ÃƒÂ¢Ã‚ÂÃ‚ÂŒ TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z REDDEDÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
            `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš Sınav: ${talep.sinav_adi}\n` +
            `ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Durum: Reddedildi\n\n` +
            (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Kurum YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
            `Daha fazla bilgi iÃƒÂƒÃ‚Â§in lÃƒÂƒÃ‚Â¼tfen bizimle iletiÃƒÂ…Ã‚ÂŸime geÃƒÂƒÃ‚Â§iniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `talep_${durum}`)
          .then(result => console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderildi:', result))
          .catch(error => console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ WhatsApp bildirimi hatasÃƒÂ„Ã‚Â±:', error));
      }
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep başarıyla onaylandÃƒÂ„Ã‚Â±!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Talep yanÃƒÂ„Ã‚Â±tlama hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Talep iÃƒÂ…Ã‚ÂŸlenirken bir hata oluştu!' });
  }
});

// Kurum - Veli Listesi API (Rehber Talep iÃƒÂƒÃ‚Â§in)
app.get('/kurum/veliler-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¡ Veli listesi API ÃƒÂƒÃ‚Â§aÃƒÂ„Ã‚ÂŸrÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±');
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
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… ${veliler.length} veli bulundu`);
    res.json(veliler);
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Veli listesi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Listesi API
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
    console.error('Rehber listesi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - TÃƒÂƒÃ‚Â¼m Öğrenciler API (Kurum + Veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri)
app.get('/kurum/tum-ogrenciler-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¡ TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler API ÃƒÂƒÃ‚Â§aÃƒÂ„Ã‚ÂŸrÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±');
    
    // Veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri
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
      console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… ${veliOgrencileri.length} veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencisi bulundu`);
    } catch (error) {
      console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri yÃƒÂƒÃ‚Â¼kleme hatasÃƒÂ„Ã‚Â±:', error);
    }
    
    // Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri
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
      console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… ${kurumOgrencileri.length} kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencisi bulundu`);
    } catch (error) {
      console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri yÃƒÂƒÃ‚Â¼kleme hatasÃƒÂ„Ã‚Â±:', error);
    }
    
    // TC bazlÃƒÂ„Ã‚Â± tekrarlarÃƒÂ„Ã‚Â± temizle
    const tumOgrenciler = temizleOgrenciTekrarlari(veliOgrencileri, kurumOgrencileri);
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Toplam ${tumOgrenciler.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci dÃƒÂƒÃ‚Â¶ndÃƒÂƒÃ‚Â¼rÃƒÂƒÃ‚Â¼lÃƒÂƒÃ‚Â¼yor`);
    
    res.json(tumOgrenciler);
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci listesi hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Veli bilgisi hatasÃƒÂ„Ã‚Â±:', error);
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
      return res.status(400).json({ success: false, message: 'Telefon numarasÃƒÂ„Ã‚Â± gerekli!' });
    }
    
    // Telefon numarasÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizle (.0 gibi ekleri kaldÃƒÂ„Ã‚Â±r)
    let temizTelefon = telefon.toString().trim();
    if (temizTelefon.endsWith('.0')) {
      temizTelefon = temizTelefon.replace('.0', '');
    }
    const telefonNokta = temizTelefon + '.0';
    
    // Telefon numarasÃƒÂ„Ã‚Â± ile veli ara - hem temiz hem de .0 formatÃƒÂ„Ã‚Â±nda ara
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
    console.error('Telefon ile veli arama hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Öğrenci listesi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmene Talep GÃƒÂƒÃ‚Â¶nder
app.post('/kurum/rehber-talep-gonder', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id, ogrenci_id, rehber_ogretmen_id, ogrenci_no, ad_soyad, sinif, okul, mesaj, ogrenci_kaynak } = req.body;
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¥ Talep gÃƒÂƒÃ‚Â¶nderme isteÃƒÂ„Ã‚ÂŸi:', { veli_id, ogrenci_id, rehber_ogretmen_id, ad_soyad, ogrenci_kaynak });
    
    if (!veli_id || !rehber_ogretmen_id || !ad_soyad) {
      return res.json({ success: false, message: 'Eksik bilgiler! (veli_id, rehber_ogretmen_id, ad_soyad gerekli)' });
    }
    
    // Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri iÃƒÂƒÃ‚Â§in ogrenci_id NULL olabilir
    const kullanilacakOgrenciId = (ogrenci_kaynak === 'kurum') ? null : ogrenci_id;
    
    // AynÃƒÂ„Ã‚Â± talep var mÃƒÂ„Ã‚Â± kontrol et (ogrenci_id varsa) - Beklemede VEYA OnaylÃƒÂ„Ã‚Â± talep kontrolÃƒÂƒÃ‚Â¼
    if (kullanilacakOgrenciId) {
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi')
      `, [kullanilacakOgrenciId, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in bu rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in bu rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene zaten onaylÃƒÂ„Ã‚Â± bir talep var!' });
        }
      }
    } else {
      // Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri iÃƒÂƒÃ‚Â§in ad_soyad ve veli_id ile kontrol et
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ad_soyad = ? AND veli_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi') AND ogrenci_id IS NULL
      `, [ad_soyad, veli_id, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in bu rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in bu rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene zaten onaylÃƒÂ„Ã‚Â± bir talep var!' });
        }
      }
    }
    
    // Talep oluştur
    // rehber_id ve rehber_ogretmen_id aynÃƒÂ„Ã‚Â± deÃƒÂ„Ã‚ÂŸer (kurum tarafÃƒÂ„Ã‚Â±ndan gÃƒÂƒÃ‚Â¶nderildiÃƒÂ„Ã‚ÂŸi iÃƒÂƒÃ‚Â§in)
    await dbRun(`
      INSERT INTO ogrenci_talepleri 
      (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum, mesaj)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'beklemede', ?)
    `, [kullanilacakOgrenciId, ogrenci_no || '', ad_soyad, sinif || '', okul || '', veli_id, rehber_ogretmen_id, rehber_ogretmen_id, mesaj || '']);
    
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Talep başarıyla oluşturuldu');
    
    // Veli ve rehber bilgilerini al
    const veli = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [veli_id]);
    const rehber = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [rehber_ogretmen_id]);
    
    // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (arka planda)
    if (veli && veli.telefon) {
      const veliMesaj = `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â© YENÃƒÂ„Ã‚Â° REHBER ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRETMEN TALEBÃƒÂ„Ã‚Â°\n\n` +
        `Merhaba ${veli.ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
        `Kurum tarafÃƒÂ„Ã‚Â±ndan sizin adınÃƒÂ„Ã‚Â±za rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen yetki talebi gÃƒÂƒÃ‚Â¶nderilmiÃƒÂ…Ã‚ÂŸtir.\n\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Öğrenci: ${ad_soyad}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¨ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â« Rehber: ${rehber?.ad_soyad || 'Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen'}\n\n` +
        `Talebiniz onaylandÃƒÂ„Ã‚Â±ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±nda rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciniz hakkÃƒÂ„Ã‚Â±nda bilgilere eriÃƒÂ…Ã‚ÂŸebilecektir.`;
      
      whatsappBildirimGonder(veli.telefon, veliMesaj, 'rehber_talep_kurum')
        .then(result => console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Veli WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderildi:', result))
        .catch(error => console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Veli WhatsApp bildirimi hatasÃƒÂ„Ã‚Â±:', error));
    }
    
    if (rehber && rehber.telefon) {
      const rehberMesaj = `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â© YENÃƒÂ„Ã‚Â° ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â° YETKÃƒÂ„Ã‚Â° TALEBÃƒÂ„Ã‚Â°\n\n` +
        `Merhaba ${rehber.ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmenimiz'},\n\n` +
        `Kurum tarafÃƒÂ„Ã‚Â±ndan size yeni bir ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci yetki talebi gÃƒÂƒÃ‚Â¶nderilmiÃƒÂ…Ã‚ÂŸtir.\n\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Öğrenci: ${ad_soyad}\n` +
        `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¨ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â©ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â§ Veli: ${veli?.ad_soyad || 'Veli'}\n` +
        `${sinif ? `ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš SÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f: ${sinif}\n` : ''}` +
        `${okul ? `ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â« Okul: ${okul}\n` : ''}` +
        `${mesaj ? `\nÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Mesaj: ${mesaj}\n` : ''}\n` +
        `LÃƒÂƒÃ‚Â¼tfen veli panelinden talebi inceleyip onaylayÃƒÂ„Ã‚Â±n veya reddedin.`;
      
      whatsappBildirimGonder(rehber.telefon, rehberMesaj, 'rehber_talep_kurum')
        .then(result => console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Rehber WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderildi:', result))
        .catch(error => console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Rehber WhatsApp bildirimi hatasÃƒÂ„Ã‚Â±:', error));
    }
    
    res.json({ 
      success: true, 
      message: 'Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene talep başarıyla gÃƒÂƒÃ‚Â¶nderildi!' 
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Rehber talep gÃƒÂƒÃ‚Â¶nderme hatasÃƒÂ„Ã‚Â±:', error);
    console.error('Hata detayÃƒÂ„Ã‚Â±:', error.message);
    console.error('Stack trace:', error.stack);
    res.json({ 
      success: false, 
      message: `Talep gÃƒÂƒÃ‚Â¶nderilirken bir hata oluştu: ${error.message}` 
    });
  }
});

// Kurum - Öğrenci KayıtlarÃƒÂ„Ã‚Â± YÃƒÂƒÃ‚Â¶netimi
// API: Kurum Öğrenci KayıtlarÃƒÂ„Ã‚Â± (JSON)
app.get('/kurum/ogrenci-kayitlari-api', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY ogrenci_adi_soyadi ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci kayıtlarÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('API veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri hatasÃƒÂ„Ã‚Â±:', error);
    res.json([]);
  }
});

app.get('/kurum/ogrenci-kayitlari', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY created_at DESC');
    
    // Benzersiz sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f listesi
    const siniflar = [...new Set(ogrenciler.map(o => o.sinif).filter(s => s))].sort();
    
    // Session mesajlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± al ve hemen temizle
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
    console.error('Öğrenci kayıtlarÃƒÂ„Ã‚Â± listesi hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Öğrenci kayıt ekleme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Kayıt eklenirken bir hata oluştu: ' + error.message });
  }
});

// Kurum - HesapsÃƒÂ„Ã‚Â±z Velileri Kontrol Et
// ESKÃƒÂ„Ã‚Â° TELEFON BAZLI SÃƒÂ„Ã‚Â°STEM KALDIRILDI - SADECE TC BAZLI SÃƒÂ„Ã‚Â°STEM KULLANILIYOR

// Kurum - Veli GiriÃƒÂ…Ã‚ÂŸ Bilgisi Getir (ESKÃƒÂ„Ã‚Â° - KALDIRILDI)
app.get('/kurum/veli-giris-bilgisi', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    let { telefon } = req.query;
    
    if (!telefon) {
      return res.json({ success: false, message: 'Telefon numarasÃƒÂ„Ã‚Â± gerekli!' });
    }
    
    // Telefon formatÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizle (.0 ile biten)
    telefon = telefon.toString().trim();
    const telefonTemiz = telefon.endsWith('.0') ? telefon.replace('.0', '') : telefon;
    const telefonNokta = telefonTemiz + '.0';
    
    // Veli hesabÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± bul - hem temiz hem de .0 formatÃƒÂ„Ã‚Â±nda ara
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
    
    // ÃƒÂ„Ã‚Â°lk şifre hash'i
    const ilkSifreHash = '$2b$10$';  // bcrypt baÃƒÂ…Ã‚ÂŸlangÃƒÂ„Ã‚Â±cÃƒÂ„Ã‚Â±
    const defaultPassword = 'Veli2024!';
    
    // ÃƒÂ…Ã‚Âifre deÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸtirilmiÃƒÂ…Ã‚ÂŸ mi kontrol et
    // (Basit kontrol: created_at ile password_hash hash'i aynÃƒÂ„Ã‚Â± zamanda mÃƒÂ„Ã‚Â± oluşturulmuÃƒÂ…Ã‚ÂŸ)
    // Daha gÃƒÂƒÃ‚Â¼venli: password_hash'i "Veli2024!" ile karÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±laÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±r
    const sifreDegismis = !await bcrypt.compare(defaultPassword, veli.password_hash);
    
    // Username'deki .0 formatÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizle
    let usernameTemiz = veli.username.toString();
    if (usernameTemiz.endsWith('.0')) {
      usernameTemiz = usernameTemiz.replace('.0', '');
    }
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚ÂÃƒÂ¯Ã‚Â¸Ã‚Â VELÃƒÂ„Ã‚Â° BÃƒÂ„Ã‚Â°LGÃƒÂ„Ã‚Â°SÃƒÂ„Ã‚Â° GÃƒÂƒÃ‚Â–STERÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°`);
    console.log(`   Telefon: ${telefon}`);
    console.log(`   Username (orijinal): ${veli.username}`);
    console.log(`   Username (temiz): ${usernameTemiz}`);
    console.log(`   ÃƒÂ…Ã‚Âifre deÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ: ${sifreDegismis ? 'Evet' : 'HayÃƒÂ„Ã‚Â±r'}`);
    
    res.json({
      success: true,
      hesapVar: true,
      username: usernameTemiz,
      sifre: defaultPassword,
      sifreDegismis: sifreDegismis
    });
  } catch (error) {
    console.error('Veli bilgi getirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Öğrenci Kayıt GÃƒÂƒÃ‚Â¼ncelle
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
    console.error('Öğrenci kayıt gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'GÃƒÂƒÃ‚Â¼ncelleme sırasında bir hata oluştu!' });
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
    console.error('Öğrenci kayıt silme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Silme sırasında bir hata oluştu!' });
  }
});

// Kurum - TÃƒÂƒÃ‚ÂœM Öğrenci KayıtlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± Sil
app.post('/kurum/ogrenci-kayitlari-tumunu-sil', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { onayKodu } = req.body;
    
    // GÃƒÂƒÃ‚Â¼venlik kontrolÃƒÂƒÃ‚Â¼: "SÃƒÂ„Ã‚Â°L" yazmasÃƒÂ„Ã‚Â± gerekiyor
    if (onayKodu !== 'SÃƒÂ„Ã‚Â°L') {
      return res.json({ success: false, message: 'Onay kodu hatalÃƒÂ„Ã‚Â±! "SÃƒÂ„Ã‚Â°L" yazmanÃƒÂ„Ã‚Â±z gerekiyor.' });
    }
    
    // KaÃƒÂƒÃ‚Â§ kayıt var?
    const kayitSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    
    // TÃƒÂƒÃ‚Â¼m kayıtlarÃƒÂ„Ã‚Â± sil
    await dbRun('DELETE FROM ogrenci_kayitlari');
    
    console.log(`\nÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  TÃƒÂƒÃ‚ÂœM ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â° KAYITLARI SÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NDÃƒÂ„Ã‚Â°!`);
    console.log(`   Silinen kayıt sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±: ${kayitSayisi.sayi}`);
    console.log(`   Yapan kullanıcı: ${req.session.username}\n`);
    
    res.json({ 
      success: true, 
      message: `${kayitSayisi.sayi} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci kaydÃƒÂ„Ã‚Â± başarıyla silindi!` 
    });
  } catch (error) {
    console.error('Toplu silme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Silme iÃƒÂ…Ã‚ÂŸlemi sırasında bir hata oluştu!' });
  }
});

// Kurum - Excel Import
app.post('/kurum/ogrenci-import-excel', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
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
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ Toplam sayfa: ${totalPages}`);
    
    // Her sayfayÃƒÂ„Ã‚Â± ayrÃƒÂ„Ã‚Â± PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya adı: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join('uploads', 'sinav-sonuclari', sayfaFileName);
      
      // KlasÃƒÂƒÃ‚Â¶r yoksa oluştur
      const dir = path.dirname(sayfaYolu);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â“ Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join('uploads', 'sinav-sonuclari', orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // VeritabanÃƒÂ„Ã‚Â±na kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // GeÃƒÂƒÃ‚Â§ici dosyayÃƒÂ„Ã‚Â± sil
    fs.unlinkSync(req.file.path);
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… PDF başarıyla ${totalPages} sayfaya ayrÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme (analiz/pattern seÃƒÂƒÃ‚Â§imi) ekranÃƒÂ„Ã‚Â±na yÃƒÂƒÃ‚Â¶nlendir
        redirectTo: `/kurum/sinav-sonuc-yukle/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ PDF ayÃƒÂ„Ã‚Â±rma hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ESKÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEM (Yedek olarak kalÃƒÂ„Ã‚Â±yor)
app.post('/kurum/sinav-sonuc-yukle-analiz', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
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
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ Toplam sayfa: ${totalPages}`);
    
    // Sadece ilk sayfayÃƒÂ„Ã‚Â± analiz et
    const singlePagePdf = await PDFDocument.create();
    const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [0]);
    singlePagePdf.addPage(copiedPage);
    const singlePageBytes = await singlePagePdf.save();
    
    // GeÃƒÂƒÃ‚Â§ici dosya oluştur
    const tempFileName = `temp_analyze_sinav_${Date.now()}.pdf`;
    const tempFilePath = path.join('uploads', tempFileName);
    fs.writeFileSync(tempFilePath, singlePageBytes);
    
    // Text ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar - HÃƒÂ„Ã‚Â°BRÃƒÂ„Ã‚Â°T YÃƒÂƒÃ‚Â–NTEM
    const extractionResult = await extractTextHybrid(tempFilePath);
    const text = extractionResult.text;
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ ÃƒÂ„Ã‚Â°lk sayfa text uzunluÃƒÂ„Ã‚ÂŸu: ${text.length} (YÃƒÂƒÃ‚Â¶ntem: ${extractionResult.method})`);
    
    if (extractionResult.garbled) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ÃƒÂ„Ã‚Â°lk sayfada encoding sorunu tespit edildi!');
      console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¡ Manuel giriÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶nerilir.');
    }
    
    // Potansiyel isim adaylarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± bul - YENÃƒÂ„Ã‚Â° GELÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚ÂMÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â SÃƒÂ„Ã‚Â°STEM
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const potansiyelIsimler = [];
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â‹ Analiz: ${lines.length} satÃƒÂ„Ã‚Â±r bulundu`);
    
    // 1. GELÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚ÂMÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚Â FÃƒÂ„Ã‚Â°LTRELEME: Yeni looksLikeName fonksiyonunu kullan
    for (let i = 0; i < Math.min(lines.length, 80); i++) { // 80 satÃƒÂ„Ã‚Â±ra ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kardÃƒÂ„Ã‚Â±k
      const line = lines[i];
      
      // ÃƒÂ„Ã‚Â°sim gibi mi kontrol et (yeni fonksiyon)
      if (!looksLikeName(line)) continue;
      
      // ÃƒÂ„Ã‚Â°smi temizle (yeni fonksiyon)
      const cleanLine = cleanExtractedName(line);
      if (!cleanLine || cleanLine.length < 5) continue;
      
      // Kelime sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± kontrolÃƒÂƒÃ‚Â¼
      const words = cleanLine.split(/\s+/);
      const wordCount = words.length;
      
      // GÃƒÂƒÃ‚Â¼ven seviyesi hesapla
      let confidence = 'medium';
      
      // Sadece harf ve boÃƒÂ…Ã‚ÂŸluk + 2-3 kelime = yÃƒÂƒÃ‚Â¼ksek gÃƒÂƒÃ‚Â¼ven
      if (wordCount === 2 || wordCount === 3) {
        confidence = 'high';
      }
      // 4-6 kelime = dÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¼k gÃƒÂƒÃ‚Â¼ven
      else if (wordCount > 3) {
        confidence = 'low';
      }
      
      potansiyelIsimler.push({
        text: cleanLine,
        lineNumber: i,
        confidence: confidence,
        originalLine: line // Orijinal satÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â± da sakla
      });
      
      console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â“ Aday ${potansiyelIsimler.length}: "${cleanLine}" (SatÃƒÂ„Ã‚Â±r: ${i}, GÃƒÂƒÃ‚Â¼ven: ${confidence})`);
    }
    
    // 2. HiÃƒÂƒÃ‚Â§ isim bulunamadıysa, en uzun satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶ster (fallback)
    if (potansiyelIsimler.length === 0) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â HiÃƒÂƒÃ‚Â§ isim adayÃƒÂ„Ã‚Â± bulunamadı, en uzun satÃƒÂ„Ã‚Â±rlar gÃƒÂƒÃ‚Â¶steriliyor...');
      
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
      
      console.log(`   ÃƒÂ¢Ã‚Â†Ã‚Â’ ${potansiyelIsimler.length} uzun satÃƒÂ„Ã‚Â±r eklendi (fallback)`);
    }
    
    // ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â  AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± sistem ile ilk sayfayÃƒÂ„Ã‚Â± test et
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â  AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± sistem ile ilk sayfa test ediliyor...');
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
      console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Otomatik pattern bulundu: "${testMatch.extractedName}" (GÃƒÂƒÃ‚Â¼ven: ${(autoConfidence * 100).toFixed(0)}%)`);
    } else {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Otomatik pattern bulunamadı, manuel seÃƒÂƒÃ‚Â§im gerekli');
    }
    
    // GeÃƒÂƒÃ‚Â§ici dosyalarÃƒÂ„Ã‚Â± temizle
    fs.unlinkSync(tempFilePath);
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… ${potansiyelIsimler.length} potansiyel isim bulundu`);
    potansiyelIsimler.forEach(p => console.log(`   - ${p.text} (satÃƒÂ„Ã‚Â±r ${p.lineNumber}, gÃƒÂƒÃ‚Â¼ven: ${p.confidence})`));
    
    res.json({
      success: true,
      data: {
        totalPages: totalPages,
        uploadPath: req.file.path,
        originalName: req.file.originalname,
        sinavId: sinav_id,
        potansiyelIsimler: potansiyelIsimler.slice(0, 15), // ÃƒÂ„Ã‚Â°lk 15 aday
        ornekText: text.substring(0, 500), // Kullanıcıya gÃƒÂƒÃ‚Â¶ster
        allLines: lines, // TÃƒÂƒÃ‚Â¼m satÃƒÂ„Ã‚Â±rlarÃƒÂ„Ã‚Â± da gÃƒÂƒÃ‚Â¶nder (frontend iÃƒÂƒÃ‚Â§in)
        autoSelectedPattern: autoSelectedPattern, // ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â¯ Otomatik seÃƒÂƒÃ‚Â§ilen pattern
        useAutoMode: autoConfidence >= 0.85 // %85+ gÃƒÂƒÃ‚Â¼ven varsa direkt kullan
      }
    });
    
  } catch (error) {
    console.error('SonuÃƒÂƒÃ‚Â§ analiz hatasÃƒÂ„Ã‚Â±:', error);
    
    // DosyayÃƒÂ„Ã‚Â± temizle
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Analiz sırasında bir hata oluştu: ' + error.message 
    });
  }
});

// Kurum - SonuÃƒÂƒÃ‚Â§ PDF Kaydet (TÃƒÂƒÃ‚Â¼m sayfalarÃƒÂ„Ã‚Â± iÃƒÂ…Ã‚ÂŸle, eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtir, kaydet)
app.post('/kurum/sinav-sonuc-yukle-kaydet', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath, selectedPattern, selectedLineNumber, manuelEslesmeler } = req.body;
    
    if (!sinav_id || !pdfPath) {
      return res.status(400).json({ success: false, error: 'Sınav ID veya PDF dosya yolu eksik!' });
    }
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â  AKILLI SINAV SONUÃƒÂƒÃ‚Â‡LARI YÃƒÂƒÃ‚ÂœKLENÃƒÂ„Ã‚Â°YOR');
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Sınav ID:', sinav_id);
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… PDF Path:', pdfPath);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â¯ Mod: AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± Cascade Matching (5 strateji)');
    
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
    
    // SonuÃƒÂƒÃ‚Â§ klasÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼ oluştur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // PDF'i yÃƒÂƒÃ‚Â¼kle
    if (!fs.existsSync(pdfPath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasÃƒÂ„Ã‚Â± bulunamadı!' });
    }
    
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ Toplam sayfa: ${totalPages}`);
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â‚ SonuÃƒÂƒÃ‚Â§ klasÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼: ${sonucKlasoru}`);
    
    // Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeleri map'e ÃƒÂƒÃ‚Â§evir (sayfa numarasÃƒÂ„Ã‚Â± ÃƒÂ¢Ã‚Â†Ã‚Â’ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci ID)
    const manuelMap = {};
    if (manuelEslesmeler && Array.isArray(manuelEslesmeler)) {
      manuelEslesmeler.forEach(m => {
        if (m.sayfaNo && m.ogrenciId) {
          manuelMap[m.sayfaNo] = m.ogrenciId;
        }
      });
      console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â ${Object.keys(manuelMap).length} manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme alÃƒÂ„Ã‚Â±ndÃƒÂ„Ã‚Â±`);
    }
    
    // Her sayfayÃƒÂ„Ã‚Â± iÃƒÂ…Ã‚ÂŸle
    for (let i = 0; i < totalPages; i++) {
      try {
        const sayfaNo = i + 1;
        console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ Sayfa ${sayfaNo}/${totalPages} iÃƒÂ…Ã‚ÂŸleniyor...`);
        
        // Bu sayfayÃƒÂ„Ã‚Â± ayrÃƒÂ„Ã‚Â± bir PDF olarak oluştur
        const singlePagePdf = await PDFDocument.create();
        const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
        singlePagePdf.addPage(copiedPage);
        const singlePageBytes = await singlePagePdf.save();
        
        // GeÃƒÂƒÃ‚Â§ici dosya adı oluştur
        const tempFileName = `temp_sinav_page_${sayfaNo}_${Date.now()}.pdf`;
        const tempFilePath = path.join('uploads', tempFileName);
        fs.writeFileSync(tempFilePath, singlePageBytes);
        
        // Bu sayfadan text ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar
        const extractionResult = await extractTextHybrid(tempFilePath);
        const text = extractionResult.text;
        const isGarbled = extractionResult.garbled || false;
        
        let ogrenciId = null;
        let ogrenciAdi = 'BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN';
        let kaynak = 'kurum';
        let usedStrategy = null;
        let confidence = 0;
        let extractedName = '';
        
        // Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme var mÃƒÂ„Ã‚Â± kontrol et
        if (manuelMap[sayfaNo]) {
          // Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme var
          ogrenciId = manuelMap[sayfaNo];
          const ogrenci = await dbGet('SELECT * FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          if (ogrenci) {
            ogrenciAdi = ogrenci.ogrenci_adi_soyadi;
            console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            matchedCount++;
            usedStrategy = 'Manuel';
            confidence = 1.0;
          } else {
            console.log(`ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme geÃƒÂƒÃ‚Â§ersiz! Öğrenci ID ${ogrenciId} bulunamadı.`);
            unmatchedCount++;
          }
        } else {
          // ÃƒÂ°Ã‚ÂŸÃ‚Â§Ã‚Â  AKILLI CASCADE MATCHING KULLAN
          const matchResult = await intelligentCascadeMatching(
            text, 
            sinav_id, 
            req.session.userId,
            tempFilePath
          );
          
          if (matchResult && matchResult.confidence >= 0.75) {
            // BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â± eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme
            ogrenciId = matchResult.ogrenciId;
            ogrenciAdi = matchResult.ogrenciAd;
            kaynak = matchResult.kaynak;
            extractedName = matchResult.extractedName;
            confidence = matchResult.confidence;
            usedStrategy = matchResult.usedStrategy;
            
            // Strateji istatistiklerini gÃƒÂƒÃ‚Â¼ncelle
            strategyStats[usedStrategy] = (strategyStats[usedStrategy] || 0) + 1;
            
            console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme: ${ogrenciAdi} (Strateji: ${usedStrategy}, GÃƒÂƒÃ‚Â¼ven: ${(confidence * 100).toFixed(0)}%)`);
            matchedCount++;
          } else {
            // EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z
            console.log(`ÃƒÂ¢Ã‚ÂÃ‚ÂŒ TÃƒÂƒÃ‚Â¼m stratejiler baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z - Manuel gerekli`);
            unmatchedCount++;
          }
        }
        
        // PDF'i kaydet
        const sanitizedName = ogrenciAdi.replace(/[^a-zA-ZÃƒÂƒÃ‚Â§ÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â±ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â¶ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂŸÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Â¼ÃƒÂƒÃ‚Âœ\s]/g, '').replace(/\s+/g, '_');
        const finalFileName = ogrenciId 
          ? `${sayfaNo}_${sanitizedName}_${ogrenciId}.pdf`
          : `${sayfaNo}_BILINMEYEN_${Date.now()}.pdf`;
        
        const finalFilePath = path.join(sonucKlasoru, finalFileName);
        fs.writeFileSync(finalFilePath, singlePageBytes);
        
        console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¾ PDF kaydedildi: ${finalFileName}`);
        
        // VeritabanÃƒÂ„Ã‚Â±na kaydet (eÃƒÂ„Ã‚ÂŸer eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme varsa)
        if (ogrenciId) {
          try {
            // sinav_katilimcilari tablosunu gÃƒÂƒÃ‚Â¼ncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi' 
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [finalFilePath, sinav_id, ogrenciId, kaynak]);
            
            savedCount++;
            console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… VeritabanÃƒÂ„Ã‚Â±na kaydedildi`);
          } catch (dbError) {
            console.error(`ÃƒÂ¢Ã‚ÂÃ‚ÂŒ VeritabanÃƒÂ„Ã‚Â± kayıt hatasÃƒÂ„Ã‚Â±:`, dbError);
          }
        }
        
        // SonuÃƒÂƒÃ‚Â§ listesine ekle
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
        
        // GeÃƒÂƒÃ‚Â§ici dosyayÃƒÂ„Ã‚Â± temizle
        fs.unlinkSync(tempFilePath);
        
      } catch (pageError) {
        console.error(`ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sayfa ${i + 1} iÃƒÂ…Ã‚ÂŸlenirken hata:`, pageError);
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
    
    // SınavÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle (sonuc_yuklendi = 1)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    // YÃƒÂƒÃ‚Â¼klenen PDF dosyasÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± temizle
    try {
      fs.unlinkSync(pdfPath);
    } catch (cleanError) {
      console.error('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â GeÃƒÂƒÃ‚Â§ici PDF temizlenemedi:', cleanError);
    }
    
    console.log('\nÃƒÂ¢Ã‚ÂœÃ‚Â… ÃƒÂ„Ã‚Â°ÃƒÂ…Ã‚ÂLEM TAMAMLANDI!');
    console.log(`   Toplam sayfa: ${totalPages}`);
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸen: ${matchedCount}`);
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeyen: ${unmatchedCount}`);
    console.log(`   Kaydedilen: ${savedCount}`);
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ Strateji ÃƒÂ„Ã‚Â°statistikleri:`);
    Object.entries(strategyStats).forEach(([strategy, count]) => {
      console.log(`   ${strategy}: ${count} sayfa`);
    });
    
    res.json({
      success: true,
      message: `${matchedCount}/${totalPages} sayfa otomatik eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirildi (AkÃƒÂ„Ã‚Â±llÃƒÂ„Ã‚Â± Sistem)`,
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
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ SonuÃƒÂƒÃ‚Â§ kaydetme hatasÃƒÂ„Ã‚Â±:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Kaydetme sırasında bir hata oluştu: ' + error.message 
    });
  }
});

// Kurum - Manuel Sınav SonuÃƒÂƒÃ‚Â§ EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme
app.post('/kurum/sinav-manuel-eslestir/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    const { eslesmeler } = req.body;
    
    if (!eslesmeler || eslesmeler.length === 0) {
      return res.json({ success: false, message: 'EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme bilgisi eksik!' });
    }
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â— MANUEL EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTIRME (Sınav ID: ${sinavId})`);
    console.log(`   ${eslesmeler.length} adet eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme yapÃƒÂ„Ã‚Â±lacak`);
    
    let basarili = 0;
    let hatali = 0;
    
    for (const eslesme of eslesmeler) {
      try {
        const { sayfaNo, pdfYolu, ogrenciId, kaynak } = eslesme;
        
        console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ Sayfa ${sayfaNo}:`);
        console.log(`      - Öğrenci ID: ${ogrenciId}`);
        console.log(`      - Kaynak: ${kaynak}`);
        console.log(`      - PDF Yolu: ${pdfYolu}`);
        console.log(`      - Dosya var mÃƒÂ„Ã‚Â±: ${pdfYolu ? fs.existsSync(pdfYolu) : 'PDF yolu boÃƒÂ…Ã‚ÂŸ'}`);
        
        // PDF dosyasÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± yeni isimle kaydet
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
            const safeIsim = ogrenci.ad_soyad.replace(/[^a-zA-ZÃƒÂƒÃ‚Â§ÃƒÂƒÃ‚Â‡ÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â±ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â¶ÃƒÂƒÃ‚Â–ÃƒÂ…Ã‚ÂŸÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Â¼ÃƒÂƒÃ‚Âœ\s]/g, '').replace(/\s+/g, '_');
            const yeniDosyaAdi = `${safeIsim}_${timestamp}.pdf`;
            const yeniDosyaYolu = path.join(sonucKlasoru, yeniDosyaAdi);
            
            // DosyayÃƒÂ„Ã‚Â± kopyala
            fs.copyFileSync(pdfYolu, yeniDosyaYolu);
            
            // sinav_katilimcilari tablosunu gÃƒÂƒÃ‚Â¼ncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi'
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [yeniDosyaYolu, sinavId, ogrenciId, kaynak]);
            
            console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${ogrenci.ad_soyad}`);
            basarili++;
          } else {
            console.log(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Öğrenci bulunamadı: ${ogrenciId}`);
            hatali++;
          }
        } else {
          console.log(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ PDF dosyasÃƒÂ„Ã‚Â± bulunamadı: ${pdfYolu}`);
          hatali++;
        }
      } catch (error) {
        console.error(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme hatasÃƒÂ„Ã‚Â±:`, error);
        hatali++;
      }
    }
    
    // SınavÃƒÂ„Ã‚Â±n sonuc_yuklendi durumunu gÃƒÂƒÃ‚Â¼ncelle (ama henÃƒÂƒÃ‚Â¼z yayÃƒÂ„Ã‚Â±nlanmamÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1, sonuc_yayinlandi = 0 WHERE id = ?', [sinavId]);
    
    // ÃƒÂ¢Ã‚ÂœÃ‚Â… GÃƒÂƒÃ‚ÂœNCEL ÃƒÂ„Ã‚Â°STATÃƒÂ„Ã‚Â°STÃƒÂ„Ã‚Â°KLERÃƒÂ„Ã‚Â° HESAPLA
    const istatistikler = await dbGet(`
      SELECT 
        COUNT(*) as toplam,
        SUM(CASE WHEN pdf_path IS NOT NULL AND pdf_path != '' THEN 1 ELSE 0 END) as eslesmis,
        SUM(CASE WHEN pdf_path IS NULL OR pdf_path = '' THEN 1 ELSE 0 END) as eslesmemis
      FROM sinav_katilimcilari
      WHERE sinav_id = ?
    `, [sinavId]);
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ MANUEL EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTIRME TAMAMLANDI:`);
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${basarili}`);
    console.log(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ HatalÃƒÂ„Ã‚Â±: ${hatali}`);
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ GÃƒÂƒÃ‚ÂœNCEL DURUM:`);
    console.log(`   Toplam KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±: ${istatistikler.toplam}`);
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸen: ${istatistikler.eslesmis}`);
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeyen: ${istatistikler.eslesmemis}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirildi! ${hatali > 0 ? `(${hatali} hata)` : ''}`,
      matchedCount: istatistikler.eslesmis || 0,
      unmatchedCount: istatistikler.eslesmemis || 0,
      totalCount: istatistikler.toplam || 0
    });
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ Kurum - EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmemiÃƒÂ…Ã‚ÂŸ PDF SayfalarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± Listele
app.get('/kurum/sinav-eslesmemis-pdfler/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ TÃƒÂƒÃ‚ÂœM PDF SAYFALARI LÃƒÂ„Ã‚Â°STELENÃƒÂ„Ã‚Â°YOR (EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸen + EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeyen):', sinavId);
    
    // TÃƒÂƒÃ‚ÂœM yÃƒÂƒÃ‚Â¼klenmiÃƒÂ…Ã‚ÂŸ PDF'leri al - HEM EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂEN HEM EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂMEYEN
    // pdf_path NULL olanlar = henÃƒÂƒÃ‚Â¼z eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmemiÃƒÂ…Ã‚ÂŸ (BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN)
    // pdf_path dolu olanlar = eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ
    // BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN olanlar = PDF var ama ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmemiÃƒÂ…Ã‚ÂŸ
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
          ELSE 'BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN'
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
          WHEN sk.pdf_path IS NOT NULL AND (ok.ogrenci_adi_soyadi = 'BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN' OR o.ad_soyad = 'BÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NMEYEN' OR (ok.ogrenci_adi_soyadi IS NULL AND o.ad_soyad IS NULL)) THEN 0
          WHEN sk.pdf_path IS NULL THEN 1
          ELSE 2
        END,
        sk.id
    `, [sinavId]);
    
    // EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirilebilir ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri al (tÃƒÂƒÃ‚Â¼m katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±lar)
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
    
    // Orijinal PDF yolunu bul - eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ herhangi bir ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinin PDF'inden al
    let orijinalPdfYolu = null;
    
    // ÃƒÂƒÃ‚Â–nce sinavlar tablosuna bak
    const sinav = await dbGet('SELECT dosya_yolu FROM sinavlar WHERE id = ?', [sinavId]);
    if (sinav && sinav.dosya_yolu) {
        orijinalPdfYolu = sinav.dosya_yolu;
    } else {
        // Yoksa eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ herhangi bir ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinin PDF'ini al
        const eslesmisOgrenci = await dbGet(
            'SELECT pdf_path FROM sinav_katilimcilari WHERE sinav_id = ? AND pdf_path IS NOT NULL LIMIT 1',
            [sinavId]
        );
        if (eslesmisOgrenci && eslesmisOgrenci.pdf_path) {
            orijinalPdfYolu = eslesmisOgrenci.pdf_path;
        }
    }
    
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â„ EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmemiÃƒÂ…Ã‚ÂŸ: ${eslesmemisOgrenciler.length}`);
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¥ Toplam Öğrenci: ${tumOgrenciler.length}`);
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â PDF Yolu: ${orijinalPdfYolu}`);
    
    res.json({
      success: true,
      data: {
        eslesmemisPdfler: eslesmemisOgrenciler,
        tumOgrenciler: tumOgrenciler,
        orijinalPdfYolu: orijinalPdfYolu
      }
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmemiÃƒÂ…Ã‚ÂŸ PDF listeleme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, error: error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â„ Kurum - Mevcut PDF'i BaÃƒÂ…Ã‚ÂŸka Öğrenciye Ata
app.post('/kurum/sinav-pdf-yeniden-eslestir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { katilimci_id, yeni_ogrenci_id, yeni_kaynak, sinav_id } = req.body;
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â„ PDF YENÃƒÂ„Ã‚Â°DEN EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°YOR`);
    console.log(`   KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± ID: ${katilimci_id}`);
    console.log(`   Yeni Öğrenci ID: ${yeni_ogrenci_id}`);
    console.log(`   Yeni Kaynak: ${yeni_kaynak}`);
    
    // Eski katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±n PDF yolunu al
    const eskiKatilimci = await dbGet('SELECT pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimci_id]);
    
    if (!eskiKatilimci || !eskiKatilimci.pdf_path) {
      return res.json({ success: false, message: 'PDF bulunamadı!' });
    }
    
    // Yeni ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci bilgilerini al
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
    const guvenliIsim = yeniOgrenci.ad_soyad.replace(/[^a-zA-Z0-9ÃƒÂ„Ã‚ÂŸÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¶ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â°ÃƒÂ„Ã‚ÂÃƒÂƒÃ‚ÂœÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Â–ÃƒÂƒÃ‚Â‡\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // DosyayÃƒÂ„Ã‚Â± kopyala/taÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±
    const eskiTamYol = path.join(__dirname, eskiPdfPath);
    if (fs.existsSync(eskiTamYol)) {
      fs.copyFileSync(eskiTamYol, yeniDosyaYolu);
    }
    
    // VeritabanÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    
    // Yeni ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in kayıt oluştur/gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, yeni_ogrenci_id, yeni_kaynak]);
    
    // Eski kaydÃƒÂ„Ã‚Â± temizle (PDF'i kaldÃƒÂ„Ã‚Â±r)
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = NULL, sonuc_durumu = 'bekleniyor'
      WHERE id = ?
    `, [katilimci_id]);
    
    // Eski dosyayÃƒÂ„Ã‚Â± sil
    if (fs.existsSync(eskiTamYol)) {
      fs.unlinkSync(eskiTamYol);
    }
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… PDF başarıyla "${yeniOgrenci.ad_soyad}" iÃƒÂƒÃ‚Â§in atandÃƒÂ„Ã‚Â±`);
    
    res.json({ 
      success: true, 
      message: `ÃƒÂ¢Ã‚ÂœÃ‚Â… PDF başarıyla "${yeniOgrenci.ad_soyad}" ile eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirildi!`
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ PDF yeniden eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Kurum - Tek Öğrenci ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§in PDF EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtir
app.post('/kurum/sinav-tek-ogrenci-eslestir', requireAuth, upload.single('pdf'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    const pdfFile = req.file;
    
    if (!pdfFile) {
      return res.json({ success: false, message: 'PDF dosyasÃƒÂ„Ã‚Â± yÃƒÂƒÃ‚Â¼klenmedi!' });
    }
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ TEK ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â° EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME`);
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
    
    // Sınav klasÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼ oluştur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sinavKlasoru)) {
      fs.mkdirSync(sinavKlasoru, { recursive: true });
    }
    
    // Dosya adınÃƒÂ„Ã‚Â± oluştur
    const guvenliIsim = ogrenci.ad_soyad.replace(/[^a-zA-Z0-9ÃƒÂ„Ã‚ÂŸÃƒÂƒÃ‚Â¼ÃƒÂ…Ã‚ÂŸÃƒÂƒÃ‚Â¶ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â°ÃƒÂ„Ã‚ÂÃƒÂƒÃ‚ÂœÃƒÂ…Ã‚ÂÃƒÂƒÃ‚Â–ÃƒÂƒÃ‚Â‡\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // DosyayÃƒÂ„Ã‚Â± taÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±
    fs.copyFileSync(pdfFile.path, yeniDosyaYolu);
    fs.unlinkSync(pdfFile.path); // GeÃƒÂƒÃ‚Â§ici dosyayÃƒÂ„Ã‚Â± sil
    
    // VeritabanÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, ogrenci_id, kaynak]);
    
    // SınavÃƒÂ„Ã‚Â±n sonuc_yuklendi durumunu gÃƒÂƒÃ‚Â¼ncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${ogrenci.ad_soyad} iÃƒÂƒÃ‚Â§in PDF eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirildi`);
    
    res.json({ 
      success: true, 
      message: `ÃƒÂ¢Ã‚ÂœÃ‚Â… ${ogrenci.ad_soyad} iÃƒÂƒÃ‚Â§in sonuÃƒÂƒÃ‚Â§ başarıyla eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirildi!`
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Tek ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¢ Kurum - Sınav SonuçlarınÃƒÂ„Ã‚Â± YayÃƒÂ„Ã‚Â±nla (Velilere gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼r hale getir)
app.post('/kurum/sinav-sonuclari-yayinla/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¢ SINAV SONUÃƒÂƒÃ‚Â‡LARI YAYINLANIYOR:', sinavId);
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'Sınav bulunamadı!' });
    }
    
    if (!sinav.sonuc_yuklendi) {
      return res.json({ success: false, message: 'HenÃƒÂƒÃ‚Â¼z sonuÃƒÂƒÃ‚Â§ yÃƒÂƒÃ‚Â¼klenmemiÃƒÂ…Ã‚ÂŸ!' });
    }
    
    if (sinav.sonuc_yayinlandi) {
      return res.json({ success: false, message: 'SonuÃƒÂƒÃ‚Â§lar zaten yayÃƒÂ„Ã‚Â±nlanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ!' });
    }
    
    // EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ sonuÃƒÂƒÃ‚Â§ sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± kontrol et
    const eslesmisler = await dbAll(`
      SELECT COUNT(*) as sayi 
      FROM sinav_katilimcilari 
      WHERE sinav_id = ? AND pdf_path IS NOT NULL
    `, [sinavId]);
    
    const eslesmeSayisi = eslesmisler[0]?.sayi || 0;
    
    if (eslesmeSayisi === 0) {
      return res.json({ success: false, message: 'HiÃƒÂƒÃ‚Â§ eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ sonuÃƒÂƒÃ‚Â§ yok! LÃƒÂƒÃ‚Â¼tfen ÃƒÂƒÃ‚Â¶nce eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme yapÃƒÂ„Ã‚Â±n.' });
    }
    
    // SınavÃƒÂ„Ã‚Â± yayÃƒÂ„Ã‚Â±nla
    await dbRun('UPDATE sinavlar SET sonuc_yayinlandi = 1 WHERE id = ?', [sinavId]);
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… YayÃƒÂ„Ã‚Â±nlandÃƒÂ„Ã‚Â±: ${eslesmeSayisi} sonuÃƒÂƒÃ‚Â§ velilere gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼r hale geldi`);
    
    res.json({ 
      success: true, 
      message: `ÃƒÂ¢Ã‚ÂœÃ‚Â… SonuÃƒÂƒÃ‚Â§lar yayÃƒÂ„Ã‚Â±nlandÃƒÂ„Ã‚Â±! ${eslesmeSayisi} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinin velisi artÃƒÂ„Ã‚Â±k sonuçları gÃƒÂƒÃ‚Â¶rebilir.`
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ YayÃƒÂ„Ã‚Â±nlama hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Sınav SonuÃƒÂƒÃ‚Â§ WhatsApp Bildirim GÃƒÂƒÃ‚Â¶nder
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
    
    // Sonucu yÃƒÂƒÃ‚Â¼klenmiÃƒÂ…Ã‚ÂŸ katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â± al (hem kurum hem veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri)
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
      return res.json({ success: false, message: 'Sonucu yÃƒÂƒÃ‚Â¼klenmiÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci bulunamadı!' });
    }
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â± WHATSAPP BÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°RÃƒÂ„Ã‚Â°MLERÃƒÂ„Ã‚Â° GÃƒÂƒÃ‚Â–NDERÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°YOR`);
    console.log(`   Sınav: ${sinav.ad}`);
    console.log(`   Toplam katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±: ${katilimcilar.length}\n`);
    
    let basarili = 0;
    let basarisiz = 0;
    
    // Her ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in veli telefonuna bildirim gÃƒÂƒÃ‚Â¶nder
    for (const katilimci of katilimcilar) {
      // Veli telefonu ÃƒÂƒÃ‚Â¶ncelikli, yoksa ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci telefonu
      const telefon = katilimci.veli_telefon || katilimci.ogrenci_telefon;
      
      console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â ${katilimci.ogrenci_adi} (Veli: ${katilimci.veli_adi || 'Bilinmiyor'}) ÃƒÂ¢Ã‚Â†Ã‚Â’ ${telefon || 'TELEFON YOK'}`);
      
      if (!telefon) {
        console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ${katilimci.ogrenci_adi} - Telefon numarasÃƒÂ„Ã‚Â± yok!`);
        basarisiz++;
        continue;
      }
      
      // WhatsApp mesajÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± oluştur
      const mesaj = `ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â“ Sınav Sonucu AÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±klandÃƒÂ„Ã‚Â±

SayÃƒÂ„Ã‚Â±n ${katilimci.veli_adi || 'Veli'},

${katilimci.ogrenci_adi} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinizin sınav sonucu aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±klanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±r.

ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Âš Sınav: ${sinav.ad}
ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¥ Sonucu gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼ntÃƒÂƒÃ‚Â¼lemek iÃƒÂƒÃ‚Â§in sisteme giriÃƒÂ…Ã‚ÂŸ yapÃƒÂ„Ã‚Â±n:
ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â‰ ${req.protocol}://${req.get('host')}/login

ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€ÃƒÂ¢Ã‚Â”Ã‚Â€
ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â« Sınav Merkezi`;
      
      // WhatsApp gÃƒÂƒÃ‚Â¶nder
      const result = await whatsappBildirimGonder(
        telefon,
        mesaj,
        'sinav_sonuc'
      );
      
      if (result.success) {
        console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… ${katilimci.ogrenci_adi} - ${telefon}`);
        basarili++;
        
        // Bildirim durumunu gÃƒÂƒÃ‚Â¼ncelle
        await dbRun(
          'UPDATE sinav_katilimcilari SET sonuc_durumu = ?, whatsapp_gonderim_tarihi = datetime("now") WHERE id = ?',
          ['bildirildi', katilimci.id]
        );
      } else {
        console.log(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ ${katilimci.ogrenci_adi} - ${telefon} - ${result.message}`);
        basarisiz++;
      }
      
      // API rate limit iÃƒÂƒÃ‚Â§in kÃƒÂƒÃ‚Â¼ÃƒÂƒÃ‚Â§ÃƒÂƒÃ‚Â¼k gecikme
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\nÃƒÂ¢Ã‚ÂœÃ‚Â… Bildirim gÃƒÂƒÃ‚Â¶nderimi tamamlandÃƒÂ„Ã‚Â±!`);
    console.log(`   BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${basarili}`);
    console.log(`   BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z: ${basarisiz}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} bildirim gÃƒÂƒÃ‚Â¶nderildi, ${basarisiz} baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z.`,
      basarili: basarili,
      basarisiz: basarisiz
    });
    
  } catch (error) {
    console.error('WhatsApp bildirim hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bildirim gÃƒÂƒÃ‚Â¶nderilirken bir hata oluştu!' });
  }
});

// Veli - Sınav Sonuçları
app.get('/veli/sinav-sonuclari', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â‹ SINAV SONUÃƒÂƒÃ‚Â‡LARI (Veli ID: ${req.session.userId}, Username: ${req.session.username})`);
    
    // 1. Veli'nin kendi eklediÃƒÂ„Ã‚ÂŸi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler (ogrenciler tablosu)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`   Veli ekledi: ${veliOgrencileri.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci`);
    
    // 2. Kurum tarafÃƒÂ„Ã‚Â±ndan eklenen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciler (TC eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi ile)
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
    console.log(`   Kurum ekledi: ${kurumOgrencileri.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci (TC eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme)`);
    
    // 3. ÃƒÂ„Ã‚Â°ki listeyi birleÃƒÂ…Ã‚ÂŸtir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ TOPLAM: ${ogrenciler.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci`);
    
    if (ogrenciler.length === 0) {
      return res.render('veli/sinav-sonuclari', {
        user: { username: req.session.username, type: req.session.userType },
        sonuclar: [],
        ogrenciler: [],
        error: 'HenÃƒÂƒÃ‚Â¼z ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci kaydÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±z bulunmuyor.',
        success: req.session.success
      });
    }
    
    // Veli'nin kendi eklediÃƒÂ„Ã‚ÂŸi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin sonuçları (ogrenciler tablosu)
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
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Veli ekledi: ${veliSonuclari.length} sonuÃƒÂƒÃ‚Â§`);
    
    // Kurum tarafÃƒÂ„Ã‚Â±ndan eklenen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin sonuçları (ogrenci_kayitlari tablosu)
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
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… Kurum ekledi: ${kurumSonuclari.length} sonuÃƒÂƒÃ‚Â§`);
    
    // ÃƒÂ„Ã‚Â°ki kaynaÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â± birleÃƒÂ…Ã‚ÂŸtir
    const sonuclar = [...veliSonuclari, ...kurumSonuclari].sort((a, b) => {
      return new Date(b.sinav_tarihi) - new Date(a.sinav_tarihi);
    });
    
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ Toplam: ${sonuclar.length} sonuÃƒÂƒÃ‚Â§`);
    
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
    console.error('Sınav sonuçları hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sınav sonuçları yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sınav SonuÃƒÂƒÃ‚Â§ PDF ÃƒÂ„Ã‚Â°ndir
app.get('/veli/sinav-sonuc-indir/:katilimciId', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const katilimciId = req.params.katilimciId;
    
    // ÃƒÂƒÃ‚Â–nce ogrenci_kaynak'a bak
    const katilimciBilgi = await dbGet('SELECT ogrenci_kaynak, ogrenci_id, pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    if (!katilimciBilgi) {
      return res.status(404).send('SonuÃƒÂƒÃ‚Â§ bulunamadı!');
    }
    
    let yetkiVar = false;
    
    // Kaynak'a gÃƒÂƒÃ‚Â¶re yetki kontrolÃƒÂƒÃ‚Â¼
    if (katilimciBilgi.ogrenci_kaynak === 'veli') {
      // Veli'nin kendi eklediÃƒÂ„Ã‚ÂŸi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci
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
    
    // PDF var mÃƒÂ„Ã‚Â± kontrol et
    if (!katilimciBilgi.pdf_path || !fs.existsSync(katilimciBilgi.pdf_path)) {
      return res.status(404).send('PDF dosyasÃƒÂ„Ã‚Â± bulunamadı!');
    }
    
    // PDF indirme kaydÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¼ncelle
    const simdi = new Date().toISOString();
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET 
        pdf_goruldu = 1,
        pdf_gorunme_tarihi = ?,
        pdf_indirilme_sayisi = COALESCE(pdf_indirilme_sayisi, 0) + 1
      WHERE id = ?
    `, [simdi, katilimciId]);
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¥ PDF ÃƒÂ„Ã‚Â°NDÃƒÂ„Ã‚Â°RME KAYDI`);
    console.log(`   KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± ID: ${katilimciId}`);
    console.log(`   Tarih: ${simdi}`);
    console.log(`   Veli ID: ${req.session.userId}`);
    
    // PDF'i indir
    res.download(katilimciBilgi.pdf_path, path.basename(katilimciBilgi.pdf_path), (err) => {
      if (err) {
        console.error('PDF indirme hatasÃƒÂ„Ã‚Â±:', err);
        res.status(500).send('PDF indirilemedi!');
      }
    });
    
  } catch (error) {
    console.error('PDF indirme hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Veli Profil
app.get('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Talep edilen sınavlarÃƒÂ„Ã‚Â± getir
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
    
    // Login hatalarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± filtrele - sadece profil ile ilgili hatalarÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶ster
    let error = req.session.error;
    if (error && (error.includes('Kullanıcı adı veya şifre') || error.includes('şifre hatalÃƒÂ„Ã‚Â±'))) {
      error = null; // Login hatalarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶sterme
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
    console.error('Profil hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Profil yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli Profil GÃƒÂƒÃ‚Â¼ncelleme
app.post('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, telefon, current_password, new_password } = req.body;
    
    if (!ad_soyad) {
      req.session.error = 'Ad Soyad alanı zorunludur';
      res.redirect('/veli/profil');
      return;
    }
    
    // ÃƒÂ…Ã‚Âifre değiştirme kontrolÃƒÂƒÃ‚Â¼
    if (new_password && new_password.trim() !== '') {
      if (!current_password || current_password.trim() === '') {
        req.session.error = 'ÃƒÂ…Ã‚Âifre değiştirmek iÃƒÂƒÃ‚Â§in mevcut şifrenizi girmelisiniz!';
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
        req.session.error = 'Mevcut şifreniz yanlÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Yeni şifreyi hashle
      const yeniSifreHash = await bcrypt.hash(new_password, 10);
      
      // Profil ve şifreyi gÃƒÂƒÃ‚Â¼ncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ?, password_hash = ? WHERE id = ?',
        [ad_soyad, telefon, yeniSifreHash, req.session.userId]
      );
      
      console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Veli şifre deÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸtirdi: User ID ${req.session.userId}`);
      req.session.success = 'Profil bilgileriniz ve şifreniz başarıyla güncellendi!';
    } else {
      // Sadece profil bilgilerini gÃƒÂƒÃ‚Â¼ncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ? WHERE id = ?',
        [ad_soyad, telefon, req.session.userId]
      );
      
      req.session.success = 'Profil bilgileriniz başarıyla güncellendi!';
    }
    
    res.redirect('/veli/profil');
  } catch (error) {
    console.error('Profil gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Öğrenci ekle sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Öğrenci Ekle (POST)
app.post('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    
    console.log('Öğrenci ekleme isteÃƒÂ„Ã‚ÂŸi:', { ad_soyad, tc_no, telefon, okul, sinif, veli_id: req.session.userId });
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Öğrenci adı soyadı, okul ve sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f zorunludur!';
      res.redirect('/veli/ogrenci-ekle');
      return;
    }
    
    // Öğrenci numarasÃƒÂ„Ã‚Â± oluştur
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
    console.error('Öğrenci ekleme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Öğrenci eklenirken bir hata oluştu: ' + error.message;
    res.redirect('/veli/ogrenci-ekle');
  }
});

// Veli - Öğrenci DÃƒÂƒÃ‚Â¼zenle (GET)
app.get('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [req.params.id, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciye yetki verilmiÃƒÂ…Ã‚ÂŸ rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmenleri getir
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
    console.error('Öğrenci dÃƒÂƒÃ‚Â¼zenle sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Öğrenci DÃƒÂƒÃ‚Â¼zenle (POST)
app.post('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    const ogrenciId = req.params.id;
    
    // Öğrencinin bu veliye ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait deÃƒÂ„Ã‚ÂŸil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = 'Öğrenci adı soyadı, okul ve sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f zorunludur!';
      res.redirect(`/veli/ogrenci-duzenle/${ogrenciId}`);
      return;
    }
    
    // Öğrenci gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(
      'UPDATE ogrenciler SET ad_soyad = ?, tc_no = ?, telefon = ?, okul = ?, sinif = ? WHERE id = ? AND veli_id = ?',
      [ad_soyad, tc_no, telefon, okul, sinif, ogrenciId, req.session.userId]
    );
    
    req.session.success = `${ad_soyad} başarıyla güncellendi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Öğrenci gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Öğrenci güncellenirken bir hata oluştu!';
    res.redirect(`/veli/ogrenci-duzenle/${req.params.id}`);
  }
});

// Veli - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Yetkisini KaldÃƒÂ„Ã‚Â±r
app.post('/veli/rehber-yetki-kaldir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â—Ã‚Â‘ÃƒÂ¯Ã‚Â¸Ã‚Â  Yetki kaldÃƒÂ„Ã‚Â±rma isteÃƒÂ„Ã‚ÂŸi:', { talepId, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â‹ Talep bulundu:', talep);
    
    if (!talep || talep.veli_id !== req.session.userId) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Yetki kontrolÃƒÂƒÃ‚Â¼ baÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±z');
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Talebi sil (yetkiyi kaldÃƒÂ„Ã‚Â±r)
    await dbRun('DELETE FROM ogrenci_talepleri WHERE id = ?', [talepId]);
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Yetki başarıyla kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±');
    
    res.json({ success: true, message: 'Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen yetkisi kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±!' });
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Yetki kaldÃƒÂ„Ã‚Â±rma hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Veli - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Sınav Sonucu GÃƒÂƒÃ‚Â¶rme Yetkisini DeÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸtir
app.post('/veli/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â„ SonuÃƒÂƒÃ‚Â§ yetkisi değiştirme isteÃƒÂ„Ã‚ÂŸi:', { talepId, yeniDurum: yeni_durum, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    if (!talep || talep.veli_id !== req.session.userId) {
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Yetkiyi gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Sınav sonucu gÃƒÂƒÃ‚Â¶rme yetkisi ${yeni_durum == 1 ? 'aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±' : 'kapatÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±'}`);
    res.json({ 
      success: true, 
      message: `Sınav sonucu gÃƒÂƒÃ‚Â¶rme yetkisi ${yeni_durum == 1 ? 'aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±' : 'kapatÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±'}!` 
    });
  } catch (error) {
    console.error('Yetki değiştirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Kurum - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmenler Listesi (Yetki YÃƒÂƒÃ‚Â¶netimi)
app.get('/kurum/rehber-ogretmenler', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Bu sayfaya erişim yetkiniz yok!');
  }
  
  try {
    // TÃƒÂƒÃ‚Â¼m onaylÃƒÂ„Ã‚Â± talepleri rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene gÃƒÂƒÃ‚Â¶re grupla
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
    
    // Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene gÃƒÂƒÃ‚Â¶re grupla
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
    console.error('Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen listesi hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Sınav Sonucu GÃƒÂƒÃ‚Â¶rme Yetkisini DeÃƒÂ„Ã‚ÂŸiÃƒÂ…Ã‚ÂŸtir
app.post('/kurum/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â„ Kurum - SonuÃƒÂƒÃ‚Â§ yetkisi değiştirme:', { talepId, yeniDurum: yeni_durum });
    
    // Yetkiyi gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… Sınav sonucu gÃƒÂƒÃ‚Â¶rme yetkisi ${yeni_durum == 1 ? 'aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±' : 'kapatÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±'}`);
    res.json({ 
      success: true, 
      message: `Sınav sonucu gÃƒÂƒÃ‚Â¶rme yetkisi ${yeni_durum == 1 ? 'aÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±' : 'kapatÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±'}!` 
    });
  } catch (error) {
    console.error('Yetki değiştirme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu!' });
  }
});

// Veli - Öğrenci Sil
app.post('/veli/ogrenci-sil/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.id;
    
    // Öğrencinin bu veliye ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait deÃƒÂ„Ã‚ÂŸil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Öğrenciyi sil
    await dbRun('DELETE FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    req.session.success = `${ogrenci.ad_soyad} başarıyla silindi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('Öğrenci silme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Öğrenci silinirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - TÃƒÂƒÃ‚Â¼m Sınav Takvimi (TÃƒÂƒÃ‚Â¼m Öğrenciler)
app.get('/veli/tum-sinav-takvimi', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    // Velinin tÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerini getir (her iki tablodan)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    const kurumOgrencileri = await dbAll(`
      SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif, tc_kimlik_no as tc_no
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
    `, [req.session.userId]);
    
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    // Her ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in sınav takvimini getir (her iki kaynaktan)
    let tumTakvim = [];
    try {
      // Veli eklediÃƒÂ„Ã‚ÂŸi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin sınavlarÃƒÂ„Ã‚Â±
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
      
      // Kurum eklediÃƒÂ„Ã‚ÂŸi ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin sınavlarÃƒÂ„Ã‚Â±
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
      
      console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… Veli Sınav Takvimi (User ID: ${req.session.userId}):`);
      console.log(`   Veli ekledi: ${veliTakvim.length} sınav`);
      console.log(`   Kurum ekledi: ${kurumTakvim.length} sınav`);
      console.log(`   Toplam: ${tumTakvim.length} sınav`);
      if (tumTakvim.length > 0) {
        tumTakvim.forEach(t => {
          console.log(`   - ${t.sinav_adi} | ${t.ogrenci_ad_soyad} | ${t.tarih} (${t.kaynak})`);
        });
      }
    } catch (error) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sınav takvimi sorgusu hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sınav takvimi sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Sınav Takvimi (Tek Öğrenci)
app.get('/veli/sinav-takvimi/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.ogrenci_id;
    
    // Öğrencinin bu veliye ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = 'Öğrenci bulunamadı veya size ait deÃƒÂ„Ã‚ÂŸil!';
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
      
      console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… Öğrenci Sınav Takvimi (Öğrenci ID: ${ogrenciId}):`);
      console.log(`   Toplam ${takvim.length} sınav bulundu`);
    } catch (error) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sınav takvimi sorgusu hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sınav takvimi sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Talepler hatasÃƒÂ„Ã‚Â±:', error);
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
      // Talebi onayla - ÃƒÂ„Ã‚Â°liÃƒÂ…Ã‚ÂŸki ogrenci_talepleri tablosunda durum='onaylandi' ile saklanÃƒÂ„Ã‚Â±r
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['onaylandi', id]);
      
      // Öğrenci bilgisini al
      const ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [talep.ogrenci_id]);
      
      // Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen bilgisini al
      const rehber = await dbGet('SELECT ad_soyad, brans FROM users WHERE id = ?', [talep.rehber_ogretmen_id]);
      
      req.session.success = `${ogrenci.ad_soyad} iÃƒÂƒÃ‚Â§in ${rehber.ad_soyad} (${rehber.brans}) rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen talebi onaylandÃƒÂ„Ã‚Â±!`;
    } else if (islem === 'reddet') {
      // Talebi reddet
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['reddedildi', id]);
      
      req.session.success = 'Talep reddedildi!';
    }
    
    res.redirect('/veli/talepler');
  } catch (error) {
    console.error('Talep iÃƒÂ…Ã‚ÂŸleme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Talep iÃƒÂ…Ã‚ÂŸlenirken bir hata oluştu!';
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
    
    // Kullanıcı bilgilerini al (telefon ve TC için)
    const kullanici = await dbGet('SELECT username, telefon FROM users WHERE id = ?', [req.session.userId]);
    if (!kullanici) {
      req.session.error = 'Kullanıcı bilgileri bulunamadı!';
      return res.redirect('/login');
    }
    
    // TC kimlik numarasını belirle: önce username'i dene, sonra telefon'u
    let tcKimlikNo = req.session.username;
    // Eğer username sayısal değilse veya telefon varsa, telefon'u kullan
    if (kullanici.telefon && (!/^\d+$/.test(req.session.username) || req.session.username.length !== 11)) {
      // Telefon numarasından TC çıkar (telefon formatı: 5XXXXXXXXX gibi)
      const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
      // Eğer telefon 11 haneli ise TC olabilir
      if (telefonTemiz.length === 11) {
        tcKimlikNo = telefonTemiz;
      }
    }
    
    console.log(`🔍 TC Kimlik No: ${tcKimlikNo} (username: ${req.session.username}, telefon: ${kullanici.telefon})`);
    
    // 1. Veli'nin kendi eklediği öğrenciler (ogrenciler tablosu)
    const veliOgrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`✅ Veli tablosundan ${veliOgrenciler.length} öğrenci bulundu`);
    
    // 2. Kurum tarafından eklenen öğrenciler (TC eşleşmesi ile)
    // Hem username hem de telefon ile eşleştir
    const kurumOgrenciler = await dbAll(`
      SELECT 
        id,
        ogrenci_adi_soyadi as ad_soyad,
        tc_kimlik_no as tc_no,
        sinif,
        'kurum' as kaynak
      FROM ogrenci_kayitlari 
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = REPLACE(?, '.0', '')
         OR (veli_telefon IS NOT NULL AND REPLACE(CAST(veli_telefon AS TEXT), '.0', '') = REPLACE(?, '.0', ''))
    `, [tcKimlikNo, kullanici.telefon ? kullanici.telefon.toString().replace(/\D/g, '') : '']);
    console.log(`✅ Kurum tablosundan ${kurumOgrenciler.length} öğrenci bulundu (TC: ${tcKimlikNo}, Telefon: ${kullanici.telefon})`);
    
    // 3. BirleÃƒÂ…Ã‚ÂŸtir
    const ogrenciler = [...veliOgrenciler, ...kurumOgrenciler];
    console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ TOPLAM ${ogrenciler.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci`);
    
    // 4. ÃƒÂ„Ã‚Â°statistikler
    for (let ogrenci of ogrenciler) {
      if (ogrenci.kaynak === 'kurum') {
        // Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencisi - sinav_katilimcilari'ndan sınavlarÃƒÂ„Ã‚Â± al
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
        // Veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencisi - eski sistem
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
    
    // Bekleyen talep sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± al
    const bekleyenTalepler = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE veli_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    // YaklaÃƒÂ…Ã‚ÂŸan sınavlar (sınav takvimi henÃƒÂƒÃ‚Â¼z kullanÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±yor, boÃƒÂ…Ã‚ÂŸ liste gÃƒÂƒÃ‚Â¶nder)
    let yaklasanSinavlar = [];
    try {
      yaklasanSinavlar = await dbAll(`
        SELECT * FROM sinav_takvimi 
        WHERE tarih >= date('now') 
        ORDER BY tarih ASC 
        LIMIT 5
      `);
    } catch (sinavErr) {
      console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Sınav takvimi sorgulanamadı (henÃƒÂƒÃ‚Â¼z kullanÃƒÂ„Ã‚Â±lmÃƒÂ„Ã‚Â±yor)');
      yaklasanSinavlar = [];
    }
    
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â‰ Dashboard render ediliyor!');
    // Dashboard'da gösterilecek username: Her zaman kullanıcının giriş yaptığı username'i göster
    // Kullanıcı hangi username ile giriş yaptıysa, o gösterilmeli
    const displayUsername = req.session.username;
    
    res.render('veli_dashboard', { 
      user: { username: displayUsername, type: req.session.userType },
      ogrenciler: ogrenciler,
      bekleyenTalepSayisi: bekleyenTalepler ? bekleyenTalepler.sayi : 0,
      yaklasanSinavlar: yaklasanSinavlar
    });
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Dashboard HATA:', error);
    // Hata durumunda boÃƒÂ…Ã‚ÂŸ listelerle render et (redirect dÃƒÂƒÃ‚Â¶ngÃƒÂƒÃ‚Â¼sÃƒÂƒÃ‚Â¼nÃƒÂƒÃ‚Â¼ ÃƒÂƒÃ‚Â¶nlemek iÃƒÂƒÃ‚Â§in)
    // Kullanıcı bilgilerini tekrar al
    let displayUsername = req.session.username;
    try {
      const kullanici = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      // Eğer username 11 haneli bir sayı değilse ve telefon 11 haneli ise, telefon'u göster
      if (!/^\d{11}$/.test(req.session.username) && kullanici && kullanici.telefon) {
        const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
        if (telefonTemiz.length === 11) {
          displayUsername = telefonTemiz;
        }
      }
    } catch (err) {
      console.error('Kullanıcı bilgisi alınamadı:', err);
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
    
    // ÃƒÂ„Ã‚Â°statistikler - ONAYLANMIÃƒÂ…Ã‚Â ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â°LER
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
    
    // Sınav sonuçları sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â± (onaylÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin PDF sonuçları)
    const sinavSonucSayisi = await dbGet(`
      SELECT COUNT(DISTINCT sk.id) as sayi 
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_talepleri t ON sk.ogrenci_id = t.ogrenci_id AND sk.ogrenci_kaynak = 'veli'
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
    `, [req.session.userId]);
    
    // Bekleyen talepler sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±
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
    console.error('Dashboard hatasÃƒÂ„Ã‚Â±:', error);
    // Sonsuz dÃƒÂƒÃ‚Â¶ngÃƒÂƒÃ‚Â¼yÃƒÂƒÃ‚Â¼ ÃƒÂƒÃ‚Â¶nlemek iÃƒÂƒÃ‚Â§in boÃƒÂ…Ã‚ÂŸ veri ile render et
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

// Sınav YÃƒÂƒÃ‚Â¼kleme
// Rehber - Sınav YÃƒÂƒÃ‚Â¼kleme Route'larÃƒÂ„Ã‚Â± KALDIRILDI (Sadece kurum yapabilir)

// Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen - Sınav Sonuçları
app.get('/rehber/sinav-sonuclari', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // OnaylÃƒÂ„Ã‚Â± VE yetkisi aktif olan ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin sınav sonuçlarınÃƒÂ„Ã‚Â± getir
    // Veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri
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
    
    // Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri iÃƒÂƒÃ‚Â§in (ogrenci_kaynak = 'kurum' olanlar)
    // Not: Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri iÃƒÂƒÃ‚Â§in ogrenci_id NULL olabilir, bu durumda ad_soyad ile eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme yapÃƒÂ„Ã‚Â±lmalÃƒÂ„Ã‚Â±
    // ÃƒÂ…Ã‚Âimdilik sadece veli ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerini gÃƒÂƒÃ‚Â¶steriyoruz
    // TODO: Kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri iÃƒÂƒÃ‚Â§in sinav_katilimcilari tablosuna ogrenci_ad_soyad kolonu eklenebilir
    
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
    console.error('Sınav sonuçları hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sınav sonuçları yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Öğrenci Listesi
app.get('/rehber/ogrenciler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // VELÃƒÂ„Ã‚Â° ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â°LERÃƒÂ„Ã‚Â° (ogrenciler tablosundan)
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
    
    // KURUM ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂRENCÃƒÂ„Ã‚Â°LERÃƒÂ„Ã‚Â° (ogrenci_kayitlari tablosundan - ogrenci_id NULL olanlar)
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
    
    // BirleÃƒÂ…Ã‚ÂŸtir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    res.render('ogrenci_listesi', { 
      user: { username: req.session.username },
      ogrenciler: ogrenciler
    });
  } catch (error) {
    console.error('Öğrenci listesi hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Öğrenci listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Öğrenci Detay/Profil
app.get('/rehber/ogrenci/:ogrenci_id', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci bilgileri - VELÃƒÂ„Ã‚Â° TARAFINDAN ONAYLANMIÃƒÂ…Ã‚Â MI KONTROL ET
    const onay = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenciId, req.session.userId, 'onaylandi']
    );
    
    if (!onay) {
      req.session.error = 'Öğrenci bulunamadı veya size ait deÃƒÂ„Ã‚ÂŸil!';
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
    console.error('Öğrenci detay hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Öğrenci bilgileri yüklenirken bir hata oluştu!';
    res.redirect('/rehber/ogrenciler');
  }
});

// Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen Profili
app.get('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // BaÃƒÂ…Ã‚ÂŸka sayfalardan gelen hatalarÃƒÂ„Ã‚Â± filtrele - sadece profil ile ilgili hatalarÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶ster
    let error = req.session.error;
    if (error && (
      error.includes('Kullanıcı adı veya şifre') || 
      error.includes('şifre hatalÃƒÂ„Ã‚Â±') ||
      error.includes('Veli listesi yüklenirken') ||
      error.includes('Öğrenci listesi yüklenirken') ||
      error.includes('Sınav sonuçları yüklenirken')
    )) {
      error = null; // BaÃƒÂ…Ã‚ÂŸka sayfalardan gelen hatalarÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶sterme
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
    console.error('Profil hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Profil yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Profil GÃƒÂƒÃ‚Â¼ncelleme
app.post('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { ad_soyad, kurum, telefon, brans, mezuniyet } = req.body;
    
    // Zorunlu alanlarÃƒÂ„Ã‚Â± kontrol et
    if (!ad_soyad || !kurum || !telefon || !brans) {
      req.session.error = 'LÃƒÂƒÃ‚Â¼tfen tÃƒÂƒÃ‚Â¼m zorunlu alanlarÃƒÂ„Ã‚Â± doldurun (Ad Soyad, Kurum, Telefon, BranÃƒÂ…Ã‚ÂŸ)';
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
    console.error('Profil gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Profil güncellenirken bir hata oluştu!';
    res.redirect('/rehber/profil');
  }
});

// Veli ÃƒÂ„Ã‚Â°letiÃƒÂ…Ã‚ÂŸim Listesi
app.get('/rehber/veliler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Sadece onaylanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencilerin velilerini gÃƒÂƒÃ‚Â¶ster
    // ÃƒÂƒÃ‚Â–nce veli ID'lerini al
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
    
    // Her veli iÃƒÂƒÃ‚Â§in bilgileri ve ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± al
    const veliler = [];
    for (const veliIdRow of veliIds) {
      const veliId = veliIdRow.veli_id;
      
      // Veli bilgilerini al
      const veli = await dbGet('SELECT id, username, ad_soyad, email, telefon, created_at FROM users WHERE id = ? AND user_type = ?', [veliId, 'veli']);
      
      if (!veli) continue;
      
      // Öğrenci sayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± al
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
      
      // GeÃƒÂƒÃ‚Â§ersiz email ve telefon formatlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± filtrele
      let email = veli.email;
      if (email && (email.includes('@temp.com') || email.includes('.0@') || email.match(/^\d+\.0@/))) {
        email = null; // GeÃƒÂƒÃ‚Â§ersiz email'leri gÃƒÂƒÃ‚Â¶sterme
      }
      
      let telefon = veli.telefon;
      if (telefon && (telefon.toString().endsWith('.0') || telefon.toString().includes('.0@'))) {
        telefon = null; // GeÃƒÂƒÃ‚Â§ersiz telefon formatlarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± gÃƒÂƒÃ‚Â¶sterme
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
    
    // Ad soyad'a gÃƒÂƒÃ‚Â¶re sÃƒÂ„Ã‚Â±rala
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
    console.error('Veli listesi hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Veli listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen - Gelen Talepler
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
    console.error('Rehber talep listesi hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Talep listesi yüklenirken bir hata oluştu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen - Talep YanÃƒÂ„Ã‚Â±tla (Onayla/Reddet)
app.post('/rehber/talep-yanitla', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { talep_id, durum, yanit } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'GeÃƒÂƒÃ‚Â§ersiz parametreler!' });
    }
    
    // Talebin bu rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmene ait olduÃƒÂ„Ã‚ÂŸunu kontrol et
    const talep = await dbGet(`
      SELECT t.*, u.telefon as veli_telefon, u.ad_soyad as veli_ad_soyad
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      WHERE t.id = ? AND t.rehber_ogretmen_id = ?
    `, [talep_id, req.session.userId]);
    
    if (!talep) {
      return res.json({ success: false, message: 'Talep bulunamadı veya size ait deÃƒÂ„Ã‚ÂŸil!' });
    }
    
    // Talebi gÃƒÂƒÃ‚Â¼ncelle
    await dbRun(`
      UPDATE ogrenci_talepleri 
      SET durum = ?, mesaj = ?
      WHERE id = ? AND rehber_ogretmen_id = ?
    `, [durum, yanit || '', talep_id, req.session.userId]);
    
    // WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nder (arka planda)
    if (talep.veli_telefon) {
      const mesaj = durum === 'onaylandi' 
        ? `ÃƒÂ¢Ã‚ÂœÃ‚Â… TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z ONAYLANDI!\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
          `Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen talebinizi onayladı.\n\n` +
          `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Öğrenci: ${talep.ad_soyad}\n` +
          (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
          `ArtÃƒÂ„Ã‚Â±k rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciniz hakkÃƒÂ„Ã‚Â±nda bilgilere eriÃƒÂ…Ã‚ÂŸebilecektir.`
        : `ÃƒÂ¢Ã‚ÂÃ‚ÂŒ TALEBÃƒÂ„Ã‚Â°NÃƒÂ„Ã‚Â°Z REDDEDÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'DeÃƒÂ„Ã‚ÂŸerli Velimiz'},\n\n` +
          `Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen talebinizi reddetti.\n\n` +
          `ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Öğrenci: ${talep.ad_soyad}\n` +
          (yanit ? `ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¬ Rehber ÃƒÂƒÃ‚Â–ÃƒÂ„Ã‚ÂŸretmen YanÃƒÂ„Ã‚Â±tÃƒÂ„Ã‚Â±: ${yanit}\n\n` : '') +
          `Daha fazla bilgi iÃƒÂƒÃ‚Â§in lÃƒÂƒÃ‚Â¼tfen rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen ile iletiÃƒÂ…Ã‚ÂŸime geÃƒÂƒÃ‚Â§iniz.`;
      
      whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
        .then(result => console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Veli WhatsApp bildirimi gÃƒÂƒÃ‚Â¶nderildi:', result))
        .catch(error => console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Veli WhatsApp bildirimi hatasÃƒÂ„Ã‚Â±:', error));
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep başarıyla onaylandÃƒÂ„Ã‚Â±!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Rehber talep yanÃƒÂ„Ã‚Â±tlama hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Talep iÃƒÂ…Ã‚ÂŸlenirken bir hata oluştu!' });
  }
});

// Öğrenci Ekleme - KALDIRILDI (Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen artÃƒÂ„Ã‚Â±k direkt ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci ekleyemez, sadece talep gÃƒÂƒÃ‚Â¶nderebilir)
// app.get('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Öğrenci Arama API - KALDIRILDI (Öğrenci ekleme ÃƒÂƒÃ‚Â¶zelliÃƒÂ„Ã‚ÂŸi kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±)
// app.post('/rehber/ogrenci-ara', ...) - KALDIRILDI

// Öğrenci Ekleme Talebi GÃƒÂƒÃ‚Â¶nder (Rehber -> Veli) - YENÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEM
app.post('/rehber/ogrenci-talep', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â¨ TALEP GÃƒÂƒÃ‚Â–NDERME ÃƒÂ„Ã‚Â°STEÃƒÂ„Ã‚ÂÃƒÂ„Ã‚Â°:', {
      userId: req.session.userId,
      ogrenci_id: req.body.ogrenci_id
    });
    
    // Profil kontrolÃƒÂƒÃ‚Â¼
    const kullanici = await dbGet('SELECT ad_soyad, kurum, telefon, brans FROM users WHERE id = ?', [req.session.userId]);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¤ Kullanıcı Profili:', kullanici);
    
    if (!kullanici.ad_soyad || !kullanici.kurum || !kullanici.telefon || !kullanici.brans) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Profil eksik!');
      return res.json({ success: false, message: 'ÃƒÂƒÃ‚Â–nce profil bilgilerinizi eksiksiz doldurmalÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±z!' });
    }
    
    const { ogrenci_id } = req.body;
    
    if (!ogrenci_id) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Öğrenci ID eksik!');
      return res.json({ success: false, message: 'Öğrenci ID eksik' });
    }
    
    // Öğrenciyi bul
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¨ÃƒÂ¢Ã‚Â€Ã‚ÂÃƒÂ°Ã‚ÂŸÃ‚ÂÃ‚Â“ Öğrenci:', ogrenci);
    
    if (!ogrenci) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Öğrenci bulunamadı!');
      return res.json({ success: false, message: 'Öğrenci bulunamadı' });
    }
    
    // Zaten onaylanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ mÃƒÂ„Ã‚Â±?
    const onayliTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'onaylandi']
    );
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… OnaylÃƒÂ„Ã‚Â± talep kontrolÃƒÂƒÃ‚Â¼:', onayliTalep);
    
    if (onayliTalep) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Zaten kayıtlÃƒÂ„Ã‚Â±!');
      return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci zaten size kayıtlÃƒÂ„Ã‚Â±' });
    }
    
    // Bekleyen talep var mÃƒÂ„Ã‚Â± kontrol et
    const bekleyenTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'beklemede']
    );
    console.log('ÃƒÂ¢Ã‚ÂÃ‚Â³ Bekleyen talep kontrolÃƒÂƒÃ‚Â¼:', bekleyenTalep);
    
    if (bekleyenTalep) {
      console.log('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Zaten bekleyen talep var!');
      return res.json({ success: false, message: 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iÃƒÂƒÃ‚Â§in zaten bekleyen bir talebiniz var' });
    }
    
    // Talep oluştur (Veli onaylayacak) - BaÃƒÂ…Ã‚ÂŸka branÃƒÂ…Ã‚ÂŸta atanmÃƒÂ„Ã‚Â±ÃƒÂ…Ã‚ÂŸ olsa bile talep gÃƒÂƒÃ‚Â¶nderilebilir
    console.log('ÃƒÂ°Ã‚ÂŸÃ‚Â’Ã‚Â¾ Talep oluşturuluyor:', {
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
    
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Talep başarıyla oluşturuldu!\n');
    
    res.json({ 
      success: true, 
      message: `${ogrenci.ad_soyad} iÃƒÂƒÃ‚Â§in talep veliye gÃƒÂƒÃ‚Â¶nderildi! Veli onayladıÃƒÂ„Ã‚ÂŸÃƒÂ„Ã‚Â±nda bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenciyi gÃƒÂƒÃ‚Â¶rebilirsiniz.`
    });
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Talep gÃƒÂƒÃ‚Â¶nderme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: `Talep hatasÃƒÂ„Ã‚Â±: ${error.message}` });
  }
});

// Öğrenci Ekleme POST - KALDIRILDI (Rehber ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸretmen artÃƒÂ„Ã‚Â±k direkt ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci ekleyemez, sadece talep gÃƒÂƒÃ‚Â¶nderebilir)
// app.post('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// Sınav Sonuçları (Excel/CSV)
app.get('/veli/sinav-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci kontrolÃƒÂƒÃ‚Â¼
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinin sonuçlarına erişim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // Sınav sonuçlarınÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â§ek
    const sonuclar = await dbAll(`
      SELECT ss.*, s.ad as sinav_adi, s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY ss.created_at DESC
    `, [ogrenciId]);
    
    // Sonuçları sınav bazÃƒÂ„Ã‚Â±nda grupla ve JSON parse et
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
    console.error('SonuÃƒÂƒÃ‚Â§ gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼ntÃƒÂƒÃ‚Â¼leme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// PDF Sınav Sonuçları
app.get('/veli/pdf-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // Öğrenci kontrolÃƒÂƒÃ‚Â¼
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencinin sonuçlarına erişim yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // PDF sınav sonuçlarınÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â§ek
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
    console.error('PDF sonuÃƒÂƒÃ‚Â§ gÃƒÂƒÃ‚Â¶rÃƒÂƒÃ‚Â¼ntÃƒÂƒÃ‚Â¼leme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Bir hata oluştu!';
    res.redirect('/veli/dashboard');
  }
});

// Sınav Takvimi SayfasÃƒÂ„Ã‚Â±
app.get('/sinav-takvimi', async (req, res) => {
  try {
    // TÃƒÂƒÃ‚Â¼m sınavlarÃƒÂ„Ã‚Â± getir (hem tekil hem paket sınavlarÃƒÂ„Ã‚Â±)
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
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â… SINAV TAKVÃƒÂ„Ã‚Â°MÃƒÂ„Ã‚Â° YÃƒÂƒÃ‚ÂœKLEME`);
    console.log(`   Toplam Sınav: ${sinavlar.length}`);
    console.log(`   Paket SınavlarÃƒÂ„Ã‚Â±: ${sinavlar.filter(s => s.paket_id).length}`);
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
    console.error('Sınav takvimi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu: ' + error.message);
  }
});

// ESKÃƒÂ„Ã‚Â° Sınav Paketleri Route - KALDIRILDI (Yeni route satÃƒÂ„Ã‚Â±r 729'da)

// ============ DUYURU YÃƒÂƒÃ‚Â–NETÃƒÂ„Ã‚Â°MÃƒÂ„Ã‚Â° (KURUM) ============

// Kurum - Duyuru YÃƒÂƒÃ‚Â¶netimi SayfasÃƒÂ„Ã‚Â±
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
    console.error('Duyuru yÃƒÂƒÃ‚Â¶netimi hatasÃƒÂ„Ã‚Â±:', error);
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
      return res.json({ success: false, message: 'BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k zorunludur!' });
    }
    
    await dbRun(
      'INSERT INTO duyurular (baslik, icerik, tarih, sira, aktif) VALUES (?, ?, ?, ?, ?)',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0]
    );
    
    console.log(`\nÃƒÂ¢Ã‚ÂœÃ‚Â… YENÃƒÂ„Ã‚Â° DUYURU EKLENDÃƒÂ„Ã‚Â°`);
    console.log(`   BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k: ${baslik}`);
    
    req.session.success = 'Duyuru başarıyla eklendi!';
    res.json({ success: true, message: 'Duyuru başarıyla eklendi!' });
  } catch (error) {
    console.error('Duyuru ekleme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Kurum - Duyuru GÃƒÂƒÃ‚Â¼ncelle (POST)
app.post('/kurum/duyuru-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const duyuruId = req.params.id;
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k zorunludur!' });
    }
    
    await dbRun(
      'UPDATE duyurular SET baslik = ?, icerik = ?, tarih = ?, sira = ?, aktif = ? WHERE id = ?',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0, duyuruId]
    );
    
    console.log(`\nÃƒÂ¢Ã‚ÂœÃ‚Â… DUYURU GÃƒÂƒÃ‚ÂœNCELLENDÃƒÂ„Ã‚Â°`);
    console.log(`   ID: ${duyuruId}`);
    console.log(`   BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k: ${baslik}`);
    
    req.session.success = 'Duyuru başarıyla güncellendi!';
    res.json({ success: true, message: 'Duyuru başarıyla güncellendi!' });
  } catch (error) {
    console.error('Duyuru gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
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
    
    console.log(`\nÃƒÂ¢Ã‚ÂÃ‚ÂŒ DUYURU SÃƒÂ„Ã‚Â°LÃƒÂ„Ã‚Â°NDÃƒÂ„Ã‚Â°`);
    console.log(`   ID: ${duyuruId}`);
    
    req.session.success = 'Duyuru başarıyla silindi!';
    res.json({ success: true, message: 'Duyuru başarıyla silindi!' });
  } catch (error) {
    console.error('Duyuru silme hatasÃƒÂ„Ã‚Â±:', error);
    res.json({ success: false, message: 'Bir hata oluştu: ' + error.message });
  }
});

// Duyurular Route (Genel - Herkes gÃƒÂƒÃ‚Â¶rebilir)
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
    console.error('Duyurular hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ============ KURUMSAL SAYFALAR YÃƒÂƒÃ‚Â–NETÃƒÂ„Ã‚Â°MÃƒÂ„Ã‚Â° ============

// API - Kurumsal Sayfalar Listesi (Auth gerektirmiyor - dashboard zaten korumalÃƒÂ„Ã‚Â±)
app.get('/api/kurumsal-sayfalar', async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    res.json({ success: true, sayfalar: sayfalar });
  } catch (error) {
    console.error('API kurumsal sayfalar hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, message: 'Sayfalar yÃƒÂƒÃ‚Â¼klenemedi!', error: error.message });
  }
});

// Kurum - Kurumsal Sayfalar YÃƒÂƒÃ‚Â¶netimi
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
    console.error('Kurumsal sayfalar yÃƒÂƒÃ‚Â¶netimi hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - Kurumsal Sayfa GÃƒÂƒÃ‚Â¼ncelle
app.post('/kurum/kurumsal-sayfa-guncelle/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, message: 'Yetkisiz erişim!' });
  }
  
  try {
    const sayfaId = req.params.id;
    const { sayfa_adi, baslik, icerik, seo_baslik, seo_aciklama, sira, aktif } = req.body;
    
    if (!sayfa_adi || !baslik) {
      return res.json({ success: false, message: 'Sayfa adı ve baÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k zorunludur!' });
    }
    
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â KURUMSAL SAYFA GÃƒÂƒÃ‚ÂœNCELLEME:');
    console.log(`   ID: ${sayfaId}`);
    console.log(`   Sayfa Adı: ${sayfa_adi}`);
    console.log(`   BaÃƒÂ…Ã‚ÂŸlÃƒÂ„Ã‚Â±k: ${baslik}`);
    console.log(`   ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§erik: ${icerik ? icerik.substring(0, 100) + '...' : 'BOÃƒÂ…Ã‚Â'}`);
    console.log(`   ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§erik UzunluÃƒÂ„Ã‚ÂŸu: ${icerik ? icerik.length : 0} karakter`);
    console.log(`   Aktif: ${aktif}`);
    
    await dbRun(
      `UPDATE kurumsal_sayfalar 
       SET sayfa_adi = ?, baslik = ?, icerik = ?, seo_baslik = ?, seo_aciklama = ?, 
           sira = ?, aktif = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [sayfa_adi, baslik, icerik || '', seo_baslik || '', seo_aciklama || '', sira || 0, aktif ? 1 : 0, sayfaId]
    );
    
    console.log('   ÃƒÂ¢Ã‚ÂœÃ‚Â… VERÃƒÂ„Ã‚Â°TABANINA KAYDEDÃƒÂ„Ã‚Â°LDÃƒÂ„Ã‚Â°!');
    
    res.json({ success: true, message: 'Sayfa başarıyla güncellendi!' });
  } catch (error) {
    console.error('Kurumsal sayfa gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('HakkÃƒÂ„Ã‚Â±mÃƒÂ„Ã‚Â±zda hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('ÃƒÂ„Ã‚Â°letiÃƒÂ…Ã‚ÂŸim hatasÃƒÂ„Ã‚Â±:', error);
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
    console.error('Sınav merkezleri hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// PDF Test Route (GeliÃƒÂ…Ã‚ÂŸtirme/Test iÃƒÂƒÃ‚Â§in)
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
      return res.status(400).json({ error: 'LÃƒÂƒÃ‚Â¼tfen bir PDF dosyasÃƒÂ„Ã‚Â± yÃƒÂƒÃ‚Â¼kleyin!' });
    }

    // PDF'i oku
    const dataBuffer = fs.readFileSync(req.file.path);
    
    // PDF'i parse et
    const pdfData = await pdfParse(dataBuffer);
    
    // Text iÃƒÂƒÃ‚Â§eriÃƒÂ„Ã‚ÂŸini al
    const text = pdfData.text;
    
    // Öğrenci bilgilerini ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar (regex ile)
    const ogrenciMatch = text.match(/Öğrenci\s+Numara\s+SÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â±f\s+([^\n]+)\s+(\d+)\s+(\w+)/);
    const puanMatch = text.match(/ÃƒÂ¢Ã‚Â–Ã‚Â¼\s*([\d,]+)/);
    
    // Ders detaylarÃƒÂ„Ã‚Â±nÃƒÂ„Ã‚Â± ÃƒÂƒÃ‚Â§ÃƒÂ„Ã‚Â±kar
    const dersler = [];
    const dersRegex = /(TÃƒÂƒÃ‚Â¼rkÃƒÂƒÃ‚Â§e|Tarih-1|CoÃƒÂ„Ã‚ÂŸrafya-1|Felsefe|Din KÃƒÂƒÃ‚Â¼l\. ve Ahl\. Bil\.|Fizik|Kimya|Biyoloji|TYT Fen)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+)/g;
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
      rawText: text.substring(0, 2000) // ÃƒÂ„Ã‚Â°lk 2000 karakter
    };
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('PDF parse hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ 
      success: false, 
      error: 'PDF parse edilirken hata oluştu: ' + error.message 
    });
  }
});

// Cevap AnahtarlarÃƒÂ„Ã‚Â± Route
app.get('/cevap-anahtarlari', async (req, res) => {
  try {
    // Cevap anahtarÃƒÂ„Ã‚Â± yÃƒÂƒÃ‚Â¼klenmiÃƒÂ…Ã‚ÂŸ TÃƒÂƒÃ‚ÂœM sınavlarÃƒÂ„Ã‚Â± al
    const sinavlar = await dbAll(
      `SELECT * FROM sinavlar 
       WHERE cevap_anahtari_pdf IS NOT NULL 
       AND cevap_anahtari_pdf != '' 
       ORDER BY tarih DESC`,
      []
    );
    
    res.render('cevap-anahtarlari', {
      title: 'Cevap AnahtarlarÃƒÂ„Ã‚Â±',
      user: req.session.userId ? { type: req.session.userType, username: req.session.username } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Cevap anahtarlarÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Rehber - Toplu Sınav YÃƒÂƒÃ‚Â¼kleme KALDIRILDI (Sadece kurum yapabilir)

// GeliÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci isim eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme fonksiyonu
function eslesmeSkoru(isim1, isim2) {
  if (!isim1 || !isim2) return 0;
  
  // ÃƒÂ„Ã‚Â°simleri normalize et
  const normalize = (str) => {
    return str
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/ÃƒÂ„Ã‚Â±/g, 'i')
      .replace(/ÃƒÂ„Ã‚ÂŸ/g, 'g')
      .replace(/ÃƒÂƒÃ‚Â¼/g, 'u')
      .replace(/ÃƒÂ…Ã‚ÂŸ/g, 's')
      .replace(/ÃƒÂƒÃ‚Â¶/g, 'o')
      .replace(/ÃƒÂƒÃ‚Â§/g, 'c');
  };
  
  const n1 = normalize(isim1);
  const n2 = normalize(isim2);
  
  // Tam eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme
  if (n1 === n2) return 100;
  
  // Kelime kelime karÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±laÃƒÂ…Ã‚ÂŸtÃƒÂ„Ã‚Â±r
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
  
  // Levenshtein mesafesi ile ince ayar (basit yaklaÃƒÂ…Ã‚ÂŸÃƒÂ„Ã‚Â±m)
  if (skor > 50) {
    const uzunlukFarki = Math.abs(n1.length - n2.length);
    return Math.max(0, skor - uzunlukFarki * 2);
  }
  
  return skor;
}

// Sınav katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â± iÃƒÂƒÃ‚Â§in ÃƒÂƒÃ‚Â¶zel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme fonksiyonu
async function sinavKatilimciEslestir(pdfOgrenciAdi, sinavId) {
  if (!pdfOgrenciAdi || !sinavId) return null;
  
  // Sadece bu sınava katÃƒÂ„Ã‚Â±lan ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri ÃƒÂƒÃ‚Â§ek
  const katilimcilar = await dbAll(`
    SELECT ok.* 
    FROM ogrenci_kayitlari ok
    INNER JOIN sinav_katilimcilari sk ON ok.id = sk.ogrenci_id
    WHERE sk.sinav_id = ?
  `, [sinavId]);
  
  if (!katilimcilar || katilimcilar.length === 0) return null;
  
  let enIyiEslesme = null;
  let enIyiSkor = 0;
  
  // ÃƒÂ„Ã‚Â°sim varyasyonlarÃƒÂ„Ã‚Â± oluştur (Ad Soyad / Soyad Ad)
  const nameVariations = [pdfOgrenciAdi];
  const parts = pdfOgrenciAdi.trim().split(/\s+/);
  
  if (parts.length === 2) {
    // "BEREN ÃƒÂƒÃ‚Â–ZCAN" ÃƒÂ¢Ã‚Â†Ã‚Â’ ["BEREN ÃƒÂƒÃ‚Â–ZCAN", "ÃƒÂƒÃ‚Â–ZCAN BEREN"]
    nameVariations.push(`${parts[1]} ${parts[0]}`);
  } else if (parts.length === 3) {
    // "AHMED N AR" ÃƒÂ¢Ã‚Â†Ã‚Â’ ["AHMED N AR", "AR AHMED N", "N AR AHMED"]
    nameVariations.push(`${parts[2]} ${parts[0]} ${parts[1]}`);
    nameVariations.push(`${parts[1]} ${parts[2]} ${parts[0]}`);
  }
  
  console.log(`ÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â "${pdfOgrenciAdi}" iÃƒÂƒÃ‚Â§in eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme yapÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor...`);
  console.log(`   ÃƒÂ„Ã‚Â°sim varyasyonlarÃƒÂ„Ã‚Â±:`, nameVariations);
  
  // Her katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â± iÃƒÂƒÃ‚Â§in skor hesapla
  for (const katilimci of katilimcilar) {
    const dbName = (katilimci.ogrenci_adi_soyadi || '').trim().toUpperCase();
    
    for (const variation of nameVariations) {
      const variationUpper = variation.toUpperCase();
      let skor = 0;
      
      // 1. Tam eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme (100 puan)
      if (dbName === variationUpper) {
        skor = 100;
      }
      // 2. BaÃƒÂ…Ã‚ÂŸlangÃƒÂ„Ã‚Â±ÃƒÂƒÃ‚Â§ eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi (80 puan)
      else if (dbName.startsWith(variationUpper) || variationUpper.startsWith(dbName)) {
        skor = 80;
      }
      // 3. ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â§erik eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmesi (60 puan)
      else if (dbName.includes(variationUpper) || variationUpper.includes(dbName)) {
        skor = 60;
      }
      // 4. Kelime bazlÃƒÂ„Ã‚Â± eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme (40 puan)
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
        console.log(`   ÃƒÂ¢Ã‚Â†Ã‚Â’ Yeni en iyi eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme: "${dbName}" (Skor: ${skor})`);
      }
    }
  }
  
  // Minimum %55 eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme gerekli
  if (enIyiSkor >= 55) {
    console.log(`ÃƒÂ¢Ã‚ÂœÃ‚Â… En iyi eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme (${enIyiSkor} puan): "${enIyiEslesme.ogrenci_adi_soyadi}"`);
    return enIyiEslesme;
  } else {
    console.log(`ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Yeterli eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme bulunamadı (en yÃƒÂƒÃ‚Â¼ksek: ${enIyiSkor})`);
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
    if (skor > enYuksekSkor && skor >= 60) { // Minimum %60 eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme gerekli
      enYuksekSkor = skor;
      enIyiEslesme = ogrenci;
    }
  });
  
  return enIyiEslesme;
}

// YENÃƒÂ„Ã‚Â°: ÃƒÂ„Ã‚Â°lk Sayfa Analizi - Potansiyel ÃƒÂ„Ã‚Â°sim AdaylarÃƒÂ„Ã‚Â±
// Rehber - Toplu Sınav Analiz KALDIRILDI (Sadece kurum yapabilir)

// Rehber - Toplu Sınav YÃƒÂƒÃ‚Â¼kleme KALDIRILDI (Sadece kurum yapabilir)

// ============================================
// KURUMSAL ÃƒÂ„Ã‚Â°ÃƒÂƒÃ‚Â‡ERÃƒÂ„Ã‚Â°K YÃƒÂƒÃ‚Â–NETÃƒÂ„Ã‚Â°MÃƒÂ„Ã‚Â° (ADMIN PANEL)
// ============================================

// Kurumsal iÃƒÂƒÃ‚Â§erik listesi (Admin)
// DEPRECATED: Admin paneli yÃƒÂƒÃ‚Â¶nlendirmeleri - ArtÃƒÂ„Ã‚Â±k /kurum/ panelini kullanÃƒÂ„Ã‚Â±n
app.get('/admin/kurumsal-icerik', requireAuth, (req, res) => {
  console.log('ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ESKÃƒÂ„Ã‚Â° ROUTE: /admin/kurumsal-icerik ÃƒÂ¢Ã‚Â†Ã‚Â’ /kurum/kurumsal-sayfalar yÃƒÂƒÃ‚Â¶nlendiriliyor');
  res.redirect('/kurum/kurumsal-sayfalar');
});

app.get('/admin/kurumsal-icerik/duzenle/:id', requireAuth, (req, res) => {
  console.log(`ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â ESKÃƒÂ„Ã‚Â° ROUTE: /admin/kurumsal-icerik/duzenle/${req.params.id} ÃƒÂ¢Ã‚Â†Ã‚Â’ /kurum/kurumsal-sayfa-duzenle/${req.params.id} yÃƒÂƒÃ‚Â¶nlendiriliyor`);
  res.redirect(`/kurum/kurumsal-sayfa-duzenle/${req.params.id}`);
});

// DEPRECATED: Admin paneli POST/DELETE route'larÃƒÂ„Ã‚Â± kaldÃƒÂ„Ã‚Â±rÃƒÂ„Ã‚Â±ldÃƒÂ„Ã‚Â±
// ArtÃƒÂ„Ã‚Â±k /kurum/kurumsal-sayfa-guncelle/:id kullanÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±yor

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• YENÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEM: Manuel EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme EkranÃƒÂ„Ã‚Â±
app.get('/kurum/sinav-manuel-eslestirme/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    const sadeceEslesmemis = req.query.sadece_eslesmemis === '1';
    
    // SınavÃƒÂ„Ã‚Â± al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    // Sayfa dosyalarını bul (yeni sistem: sinav_${sinavId} klasöründe)
    const sayfalarDir = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    let sayfalar = [];
    
    if (fs.existsSync(sayfalarDir)) {
      const allFiles = fs.readdirSync(sayfalarDir);
      sayfalar = allFiles
        .filter(f => {
          // Sadece sayfa dosyalarını al (ogrenci_ ile başlayanları ve orijinal dosyaları hariç tut)
          return f.includes('sayfa_') && 
                 f.endsWith('.pdf') && 
                 !f.startsWith('ogrenci_') && 
                 !f.includes('orijinal_');
        })
        .sort((a, b) => {
          // Sayfa numaralarına göre sırala
          const numA = parseInt(a.match(/sayfa_(\d+)_/)?.[1] || '0');
          const numB = parseInt(b.match(/sayfa_(\d+)_/)?.[1] || '0');
          return numA - numB;
        })
        .map(f => {
          const fullPath = path.join(sayfalarDir, f);
          // View için relative path
          return fullPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
        });
    }
    
    // Eğer "sadece eşleşmemiş" modundaysa, sadece eşleşmemiş sayfaları filtrele
    if (sadeceEslesmemis) {
      // Hangi sayfaların eşleştiğini kontrol et
      const eslesmisKayitlar = await dbAll(`
        SELECT pdf_path FROM sinav_katilimcilari 
        WHERE sinav_id = ? AND pdf_path IS NOT NULL AND pdf_path != ''
      `, [sinavId]);
      
      // Eşleşmiş sayfa numaralarını bul
      // pdf_path formatı: .../ogrenci_ID_sayfa_NUMARA.pdf
      const eslesmisSayfaNumaralari = new Set();
      eslesmisKayitlar.forEach(kayit => {
        if (kayit.pdf_path) {
          // Sayfa numarasını çıkar: ogrenci_3237_sayfa_8.pdf -> 8
          const sayfaMatch = kayit.pdf_path.match(/sayfa_(\d+)\.pdf/);
          if (sayfaMatch) {
            eslesmisSayfaNumaralari.add(parseInt(sayfaMatch[1]));
          }
        }
      });
      
      // Sadece eşleşmemiş sayfaları al
      sayfalar = sayfalar.filter(sayfa => {
        // Sayfa path'inden sayfa numarasını çıkar
        // Format: uploads/sinav-sonuclari/sinav_58/sinav_58_sayfa_1_123456.pdf
        const sayfaMatch = sayfa.match(/sayfa_(\d+)_/);
        if (sayfaMatch) {
          const sayfaNo = parseInt(sayfaMatch[1]);
          // Eğer bu sayfa numarası eşleşmiş sayfalar arasında yoksa, göster
          return !eslesmisSayfaNumaralari.has(sayfaNo);
        }
        // Eğer sayfa numarası bulunamazsa, göster (güvenlik için)
        return true;
      });
      
      console.log(`📋 Sadece eşleşmemiş sayfalar: ${sayfalar.length} (Eşleşmiş: ${eslesmisSayfaNumaralari.size}, Toplam: ${sayfalar.length + eslesmisSayfaNumaralari.size})`);
    }
    
    // KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â± al (pdf_path ile birlikte - eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme durumunu kontrol iÃƒÂƒÃ‚Â§in)
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
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚Â‹ MANUEL EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME - KATILIMCI LÃƒÂ„Ã‚Â°STESÃƒÂ„Ã‚Â° (Sınav ID: ${sinavId})`);
    console.log(`   Toplam KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±: ${katilimcilar.length}`);
    const eslesmisSayisi = katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').length;
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ KatÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±: ${eslesmisSayisi}`);
    if (eslesmisSayisi > 0) {
      console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ Öğrenciler:`);
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
    console.error('Manuel eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme ekranÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸenleri Kontrol Et SayfasÃƒÂ„Ã‚Â±
app.get('/kurum/sinav-eslesen-kontrol/:id', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // SınavÃƒÂ„Ã‚Â± al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    // EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ katÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±mcÃƒÂ„Ã‚Â±larÃƒÂ„Ã‚Â± al (pdf_path dolu olanlar)
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
    
    console.log(`\nÃƒÂ¢Ã‚ÂœÃ‚Â… EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂEN KONTROL SAYFASI`);
    console.log(`   Sınav ID: ${sinavId}`);
    console.log(`   EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmiÃƒÂ…Ã‚ÂŸ SayÃƒÂ„Ã‚Â±sÃƒÂ„Ã‚Â±: ${eslesmisler.length}`);
    
    res.render('kurum/sinav-eslesen-kontrol', {
      user: req.session,
      sinav: sinav,
      eslesmisler: eslesmisler
    });
    
  } catch (error) {
    console.error('EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸen kontrol sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸmeyi KaldÃƒÂ„Ã‚Â±r
app.post('/kurum/sinav-eslestirme-kaldir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    
    console.log(`\nÃƒÂ¢Ã‚ÂÃ‚ÂŒ EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂMEYÃƒÂ„Ã‚Â° KALDIR`);
    console.log(`   Sınav ID: ${sinav_id}`);
    console.log(`   Öğrenci ID: ${ogrenci_id} (${kaynak})`);
    
    // pdf_path'i NULL yap ve sonuc_durumu'nu beklemede'ye ÃƒÂƒÃ‚Â§ek
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
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${result.changes} satÃƒÂ„Ã‚Â±r güncellendi`);
    
    if (result.changes === 0) {
      console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  UYARI: HiÃƒÂƒÃ‚Â§bir satÃƒÂ„Ã‚Â±r gÃƒÂƒÃ‚Â¼ncellenmedi!`);
      return res.json({ success: false, error: 'EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme bulunamadı!' });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸme kaldÃƒÂ„Ã‚Â±rma hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• TOPLU VELÃƒÂ„Ã‚Â° HESABI OLUÃƒÂ…Ã‚ÂTURMA
app.post('/kurum/toplu-veli-hesap-olustur', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('\nÃƒÂ°Ã‚ÂŸÃ‚Â‘Ã‚Â¥ TOPLU VELÃƒÂ„Ã‚Â° HESABI OLUÃƒÂ…Ã‚ÂTURMA BAÃƒÂ…Ã‚ÂLADI');
    
    // TÃƒÂƒÃ‚Â¼m ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri al (sadece kurum ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrencileri - tc_no olanlar)
    const ogrenciler = await dbAll(`
      SELECT id, ogrenci_adi_soyadi, tc_kimlik_no, sinif, telefon, veli_adi, veli_telefon
      FROM ogrenci_kayitlari
      WHERE tc_kimlik_no IS NOT NULL AND tc_kimlik_no != ''
      ORDER BY sinif, ogrenci_adi_soyadi
    `);
    
    console.log(`   ÃƒÂ°Ã‚ÂŸÃ‚Â“Ã‚ÂŠ ${ogrenciler.length} ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci bulundu`);
    
    let olusturulan = 0;
    let mevcutOlanlar = 0;
    let hatalar = 0;
    
    for (const ogrenci of ogrenciler) {
      try {
        // Kontrol et: Bu TC ile kullanıcı var mÃƒÂ„Ã‚Â±?
        const mevcutUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        if (mevcutUser) {
          mevcutOlanlar++;
          continue;
        }
        
        // ÃƒÂ…Ã‚Âifreyi hashle (ilk şifre = TC)
        const hashedPassword = await bcrypt.hash(ogrenci.tc_kimlik_no, 10);
        
        // Veli hesabÃƒÂ„Ã‚Â± oluştur
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
        
        // ogrenciler tablosuna ekle (veli-ÃƒÂƒÃ‚Â¶ÃƒÂ„Ã‚ÂŸrenci iliÃƒÂ…Ã‚ÂŸkisi)
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
        console.error(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Hata (${ogrenci.ogrenci_adi_soyadi}):`, error.message);
        hatalar++;
      }
    }
    
    console.log(`\nÃƒÂ¢Ã‚ÂœÃ‚Â… TOPLU VELÃƒÂ„Ã‚Â° HESABI OLUÃƒÂ…Ã‚ÂTURMA TAMAMLANDI`);
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… OluÃƒÂ…Ã‚ÂŸturulan: ${olusturulan}`);
    console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  Mevcut olanlar: ${mevcutOlanlar}`);
    console.log(`   ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Hatalar: ${hatalar}`);
    
    res.json({ 
      success: true, 
      olusturulan, 
      mevcutOlanlar, 
      hatalar,
      toplam: ogrenciler.length
    });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Toplu veli hesabÃƒÂ„Ã‚Â± oluşturma hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• YENÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEM: Sayfa EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme Kaydet
app.post('/kurum/sinav-sayfa-eslestir', requireAuth, async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, sayfa_yolu, ogrenci_id, kaynak } = req.body;
    
    console.log(`\nÃƒÂ°Ã‚ÂŸÃ‚Â”Ã‚Â— TEK SAYFA EÃƒÂ…Ã‚ÂLEÃƒÂ…Ã‚ÂTÃƒÂ„Ã‚Â°RME`);
    console.log(`   Sınav ID: ${sinav_id}`);
    console.log(`   Öğrenci ID: ${ogrenci_id} (${kaynak})`);
    console.log(`   Sayfa Yolu: ${sayfa_yolu}`);
    
    // sinav_katilimcilari tablosunu gÃƒÂƒÃ‚Â¼ncelle
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
    
    console.log(`   ÃƒÂ¢Ã‚ÂœÃ‚Â… BaÃƒÂ…Ã‚ÂŸarÃƒÂ„Ã‚Â±lÃƒÂ„Ã‚Â±: ${result.changes} satÃƒÂ„Ã‚Â±r güncellendi`);
    
    if (result.changes === 0) {
      console.log(`   ÃƒÂ¢Ã‚ÂšÃ‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â  UYARI: HiÃƒÂƒÃ‚Â§bir satÃƒÂ„Ã‚Â±r gÃƒÂƒÃ‚Â¼ncellenmedi! WHERE koÃƒÂ…Ã‚ÂŸulu tutmadı.`);
    }
    
    res.json({ success: true, changes: result.changes });
    
  } catch (error) {
    console.error('ÃƒÂ¢Ã‚ÂÃ‚ÂŒ Sayfa eÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ÃƒÂ°Ã‚ÂŸÃ‚Â†Ã‚Â• YENÃƒÂ„Ã‚Â° SÃƒÂ„Ã‚Â°STEM: Yeni SonuÃƒÂƒÃ‚Â§ YÃƒÂƒÃ‚Â¼kleme SayfasÃƒÂ„Ã‚Â±
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
    console.error('SonuÃƒÂƒÃ‚Â§ yÃƒÂƒÃ‚Â¼kleme sayfasÃƒÂ„Ã‚Â± hatasÃƒÂ„Ã‚Â±:', error);
    res.status(500).send('Bir hata oluştu!');
  }
});

// Kurum - PDF Sayfalara Ayır (Yeni Sistem)
app.post('/kurum/sinav-sonuc-yukle-sayfalara-ayir', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (req.session.userType !== 'kurum_yonetici') {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id } = req.body;
    
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sınav ID eksik!' });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF dosyası yüklenmedi!' });
    }
    
    console.log('📄 PDF sayfalara ayrılıyor:', req.file.originalname);
    console.log('📋 Sınav ID:', sinav_id);
    
    // PDF'i yükle
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`📊 Toplam sayfa: ${totalPages}`);
    
    // Sonuç klasörünü oluştur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // ESKİ SAYFALARI TEMİZLE (yeni PDF yüklenirken)
    // Sadece sayfa dosyalarını sil (ogrenci_ ile başlayanları ve orijinal dosyaları koru)
    try {
      const existingFiles = fs.readdirSync(sonucKlasoru);
      const oldSayfaFiles = existingFiles.filter(f => 
        f.includes('sayfa_') && f.endsWith('.pdf') && !f.startsWith('ogrenci_')
      );
      
      if (oldSayfaFiles.length > 0) {
        console.log(`🗑️  ${oldSayfaFiles.length} eski sayfa dosyası temizleniyor...`);
        oldSayfaFiles.forEach(file => {
          try {
            fs.unlinkSync(path.join(sonucKlasoru, file));
          } catch (err) {
            console.warn(`   ⚠️  ${file} silinemedi:`, err.message);
          }
        });
      }
    } catch (cleanupError) {
      console.warn('Eski dosya temizleme hatası (devam ediliyor):', cleanupError);
    }
    
    // Her sayfayı ayrı PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya adı: sinav_ID_sayfa_NUMARA_timestamp.pdf
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
    
    // Veritabanına kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // Geçici dosyayı sil
    try {
      fs.unlinkSync(req.file.path);
    } catch (unlinkError) {
      console.warn('Geçici dosya silinemedi:', unlinkError);
    }
    
    console.log(`✅ PDF başarıyla ${totalPages} sayfaya ayrıldı!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // Akıllı eşleştirme (analiz/pattern seçimi) ekranına yönlendir
        redirectTo: `/kurum/sinav-isim-pattern-secimi/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error('❌ PDF ayırma hatası:', error);
    
    // Geçici dosyayı temizle
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Geçici dosya silinemedi:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'PDF sayfalara ayrılırken bir hata oluştu!' 
    });
  }
});

// Kurum - İsim Pattern Seçimi
app.get('/kurum/sinav-isim-pattern-secimi/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('Sınav bulunamadı!');
    }
    
    // İlk PDF sayfasını bul (sayfalara ayrılmış PDF'lerden)
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(404).send('PDF sayfaları bulunamadı! Lütfen önce PDF yükleyin.');
    }
    
    // İlk sayfa PDF'ini bul
    const files = fs.readdirSync(sonucKlasoru);
    const ilkSayfa = files.find(f => f.includes('sayfa_1_') && f.endsWith('.pdf'));
    
    if (!ilkSayfa) {
      return res.status(404).send('İlk PDF sayfası bulunamadı!');
    }
    
    const ilkPdfPath = path.join(sonucKlasoru, ilkSayfa);
    
    // View için relative path (uploads/ ile başlayan kısmı al)
    const ilkPdfPathRelative = ilkPdfPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
    
    // İsim adaylarını çıkar
    const isimAdaylari = await extractNameCandidates(ilkPdfPath);
    
    res.render('kurum/sinav-isim-pattern-secimi', {
      user: req.session,
      sinavId: sinavId,
      sinav: sinav,
      ilkPdfPath: ilkPdfPathRelative,
      isimAdaylari: isimAdaylari || []
    });
    
  } catch (error) {
    console.error('İsim pattern seçimi sayfası hatası:', error);
    res.status(500).send('Bir hata oluştu: ' + error.message);
  }
});

// Kurum - Otomatik Eşleştirme (Pattern Seçiminden Sonra)
app.post('/kurum/sinav-otomatik-eslestir-pattern', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { sinav_id, pattern_index, selected_text } = req.body;
    
    if (!sinav_id || pattern_index === null || !selected_text) {
      return res.status(400).json({ success: false, error: 'Eksik parametreler!' });
    }
    
    console.log('\n🎯 Otomatik Eşleştirme Başlatılıyor...');
    console.log('📋 Sınav ID:', sinav_id);
    console.log('📝 Seçilen Pattern:', selected_text);
    
    // Sınav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'Sınav bulunamadı!' });
    }
    
    // Katılımcıları al
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
    
    // PDF sayfalarını bul
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(400).json({ success: false, error: 'PDF sayfaları bulunamadı!' });
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
    // İlk sayfadan pattern bilgisini al
    const ilkSayfaYolu = path.join(sonucKlasoru, files[0]);
    const ilkSayfaText = (await extractTextHybrid(ilkSayfaYolu)).text;
    const ilkSayfaLines = ilkSayfaText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Pattern'deki satır numarasını bul (selected_text'i içeren satır)
    let patternLineNumber = -1;
    for (let i = 0; i < ilkSayfaLines.length; i++) {
      if (ilkSayfaLines[i].includes(selected_text) || selected_text.includes(ilkSayfaLines[i])) {
        patternLineNumber = i;
        break;
      }
    }
    
    // Eğer bulunamazsa, pattern_index'i kullan
    if (patternLineNumber === -1 && pattern_index !== null) {
      patternLineNumber = parseInt(pattern_index);
    }
    
    console.log(`📍 Pattern satır numarası: ${patternLineNumber} (${patternLineNumber >= 0 ? ilkSayfaLines[patternLineNumber] : 'bulunamadı'})`);
    
    // Her sayfayı işle
    for (let i = 0; i < files.length; i++) {
      const sayfaDosyasi = files[i];
      const sayfaYolu = path.join(sonucKlasoru, sayfaDosyasi);
      const sayfaNo = i + 1;
      
      try {
        // PDF'den text çıkar
        const extractionResult = await extractTextHybrid(sayfaYolu);
        const text = extractionResult.text;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // Çoklu strateji ile isim çıkar
        let extractedName = '';
        let extractionMethod = '';
        
        // STRATEJİ 1: Pattern satır numarasından direkt al
        if (patternLineNumber >= 0 && lines[patternLineNumber]) {
          extractedName = lines[patternLineNumber].trim();
          extractionMethod = 'pattern_line';
        }
        
        // STRATEJİ 2: selected_text'i içeren satırı bul
        if (!extractedName || extractedName.length < 5) {
          for (const line of lines) {
            const normalizedLine = line.toUpperCase().trim();
            const normalizedSelected = selected_text.toUpperCase().trim();
            
            // Tam eşleşme veya kısmi eşleşme
            if (normalizedLine.includes(normalizedSelected) || 
                normalizedSelected.includes(normalizedLine) ||
                normalizedLine.replace(/\s+/g, '') === normalizedSelected.replace(/\s+/g, '')) {
              extractedName = line.trim();
              extractionMethod = 'text_match';
              break;
            }
          }
        }
        
        // STRATEJİ 3: Pattern satırının yakınındaki satırları kontrol et (±2 satır)
        if (!extractedName || extractedName.length < 5) {
          if (patternLineNumber >= 0) {
            for (let offset = -2; offset <= 2; offset++) {
              const checkLine = patternLineNumber + offset;
              if (checkLine >= 0 && checkLine < lines.length && lines[checkLine]) {
                const candidate = lines[checkLine].trim();
                // İsim gibi görünüyor mu? (2-4 kelime, büyük harf başlangıç)
                if (candidate.length >= 8 && candidate.length <= 50) {
                  const words = candidate.split(/\s+/);
                  if (words.length >= 2 && words.length <= 4) {
                    // İlk kelime büyük harfle başlıyor mu?
                    if (/^[A-ZÇĞİÖŞÜ]/.test(words[0])) {
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
        
        // STRATEJİ 4: İlk 15 satırda isim benzeri pattern ara
        if (!extractedName || extractedName.length < 5) {
          for (let j = 0; j < Math.min(15, lines.length); j++) {
            const candidate = lines[j].trim();
            // İsim pattern'i: 2-4 kelime, her kelime büyük harfle başlıyor
            const namePattern = /^([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,3})$/;
            const upperPattern = /^([A-ZÇĞİÖŞÜ]{2,}(?:\s+[A-ZÇĞİÖŞÜ]{2,}){1,3})$/;
            
            if ((namePattern.test(candidate) || upperPattern.test(candidate)) && 
                candidate.length >= 8 && candidate.length <= 50) {
              // Gereksiz kelimeleri kontrol et
              const lower = candidate.toLowerCase();
              if (!lower.includes('öğrenci') && !lower.includes('numara') && 
                  !lower.includes('sınıf') && !lower.includes('sonuç')) {
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
          console.log(`   ⚠️ Sayfa ${sayfaNo}: İsim çıkarılamadı`);
          eslesmeyen++;
          continue;
        }
        
        // İsmi temizle
        const cleanName = cleanExtractedName(extractedName);
        
        if (!cleanName || cleanName.length < 5) {
          console.log(`   ⚠️ Sayfa ${sayfaNo}: Temizlenmiş isim çok kısa: "${cleanName}"`);
          eslesmeyen++;
          continue;
        }
        
        // En iyi eşleşmeyi bul (threshold'u düşürdük)
        const match = findBestMatch(cleanName, katilimcilar);
        
        // Threshold'u 0.60'a düşürdük (daha fazla eşleşme için)
        if (match && match.similarity >= 0.60) {
          // Eşleşme bulundu - kaydet
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
          console.log(`   ✅ Sayfa ${sayfaNo}: "${cleanName}" → "${match.ogrenci.ad_soyad}" (${(match.similarity * 100).toFixed(0)}%, ${extractionMethod})`);
        } else {
          console.log(`   ❌ Sayfa ${sayfaNo}: "${cleanName}" eşleşmedi (en iyi: ${match ? (match.similarity * 100).toFixed(0) + '%' : 'yok'})`);
          eslesmeyen++;
        }
        
      } catch (error) {
        console.error(`Sayfa ${sayfaNo} işlenirken hata:`, error);
        eslesmeyen++;
      }
    }
    
    // Sınav durumunu güncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`✅ Eşleştirme tamamlandı: ${eslesen} başarılı, ${eslesmeyen} başarısız`);
    
    res.json({
      success: true,
      data: {
        eslesen,
        eslesmeyen,
        toplam: files.length,
        eslesmeler: eslesmeler.slice(0, 10) // İlk 10'unu göster
      }
    });
    
  } catch (error) {
    console.error('Otomatik eşleştirme hatası:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Otomatik eşleştirme sırasında bir hata oluştu!' 
    });
  }
});

// İsim adaylarını çıkaran fonksiyon (autoMatcher.js'den uyarlanmış)
async function extractNameCandidates(pdfPath) {
  try {
    console.log(`\n🔍 İsim adayları çıkarılıyor: ${path.basename(pdfPath)}`);
    
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;
    
    const candidates = [];
    const seen = new Set();
    const lines = text.split('\n');
    
    // Tüm satırlarda isim ara
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      
      // Pattern 1: Başı büyük harfli isimler (Ahmet Mehmet Yılmaz)
      const matches1 = line.match(/\b([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,2})\b/g);
      if (matches1) {
        matches1.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('öğrenci') && !lower.includes('sınav') && !lower.includes('sonuç') && !lower.includes('numara')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Başı Büyük Harf',
                lineNumber: lineIndex + 1,
                confidence: 80
              });
            }
          }
        });
      }
      
      // Pattern 2: Tam büyük harfli isimler (ALİ VELİ ÇELİK)
      const matches2 = line.match(/\b([A-ZÇĞİÖŞÜ]{2,}(?:\s+[A-ZÇĞİÖŞÜ]{2,}){1,2})\b/g);
      if (matches2) {
        matches2.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('sonuç') && !lower.includes('sınav') && !lower.includes('belge') && !lower.includes('deneme')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Tam Büyük Harf',
                lineNumber: lineIndex + 1,
                confidence: 90
              });
            }
          }
        });
      }
    }
    
    // Güvene göre sırala ve ilk 10'u al
    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidates = candidates.slice(0, 10);
    
    console.log(`   ✅ ${topCandidates.length} adet isim adayı bulundu`);
    
    return topCandidates;
    
  } catch (error) {
    console.error('❌ İsim adayları çıkarma hatası:', error);
    return [];
  }
}

// Kurum - Sınav listesi (koleksiyon sayfasÃƒÂ½)
app.get('/kurum/sinavlar', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
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
    console.error('Sınav listesi hatasÃƒÂ½:', error);
    req.session.error = 'Sınav listesi yÃƒÂ¼klenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Sınav detay
app.get('/kurum/sinav-detay/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      req.session.error = 'Sınav bulunamadı!';
      return res.redirect('/kurum/sinavlar');
    }
    
    // KatÃƒÂ½lÃƒÂ½mcÃƒÂ½lar (kurum ve veli)
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
    
    // SÃƒÂ½nÃƒÂ½f listesi (ÃƒÂ¶ÃƒÂ°renci ekleme filtresi)
    const siniflar = ['1','2','3','4','5','6','7','8','9','10','11','12','Mezun'];
    
    // ÃƒÂ–ÃƒÂ°renci havuzu (kurum + veli) seÃƒÂ§im listesi iÃƒÂ§in
    // Zaten eklenmiş öğrencileri filtrele
    const mevcutKatilimciKeys = new Set(
      katilimcilar.map(k => `${k.kaynak}_${k.ogrenci_id}`)
    );
    
    const kurumOgrencileri = await dbAll(`SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif FROM ogrenci_kayitlari ORDER BY ad_soyad ASC`);
    const veliOgrencileri = await dbAll(`SELECT id, ad_soyad, sinif FROM ogrenciler ORDER BY ad_soyad ASC`);
    
    // Duplicate kontrolü için: aynı isim ve sınıfa sahip öğrencileri birleştir
    const ogrenciMap = new Map();
    
    // Önce kurum öğrencilerini ekle
    kurumOgrencileri
      .filter(o => !mevcutKatilimciKeys.has(`kurum_${o.id}`))
      .forEach(o => {
        const key = `${(o.ad_soyad || '').toLowerCase().trim()}_${(o.sinif || '').trim()}`;
        if (!ogrenciMap.has(key)) {
          ogrenciMap.set(key, { unique_id: `kurum_${o.id}`, ad_soyad: o.ad_soyad, sinif: o.sinif || '', kaynak: 'kurum' });
        }
      });
    
    // Sonra veli öğrencilerini ekle (eğer aynı isim ve sınıf yoksa)
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
    
    // İstatistikleri hesapla
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
    console.error('Sınav detay hatasÃƒÂ½:', error);
    req.session.error = 'Sınav detaylarÃƒÂ½ yÃƒÂ¼klenirken bir hata oluştu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sınav durumu güncelle
app.post('/kurum/sinav-durumu-guncelle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const { sinav_durumu } = req.body || {};

    if (!sinav_durumu) {
      return res.status(400).json({ success: false, message: 'Sınav durumu gerekli!' });
    }

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'Sınav bulunamadı!' });
    }

    await dbRun('UPDATE sinavlar SET sinav_durumu = ? WHERE id = ?', [sinav_durumu, sinavId]);
    return res.json({ success: true, message: 'Sınav durumu güncellendi!' });
  } catch (error) {
    console.error('Sınav durumu güncelleme hatası:', error);
    return res.status(500).json({ success: false, message: 'Sınav durumu güncellenirken hata oluştu!' });
  }
});

// Kurum - Cevap anahtarı yükle
app.post('/kurum/cevap-anahtari-yukle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), answerKeyUpload.single('cevapAnahtari'), async (req, res) => {
  try {
    const sinavId = req.params.id;

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'Sınav bulunamadı!' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF dosyası gerekli!' });
    }

    const relativePath = req.file.path.replace(/^\.?\/?/, '');
    await dbRun('UPDATE sinavlar SET cevap_anahtari_pdf = ? WHERE id = ?', [relativePath, sinavId]);

    return res.json({ success: true, message: 'Cevap anahtarı yüklendi!' });
  } catch (error) {
    console.error('Cevap anahtarı yükleme hatası:', error);
    return res.status(500).json({ success: false, message: 'Cevap anahtarı yüklenirken hata oluştu!' });
  }
});

// Kurum - Sınav ekle
app.post('/kurum/sinav-ekle', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { ad, tarih, sinif, aciklama } = req.body;
    if (!ad || !tarih) {
      req.session.error = 'Sınav adÃƒÂ½ ve tarih zorunludur!';
      return res.redirect('/kurum/sinavlar');
    }
    
    await dbRun(
      `INSERT INTO sinavlar (ad, tarih, sinif, aciklama, durum, katilimci_sayisi, sonuc_yuklendi, sonuclar_aciklandi) 
       VALUES (?, ?, ?, ?, 'taslak', 0, 0, 0)`,
      [ad.trim(), tarih, sinif || null, aciklama || null]
    );
    
    req.session.success = 'Sınav eklendi!';
    res.redirect('/kurum/sinavlar');
  } catch (error) {
    console.error('Sınav ekleme hatası:', error);
    req.session.error = 'Sınav eklenirken bir hata oluştu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - Sınav katÃƒÂ½lÃƒÂ½mcÃƒÂ½sÃƒÂ½ ekle (ÃƒÂ§oklu)
app.post('/kurum/sinav-katilimci-ekle', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { sinav_id, ogrenci_ids } = req.body;
    if (!sinav_id || !Array.isArray(ogrenci_ids) || ogrenci_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Sinav veya ogrenci bilgisi eksik!' });
    }
    // Mevcut katilimcilari onbellege al (cift kaydi engelle)
    const mevcut = await dbAll("SELECT ogrenci_id, ogrenci_kaynak FROM sinav_katilimcilari WHERE sinav_id = ?", [sinav_id]);
    const mevcutSet = new Set(mevcut.map(m => `${m.ogrenci_kaynak}_${m.ogrenci_id}`));
    
    // Duplicate kontrolü: aynı öğrenci birden fazla kez seçilmişse sadece birini al
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
    
    // Mevcut duplicate kayıtları temizle (aynı sinav_id, ogrenci_id, ogrenci_kaynak kombinasyonundan sadece birini tut)
    try {
      // Önce tüm kayıtları al
      const allRecords = await dbAll(`
        SELECT rowid, sinav_id, ogrenci_id, ogrenci_kaynak 
        FROM sinav_katilimcilari 
        WHERE sinav_id = ?
        ORDER BY rowid
      `, [sinav_id]);
      
      // Her kombinasyon için ilk kaydı tut, diğerlerini sil
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
      
      // Duplicate kayıtları sil
      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => '?').join(',');
        await dbRun(`DELETE FROM sinav_katilimcilari WHERE rowid IN (${placeholders})`, toDelete);
      }
    } catch (cleanupError) {
      console.error('Duplicate temizleme hatası (devam ediliyor):', cleanupError);
      // Hata olsa bile devam et
    }
    
    await dbRun("UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?", [sinav_id, sinav_id]);
    
    const message = added > 0 
      ? `${added} öğrenci başarıyla eklendi.${skipped > 0 ? ` ${skipped} öğrenci zaten ekliydi.` : ''}`
      : skipped > 0 
        ? `${skipped} öğrenci zaten ekliydi.`
        : 'Hiçbir öğrenci eklenemedi.';
    
    res.json({ success: true, added, skipped, message });
  } catch (error) {
    console.error('Sınav katÃƒÂ½lÃƒÂ½mcÃƒÂ½ ekleme hatasÃƒÂ½:', error);
    res.status(500).json({ success: false, error: 'KatÃƒÂ½lÃƒÂ½mcÃƒÂ½ eklenemedi!', message: error.message });
  }
});

// Kurum - Sınav katÃƒÂ½lÃƒÂ½mcÃƒÂ½ sil
app.post('/kurum/sinav-katilimci-sil/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
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
    console.error('Sınav katÃƒÂ½lÃƒÂ½mcÃƒÂ½ silme hatasÃƒÂ½:', error);
    res.status(500).json({ success: false, error: 'KatÃƒÂ½lÃƒÂ½mcÃƒÂ½ silinemedi!' });
  }
});

// Kurum - Sınav sil
app.post('/kurum/sinav-sil/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    await dbRun('DELETE FROM sinavlar WHERE id = ?', [sinavId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Sınav silme hatasÃƒÂ½:', error);
    res.status(500).json({ success: false, error: 'Sınav silinemedi!' });
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
    console.error('Kurumsal sayfalar listesi hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurumsal Sayfa DÃƒÂƒÃ‚Â¼zenle (GET)
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
    console.error('Sayfa dÃƒÂƒÃ‚Â¼zenle hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/kurumsal-sayfalar');
  }
});

// Site Ayarları SayfasÃƒÂ„Ã‚Â± (GET)
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
    console.error('Site ayarları sayfa hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Sayfa yüklenirken bir hata oluştu!';
    res.redirect('/kurum/dashboard');
  }
});

// Site Ayarları GÃƒÂƒÃ‚Â¼ncelle (POST)
app.post('/kurum/site-ayarlari', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { site_adi, site_adres, site_telefon, site_email, site_aciklama } = req.body;
    
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adi', site_adi]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adres', site_adres]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_telefon', site_telefon]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_email', site_email]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_aciklama', site_aciklama]);
    
    console.log('ÃƒÂ¢Ã‚ÂœÃ‚Â… Site ayarları güncellendi');
    req.session.success = 'Site ayarları başarıyla güncellendi!';
    res.redirect('/kurum/site-ayarlari');
  } catch (error) {
    console.error('Site ayarları gÃƒÂƒÃ‚Â¼ncelleme hatasÃƒÂ„Ã‚Â±:', error);
    req.session.error = 'Ayarlar güncellenirken bir hata oluştu!';
    res.redirect('/kurum/site-ayarlari');
  }
});

// Sunucuyu baÃƒÂ…Ã‚ÂŸlat
// Railway için 0.0.0.0 kullan (tüm network interface'lerde dinle)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('✅ Sunucu başarıyla başlatıldı!');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔗 URL: http://0.0.0.0:${PORT}`);
  console.log(`📁 Veritabanı: ${DB_PATH}`);
  console.log(`🌍 Environment: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log('='.repeat(50));
});

// Error handler for server
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} zaten kullanımda!`);
  } else {
    console.error('❌ Sunucu başlatma hatası:', err);
  }
  process.exit(1);
});

// Graceful shutdown
// Rehber - Manuel EÃƒÂ…Ã‚ÂŸleÃƒÂ…Ã‚ÂŸtirme KALDIRILDI (Sadece kurum yapabilir)

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('VeritabanÃƒÂ„Ã‚Â± kapatma hatasÃƒÂ„Ã‚Â±:', err);
    } else {
      console.log('Database connected:', DB_PATH);
    }
    process.exit(0);
  });
});

















