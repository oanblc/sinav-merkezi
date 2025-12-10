// Turso'daki tablolara eksik kolonlari ekle
const { createClient } = require('@libsql/client');

const turso = createClient({
  url: 'libsql://sinav-merkezi-oanblc.aws-us-west-2.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NjUzODk1MDEsImlkIjoiYzVlZjA2MDktODQxNi00MDY3LTkwYjQtNjIwOGE1MDVlM2Q3IiwicmlkIjoiOWU4YjE0NDUtZWVkMy00MWIwLWE1MTItOTg5NzExNDE3NDMxIn0.Pll4IM5wC2m_FOAWyFed7_Qgade048ovydre0hpngp5n3pz99W8JDHFixs2kUWk4IsRhD6an0DpUMV0qyHi5CA',
});

const alterStatements = [
  // ogrenciler tablosuna eksik kolon
  'ALTER TABLE ogrenciler ADD COLUMN rehber_ogretmen_id INTEGER',

  // Diger eksik tablolari olustur
  `CREATE TABLE IF NOT EXISTS satinalma (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veli_id INTEGER,
    sinav_id INTEGER,
    tutar REAL,
    durum TEXT DEFAULT 'beklemede',
    merchant_oid TEXT,
    paytr_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS paytr_ayarlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id TEXT,
    merchant_key TEXT,
    merchant_salt TEXT,
    aktif INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`
];

async function fixSchema() {
  console.log('Turso schema duzeltmeleri yapiliyor...');

  for (const sql of alterStatements) {
    try {
      await turso.execute(sql);
      console.log('OK:', sql.substring(0, 60) + '...');
    } catch (err) {
      // Kolon/tablo zaten varsa hata vermez
      if (err.message.includes('duplicate') || err.message.includes('already exists')) {
        console.log('SKIP (zaten var):', sql.substring(0, 40));
      } else {
        console.log('WARN:', err.message.substring(0, 60));
      }
    }
  }

  console.log('\nSchema duzeltmeleri tamamlandi!');
  process.exit(0);
}

fixSchema();
