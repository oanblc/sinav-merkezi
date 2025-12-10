// Tam veri aktarimi - Lokal SQLite'dan Turso'ya
// Tabloları drop edip yeniden olusturur
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');

const TURSO_URL = 'libsql://sinav-merkezi-oanblc.aws-us-west-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NjUzODk1MDEsImlkIjoiYzVlZjA2MDktODQxNi00MDY3LTkwYjQtNjIwOGE1MDVlM2Q3IiwicmlkIjoiOWU4YjE0NDUtZWVkMy00MWIwLWE1MTItOTg5NzExNDE3NDMxIn0.Pll4IM5wC2m_FOAWyFed7_Qgade048ovydre0hpngp5n3pz99W8JDHFixs2kUWk4IsRhD6an0DpUMV0qyHi5CA';

const DB_PATH = path.join(__dirname, 'sinav_merkezi.db');

const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const localDb = new sqlite3.Database(DB_PATH);

function dbAll(query) {
  return new Promise((resolve, reject) => {
    localDb.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function dbGet(query) {
  return new Promise((resolve, reject) => {
    localDb.get(query, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function getTableSchema(tableName) {
  const row = await dbGet(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
  return row ? row.sql : null;
}

async function getTableData(tableName) {
  return await dbAll(`SELECT * FROM ${tableName}`);
}

async function getTables() {
  const rows = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return rows.map(r => r.name);
}

async function migrate() {
  console.log('='.repeat(60));
  console.log('TAM VERİ AKTARIMI: SQLite -> Turso');
  console.log('='.repeat(60));

  // Tüm tabloları al
  const tables = await getTables();
  console.log(`\nBulunan tablolar: ${tables.length}`);

  let totalRows = 0;

  // Foreign key kontrolünü kapat
  try {
    await turso.execute('PRAGMA foreign_keys = OFF');
  } catch(e) {}

  for (const tableName of tables) {
    process.stdout.write(`\n${tableName}: `);

    try {
      // 1. Lokal şemayı al
      const schema = await getTableSchema(tableName);
      if (!schema) {
        console.log('schema bulunamadi, atlaniyor');
        continue;
      }

      // 2. Turso'da tabloyu sil ve yeniden oluştur
      try {
        await turso.execute(`DROP TABLE IF EXISTS ${tableName}`);
      } catch(e) {}

      // Şemayı Turso'ya uygula
      await turso.execute(schema);
      process.stdout.write('tablo olusturuldu, ');

      // 3. Verileri al
      const rows = await getTableData(tableName);
      if (rows.length === 0) {
        console.log('bos tablo');
        continue;
      }

      // 4. Verileri aktar
      const columns = Object.keys(rows[0]);
      let inserted = 0;

      for (const row of rows) {
        try {
          const values = columns.map(col => row[col]);
          const placeholders = columns.map(() => '?').join(', ');
          const colList = columns.join(', ');

          await turso.execute({
            sql: `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`,
            args: values
          });
          inserted++;
        } catch (err) {
          // Hata olursa atla
        }
      }

      console.log(`${inserted}/${rows.length} kayit aktarildi`);
      totalRows += inserted;

    } catch (err) {
      console.log(`HATA: ${err.message.substring(0, 50)}`);
    }
  }

  // Foreign key kontrolünü aç
  try {
    await turso.execute('PRAGMA foreign_keys = ON');
  } catch(e) {}

  console.log('\n' + '='.repeat(60));
  console.log(`TAMAMLANDI! Toplam ${totalRows} kayit aktarildi.`);
  console.log('='.repeat(60));

  localDb.close();
  process.exit(0);
}

migrate().catch(err => {
  console.error('HATA:', err);
  process.exit(1);
});
