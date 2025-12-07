/**
 * Sınav Merkezi - Modül Test Scripti
 * Tüm modülleri test eder ve hataları raporlar
 */

require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');
const SESSION_SECRET = process.env.SESSION_SECRET;

const testResults = {
  passed: [],
  failed: [],
  warnings: []
};

function logTest(name, status, message = '') {
  const result = { name, status, message, timestamp: new Date().toISOString() };
  if (status === 'PASS') {
    testResults.passed.push(result);
    console.log(`✅ ${name}: PASS`);
  } else if (status === 'FAIL') {
    testResults.failed.push(result);
    console.log(`❌ ${name}: FAIL - ${message}`);
  } else if (status === 'WARN') {
    testResults.warnings.push(result);
    console.log(`⚠️  ${name}: WARNING - ${message}`);
  }
}

async function testDatabaseConnection() {
  return new Promise((resolve) => {
    try {
      const db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          logTest('Veritabanı Bağlantısı', 'FAIL', err.message);
          resolve(false);
        } else {
          logTest('Veritabanı Bağlantısı', 'PASS');
          db.close();
          resolve(true);
        }
      });
    } catch (error) {
      logTest('Veritabanı Bağlantısı', 'FAIL', error.message);
      resolve(false);
    }
  });
}

async function testDatabaseTables() {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logTest('Veritabanı Tabloları', 'FAIL', err.message);
        resolve(false);
        return;
      }

      const requiredTables = [
        'users', 'ogrenciler', 'sinavlar', 'sinav_katilimcilari',
        'sinav_sonuclari', 'sinav_paketleri', 'kurumsal_icerik',
        'pdf_learning_patterns', 'whatsapp_ayarlari', 'bildirim_gecmisi',
        'duyurular', 'slider', 'sinav_talepleri', 'ogrenci_talepleri'
      ];

      let missingTables = [];
      let checked = 0;

      requiredTables.forEach(table => {
        db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table], (err, row) => {
          checked++;
          if (err) {
            missingTables.push(table);
          } else if (!row) {
            missingTables.push(table);
          }

          if (checked === requiredTables.length) {
            db.close();
            if (missingTables.length === 0) {
              logTest('Veritabanı Tabloları', 'PASS');
            } else {
              logTest('Veritabanı Tabloları', 'WARN', `Eksik tablolar: ${missingTables.join(', ')}`);
            }
            resolve(missingTables.length === 0);
          }
        });
      });
    });
  });
}

function testEnvironmentVariables() {
  const required = ['SESSION_SECRET'];
  const optional = ['PORT', 'DB_PATH', 'WHATSAPP_API_TOKEN', 'PAYTR_MERCHANT_ID'];
  
  let missing = [];
  let warnings = [];

  required.forEach(varName => {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  });

  optional.forEach(varName => {
    if (!process.env[varName]) {
      warnings.push(varName);
    }
  });

  if (missing.length > 0) {
    logTest('Environment Değişkenleri', 'FAIL', `Eksik: ${missing.join(', ')}`);
    return false;
  } else if (warnings.length > 0) {
    logTest('Environment Değişkenleri', 'WARN', `Opsiyonel eksik: ${warnings.join(', ')}`);
    return true;
  } else {
    logTest('Environment Değişkenleri', 'PASS');
    return true;
  }
}

function testDependencies() {
  const requiredModules = [
    'express', 'express-session', 'bcrypt', 'sqlite3',
    'multer', 'pdf-parse', 'pdf-lib', 'exceljs',
    'csv-parser', 'dotenv', 'express-rate-limit'
  ];

  let missing = [];

  requiredModules.forEach(module => {
    try {
      require(module);
    } catch (error) {
      missing.push(module);
    }
  });

  if (missing.length > 0) {
    logTest('Bağımlılıklar', 'FAIL', `Eksik modüller: ${missing.join(', ')}`);
    return false;
  } else {
    logTest('Bağımlılıklar', 'PASS');
    return true;
  }
}

function testFileStructure() {
  const requiredFiles = [
    'server.js',
    'package.json',
    'views/index.ejs',
    'views/login.ejs',
    'public'
  ];

  let missing = [];

  requiredFiles.forEach(file => {
    if (!fs.existsSync(path.join(__dirname, file))) {
      missing.push(file);
    }
  });

  if (missing.length > 0) {
    logTest('Dosya Yapısı', 'WARN', `Eksik dosyalar: ${missing.join(', ')}`);
    return false;
  } else {
    logTest('Dosya Yapısı', 'PASS');
    return true;
  }
}

async function testServerSyntax() {
  try {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    
    // Basit syntax kontrolleri
    const openBraces = (serverCode.match(/{/g) || []).length;
    const closeBraces = (serverCode.match(/}/g) || []).length;
    const openParens = (serverCode.match(/\(/g) || []).length;
    const closeParens = (serverCode.match(/\)/g) || []).length;

    if (openBraces !== closeBraces) {
      logTest('Server Syntax', 'FAIL', `Parantez uyumsuzluğu: { ${openBraces} vs } ${closeBraces}`);
      return false;
    }

    if (openParens !== closeParens) {
      logTest('Server Syntax', 'FAIL', `Parantez uyumsuzluğu: ( ${openParens} vs ) ${closeParens}`);
      return false;
    }

    // require() çağrılarını kontrol et
    const requireMatches = serverCode.match(/require\(['"]([^'"]+)['"]\)/g);
    if (!requireMatches) {
      logTest('Server Syntax', 'WARN', 'require() çağrıları bulunamadı');
    }

    logTest('Server Syntax', 'PASS');
    return true;
  } catch (error) {
    logTest('Server Syntax', 'FAIL', error.message);
    return false;
  }
}

async function testRoutes() {
  try {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    
    const routePatterns = [
      { pattern: /app\.get\(['"]\/['"]/, name: 'Ana Sayfa (/)' },
      { pattern: /app\.get\(['"]\/login['"]/, name: 'Login Sayfası' },
      { pattern: /app\.post\(['"]\/login['"]/, name: 'Login İşlemi' },
      { pattern: /app\.get\(['"]\/register['"]/, name: 'Kayıt Sayfası' },
      { pattern: /app\.get\(['"]\/kurum\/dashboard['"]/, name: 'Kurum Dashboard' },
      { pattern: /app\.get\(['"]\/veli\/dashboard['"]/, name: 'Veli Dashboard' },
      { pattern: /app\.get\(['"]\/rehber\/dashboard['"]/, name: 'Rehber Dashboard' },
      { pattern: /app\.post\(['"]\/kurum\/sinav-sonuc-yukle/, name: 'PDF Yükleme' },
      { pattern: /app\.get\(['"]\/veli\/sinav-sonuclari['"]/, name: 'Veli Sonuçlar' },
      { pattern: /app\.get\(['"]\/rehber\/sinav-sonuclari['"]/, name: 'Rehber Sonuçlar' }
    ];

    let missing = [];

    routePatterns.forEach(route => {
      if (!route.pattern.test(serverCode)) {
        missing.push(route.name);
      }
    });

    if (missing.length > 0) {
      logTest('Route Tanımları', 'WARN', `Eksik route'lar: ${missing.join(', ')}`);
      return false;
    } else {
      logTest('Route Tanımları', 'PASS');
      return true;
    }
  } catch (error) {
    logTest('Route Tanımları', 'FAIL', error.message);
    return false;
  }
}

function testMiddleware() {
  try {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    
    const middlewarePatterns = [
      { pattern: /bodyParser\.json\(\)|express\.json\(\)/, name: 'JSON Parser' },
      { pattern: /bodyParser\.urlencoded|express\.urlencoded/, name: 'URL Encoded Parser' },
      { pattern: /express-session/, name: 'Session Middleware' },
      { pattern: /rateLimit/, name: 'Rate Limiting' },
      { pattern: /requireAuth/, name: 'Auth Middleware' }
    ];

    let missing = [];

    middlewarePatterns.forEach(middleware => {
      if (!middleware.pattern.test(serverCode)) {
        missing.push(middleware.name);
      }
    });

    if (missing.length > 0) {
      logTest('Middleware', 'WARN', `Eksik middleware: ${missing.join(', ')}`);
      return false;
    } else {
      logTest('Middleware', 'PASS');
      return true;
    }
  } catch (error) {
    logTest('Middleware', 'FAIL', error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('\n🧪 Sınav Merkezi - Modül Testleri Başlatılıyor...\n');
  console.log('='.repeat(60));

  // Temel testler
  testDependencies();
  testEnvironmentVariables();
  testFileStructure();
  await testServerSyntax();
  await testDatabaseConnection();
  await testDatabaseTables();
  await testRoutes();
  testMiddleware();

  // Özet
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 TEST ÖZETİ\n');
  console.log(`✅ Başarılı: ${testResults.passed.length}`);
  console.log(`❌ Başarısız: ${testResults.failed.length}`);
  console.log(`⚠️  Uyarılar: ${testResults.warnings.length}`);

  if (testResults.failed.length > 0) {
    console.log('\n❌ BAŞARISIZ TESTLER:\n');
    testResults.failed.forEach(test => {
      console.log(`  - ${test.name}: ${test.message}`);
    });
  }

  if (testResults.warnings.length > 0) {
    console.log('\n⚠️  UYARILAR:\n');
    testResults.warnings.forEach(test => {
      console.log(`  - ${test.name}: ${test.message}`);
    });
  }

  console.log('\n' + '='.repeat(60));

  // Çıkış kodu
  process.exit(testResults.failed.length > 0 ? 1 : 0);
}

// Testleri çalıştır
runAllTests().catch(error => {
  console.error('Test hatası:', error);
  process.exit(1);
});

