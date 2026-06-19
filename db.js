const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');

// Environment variables
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const USE_TURSO = !!(TURSO_DATABASE_URL && TURSO_AUTH_TOKEN);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');

let db = null;
let tursoClient = null;

// Initialize database connection
function initConnection() {
  if (USE_TURSO) {
    tursoClient = createClient({
      url: TURSO_DATABASE_URL,
      authToken: TURSO_AUTH_TOKEN,
    });
    console.log('Turso Database connected:', TURSO_DATABASE_URL);
    return tursoClient;
  } else {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('SQLite connection error:', err);
      } else {
        console.log('Local SQLite Database connected:', DB_PATH);
      }
    });
    return db;
  }
}

// Database helper functions
async function dbGet(query, params = []) {
  if (USE_TURSO) {
    try {
      const result = await tursoClient.execute({ sql: query, args: params });
      return result.rows[0] || null;
    } catch (err) {
      console.error('Turso dbGet error:', err.message);
      throw err;
    }
  } else {
    return new Promise((resolve, reject) => {
      db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
}

async function dbAll(query, params = []) {
  if (USE_TURSO) {
    try {
      const result = await tursoClient.execute({ sql: query, args: params });
      return result.rows || [];
    } catch (err) {
      console.error('Turso dbAll error:', err.message);
      throw err;
    }
  } else {
    return new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

async function dbRun(query, params = []) {
  if (USE_TURSO) {
    try {
      const result = await tursoClient.execute({ sql: query, args: params });
      return { lastID: Number(result.lastInsertRowid) || 0, changes: result.rowsAffected || 0 };
    } catch (err) {
      // "duplicate column name" hatalari beklenen migration gurultusudur
      // (safeAlterTable bunlari zaten yutuyor) - loglamadan tekrar firlat
      if (!/duplicate column name/i.test(err.message)) {
        console.error('Turso dbRun error:', err.message);
      }
      throw err;
    }
  } else {
    return new Promise((resolve, reject) => {
      db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
}

// For SQLite serialize operations
function getDb() {
  return db;
}

function isTurso() {
  return USE_TURSO;
}

// Turso'da eksik tablolari olustur (uygulama baslarken cagirilir)
async function ensureTursoTables() {
  if (!USE_TURSO) return;

  const tables = [
    `CREATE TABLE IF NOT EXISTS paket_talepleri (
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
      yanitlanma_tarihi DATETIME
    )`
  ];

  for (const sql of tables) {
    try {
      await tursoClient.execute(sql);
      console.log('Turso table ensured:', sql.substring(0, 50) + '...');
    } catch (err) {
      // Tablo zaten varsa sorun yok
      if (!err.message.includes('already exists')) {
        console.error('Turso table creation warning:', err.message);
      }
    }
  }
}

module.exports = {
  initConnection,
  dbGet,
  dbAll,
  dbRun,
  getDb,
  isTurso,
  USE_TURSO,
  ensureTursoTables
};
