/**
 * Sınav Merkezi - Detaylı Modül Test Scripti
 * Her modülü ayrı ayrı test eder
 */

require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');

const results = {
  modules: {}
};

function testModule(name, testFn) {
  return new Promise(async (resolve) => {
    try {
      const result = await testFn();
      results.modules[name] = { status: 'PASS', details: result };
      console.log(`✅ ${name}: PASS`);
      resolve(true);
    } catch (error) {
      results.modules[name] = { status: 'FAIL', error: error.message };
      console.log(`❌ ${name}: FAIL - ${error.message}`);
      resolve(false);
    }
  });
}

// 1. Veritabanı Modülü
async function testDatabaseModule() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) reject(err);
      
      // Test query
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) {
          db.close();
          reject(err);
        } else {
          db.close();
          resolve({ userCount: row.count });
        }
      });
    });
  });
}

// 2. Authentication Modülü
async function testAuthModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const checks = {
    hasBcrypt: /bcrypt/.test(serverCode),
    hasSession: /express-session/.test(serverCode),
    hasRequireAuth: /function requireAuth|const requireAuth/.test(serverCode),
    hasRequireRole: /function requireRole|const requireRole/.test(serverCode),
    hasLoginRoute: /app\.post\(['"]\/login/.test(serverCode),
    hasLogoutRoute: /app\.get\(['"]\/logout/.test(serverCode)
  };
  
  const missing = Object.entries(checks)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);
  
  if (missing.length > 0) {
    throw new Error(`Eksik: ${missing.join(', ')}`);
  }
  
  return checks;
}

// 3. Kurum Modülü
async function testKurumModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const routes = [
    '/kurum/dashboard',
    '/kurum/sinavlar',
    '/kurum/sinav-sonuc-yukle',
    '/kurum/ogrenci-kayitlari',
    '/kurum/rehber-ogretmenler',
    '/kurum/talepler',
    '/kurum/whatsapp-ayarlari'
  ];
  
  const missing = routes.filter(route => 
    !new RegExp(`app\\.(get|post)\\(['"]${route.replace(/\//g, '\\/')}`).test(serverCode)
  );
  
  if (missing.length > 0) {
    throw new Error(`Eksik route'lar: ${missing.join(', ')}`);
  }
  
  return { routes: routes.length };
}

// 4. Veli Modülü
async function testVeliModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const routes = [
    '/veli/dashboard',
    '/veli/sinav-sonuclari',
    '/veli/ogrenci-ekle',
    '/veli/ogrenci-duzenle',
    '/veli/talepler',
    '/veli/profil'
  ];
  
  const missing = routes.filter(route => 
    !new RegExp(`app\\.(get|post)\\(['"]${route.replace(/\//g, '\\/')}`).test(serverCode)
  );
  
  if (missing.length > 0) {
    throw new Error(`Eksik route'lar: ${missing.join(', ')}`);
  }
  
  return { routes: routes.length };
}

// 5. Rehber Modülü
async function testRehberModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const routes = [
    '/rehber/dashboard',
    '/rehber/sinav-sonuclari',
    '/rehber/ogrenciler',
    '/rehber/talepler',
    '/rehber/profil'
  ];
  
  const missing = routes.filter(route => 
    !new RegExp(`app\\.(get|post)\\(['"]${route.replace(/\//g, '\\/')}`).test(serverCode)
  );
  
  if (missing.length > 0) {
    throw new Error(`Eksik route'lar: ${missing.join(', ')}`);
  }
  
  return { routes: routes.length };
}

// 6. PDF İşleme Modülü
async function testPDFModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const checks = {
    hasPdfParse: /pdf-parse/.test(serverCode),
    hasPdfLib: /pdf-lib/.test(serverCode),
    hasUploadRoute: /sinav-sonuc-yukle/.test(serverCode),
    hasMatchingLogic: /eslestir|match/i.test(serverCode),
    hasLearningPatterns: /pdf_learning_patterns/.test(serverCode)
  };
  
  const missing = Object.entries(checks)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);
  
  if (missing.length > 0) {
    throw new Error(`Eksik: ${missing.join(', ')}`);
  }
  
  return checks;
}

// 7. WhatsApp Modülü
async function testWhatsAppModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const checks = {
    hasWhatsAppFunction: /whatsappBildirimGonder|whatsapp/i.test(serverCode),
    hasWhatsAppTable: /whatsapp_ayarlari/.test(serverCode),
    hasWhatsAppRoute: /whatsapp-ayarlari/.test(serverCode),
    hasNotificationHistory: /bildirim_gecmisi/.test(serverCode)
  };
  
  const missing = Object.entries(checks)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);
  
  if (missing.length > 0) {
    throw new Error(`Eksik: ${missing.join(', ')}`);
  }
  
  return checks;
}

// 8. Excel İşleme Modülü
async function testExcelModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const checks = {
    hasExcelJS: /exceljs|ExcelJS/.test(serverCode),
    hasXLSX: /\.xlsx|\.xls/.test(serverCode), // Excel dosya uzantıları kontrolü
    hasImportRoute: /ogrenci-import-excel|excel/i.test(serverCode)
  };
  
  const missing = Object.entries(checks)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);
  
  if (missing.length > 0) {
    throw new Error(`Eksik: ${missing.join(', ')}`);
  }
  
  return checks;
}

// 9. Rate Limiting Modülü
async function testRateLimitModule() {
  const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  
  const checks = {
    hasRateLimit: /express-rate-limit|rateLimit/.test(serverCode),
    hasGeneralLimiter: /generalLimiter/.test(serverCode),
    hasLoginLimiter: /loginLimiter/.test(serverCode),
    hasUploadLimiter: /uploadLimiter/.test(serverCode)
  };
  
  const missing = Object.entries(checks)
    .filter(([_, value]) => !value)
    .map(([key, _]) => key);
  
  if (missing.length > 0) {
    throw new Error(`Eksik: ${missing.join(', ')}`);
  }
  
  return checks;
}

// 10. View Dosyaları
async function testViewFiles() {
  const requiredViews = [
    'views/index.ejs',
    'views/login.ejs',
    'views/register.ejs',
    'views/kurum_dashboard.ejs',
    'views/veli_dashboard.ejs',
    'views/rehber_dashboard.ejs'
  ];
  
  const missing = requiredViews.filter(view => 
    !fs.existsSync(path.join(__dirname, view))
  );
  
  if (missing.length > 0) {
    throw new Error(`Eksik view dosyaları: ${missing.join(', ')}`);
  }
  
  return { viewCount: requiredViews.length };
}

async function runAllTests() {
  console.log('\n🔍 Sınav Merkezi - Detaylı Modül Testleri\n');
  console.log('='.repeat(60));
  
  await testModule('1. Veritabanı Modülü', testDatabaseModule);
  await testModule('2. Authentication Modülü', testAuthModule);
  await testModule('3. Kurum Modülü', testKurumModule);
  await testModule('4. Veli Modülü', testVeliModule);
  await testModule('5. Rehber Modülü', testRehberModule);
  await testModule('6. PDF İşleme Modülü', testPDFModule);
  await testModule('7. WhatsApp Modülü', testWhatsAppModule);
  await testModule('8. Excel İşleme Modülü', testExcelModule);
  await testModule('9. Rate Limiting Modülü', testRateLimitModule);
  await testModule('10. View Dosyaları', testViewFiles);
  
  // Özet
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 DETAYLI TEST ÖZETİ\n');
  
  const passed = Object.values(results.modules).filter(m => m.status === 'PASS').length;
  const failed = Object.values(results.modules).filter(m => m.status === 'FAIL').length;
  
  console.log(`✅ Başarılı: ${passed}/${Object.keys(results.modules).length}`);
  console.log(`❌ Başarısız: ${failed}/${Object.keys(results.modules).length}`);
  
  if (failed > 0) {
    console.log('\n❌ BAŞARISIZ MODÜLLER:\n');
    Object.entries(results.modules).forEach(([name, result]) => {
      if (result.status === 'FAIL') {
        console.log(`  - ${name}: ${result.error}`);
      }
    });
  }
  
  console.log('\n' + '='.repeat(60));
  
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(error => {
  console.error('Test hatası:', error);
  process.exit(1);
});

