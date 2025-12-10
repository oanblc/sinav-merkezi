// Hizli veri aktarimi - Batch islemler ile
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

// Batch insert - 50 kayit birden
const BATCH_SIZE = 50;

async function insertBatch(tableName, columns, rows) {
  if (rows.length === 0) return 0;

  const statements = rows.map(row => {
    const values = columns.map(col => row[col]);
    const placeholders = columns.map(() => '?').join(', ');
    return {
      sql: `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
      args: values
    };
  });

  try {
    await turso.batch(statements, 'write');
    return rows.length;
  } catch (err) {
    // Batch basarisiz olursa tek tek dene
    let inserted = 0;
    for (const stmt of statements) {
      try {
        await turso.execute(stmt);
        inserted++;
      } catch (e) {
        // Hatayi atla
      }
    }
    return inserted;
  }
}

async function migrate() {
  console.log('='.repeat(60));
  console.log('HIZLI VERI AKTARIMI: SQLite -> Turso (Batch)');
  console.log('='.repeat(60));

  const tables = await getTables();
  console.log(`\nBulunan tablolar: ${tables.length}`);

  let totalRows = 0;

  // Foreign key kontrolunu kapat
  try {
    await turso.execute('PRAGMA foreign_keys = OFF');
  } catch(e) {}

  for (const tableName of tables) {
    process.stdout.write(`\n${tableName}: `);

    try {
      // 1. Lokal semayi al
      const schema = await getTableSchema(tableName);
      if (!schema) {
        console.log('schema bulunamadi, atlaniyor');
        continue;
      }

      // 2. Turso'da tabloyu sil ve yeniden olustur
      try {
        await turso.execute(`DROP TABLE IF EXISTS ${tableName}`);
      } catch(e) {}

      // Semayi Turso'ya uygula
      await turso.execute(schema);
      process.stdout.write('tablo olusturuldu, ');

      // 3. Verileri al
      const rows = await getTableData(tableName);
      if (rows.length === 0) {
        console.log('bos tablo');
        continue;
      }

      // 4. Verileri batch olarak aktar
      const columns = Object.keys(rows[0]);
      let inserted = 0;

      // Batch'ler halinde isle
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const count = await insertBatch(tableName, columns, batch);
        inserted += count;

        // Progress goster
        if (rows.length > 100 && (i + BATCH_SIZE) % 500 === 0) {
          process.stdout.write(`${inserted}...`);
        }
      }

      console.log(`${inserted}/${rows.length} kayit aktarildi`);
      totalRows += inserted;

    } catch (err) {
      console.log(`HATA: ${err.message.substring(0, 50)}`);
    }
  }

  // Foreign key kontrolunu ac
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
