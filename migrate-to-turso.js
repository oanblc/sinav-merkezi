// Lokal SQLite'dan Turso'ya veri aktarma scripti
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');

// Turso baglantisi
const TURSO_DATABASE_URL = 'libsql://sinav-merkezi-oanblc.aws-us-west-2.turso.io';
const TURSO_AUTH_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NjUzODk1MDEsImlkIjoiYzVlZjA2MDktODQxNi00MDY3LTkwYjQtNjIwOGE1MDVlM2Q3IiwicmlkIjoiOWU4YjE0NDUtZWVkMy00MWIwLWE1MTItOTg5NzExNDE3NDMxIn0.Pll4IM5wC2m_FOAWyFed7_Qgade048ovydre0hpngp5n3pz99W8JDHFixs2kUWk4IsRhD6an0DpUMV0qyHi5CA';

const DB_PATH = path.join(__dirname, 'sinav_merkezi.db');

// Turso client
const turso = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

// Lokal SQLite baglantisi
const localDb = new sqlite3.Database(DB_PATH);

// Promise wrapper for sqlite3
function dbAll(query) {
  return new Promise((resolve, reject) => {
    localDb.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Aktarilacak tablolar
const tables = [
  'users',
  'ogrenciler',
  'sinavlar',
  'sinav_katilimcilari',
  'sinav_sonuclari',
  'sinav_talepleri',
  'sinav_paketleri',
  'paket_sinavlari',
  'paket_atamalari',
  'kurumsal_icerik',
  'ogrenci_kayitlari',
  'whatsapp_ayarlari',
  'bildirim_gecmisi',
  'pdf_learning_patterns',
  'matching_failures',
  'pdf_structure_memory',
  'slider',
  'duyurular',
  'satin_alinabilir_sinavlar',
  'site_ayarlari',
  'kurumsal_sayfalar',
  'cevap_anahtarlari',
  'sinav_sonuclari_pdf',
  'ogrenci_talepleri',
  'sinav_takvimi'
];

async function getTableColumns(tableName) {
  try {
    const rows = await dbAll(`PRAGMA table_info(${tableName})`);
    return rows.map(r => r.name);
  } catch (err) {
    return [];
  }
}

async function migrateTable(tableName) {
  try {
    // Lokal verileri al
    const rows = await dbAll(`SELECT * FROM ${tableName}`);

    if (rows.length === 0) {
      console.log(`  ${tableName}: Bos tablo, atlaniyor`);
      return 0;
    }

    // Kolon isimlerini al
    const columns = Object.keys(rows[0]);

    let inserted = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        // NULL degerleri isle
        const values = columns.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return null;
          return val;
        });

        // Placeholder'lar
        const placeholders = columns.map(() => '?').join(', ');
        const columnList = columns.join(', ');

        // INSERT OR REPLACE kullan (varsa guncelle, yoksa ekle)
        const sql = `INSERT OR REPLACE INTO ${tableName} (${columnList}) VALUES (${placeholders})`;

        await turso.execute({
          sql: sql,
          args: values
        });

        inserted++;
      } catch (err) {
        errors++;
        if (errors <= 3) {
          console.log(`    Hata (${tableName}): ${err.message.substring(0, 80)}`);
        }
      }
    }

    console.log(`  ${tableName}: ${inserted}/${rows.length} kayit aktarildi`);
    return inserted;

  } catch (err) {
    console.log(`  ${tableName}: Tablo bulunamadi veya hata - ${err.message.substring(0, 50)}`);
    return 0;
  }
}

async function migrate() {
  console.log('='.repeat(50));
  console.log('SQLite -> Turso Veri Aktarimi Basliyor');
  console.log('='.repeat(50));
  console.log('Lokal DB:', DB_PATH);
  console.log('Turso DB:', TURSO_DATABASE_URL);
  console.log('');

  let totalMigrated = 0;

  for (const table of tables) {
    const count = await migrateTable(table);
    totalMigrated += count;
  }

  console.log('');
  console.log('='.repeat(50));
  console.log(`Toplam ${totalMigrated} kayit aktarildi!`);
  console.log('='.repeat(50));

  // Baglantilari kapat
  localDb.close();

  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration hatasi:', err);
  process.exit(1);
});
