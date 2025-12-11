// Turso'da paket_talepleri tablosunu olustur
const { createClient } = require('@libsql/client');

const turso = createClient({
  url: 'libsql://sinav-merkezi-oanblc.aws-eu-west-2.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NDk0ODI2NDUsImlkIjoiZTRjOTNlMzgtMjdkZC00NWUxLWI3YWMtYjkxMzlhNWFhMjM3In0.9w5S4LnZxRxgVMG6GzJBz-Vx2ZfLKpcHET59c47tJLeDO0e3LnxLNpQWHt93Bd1NvnqWKkOdJmKUOrbGjuQUDg',
});

async function createTable() {
  console.log('paket_talepleri tablosu olusturuluyor...');

  try {
    await turso.execute(`
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
    console.log('paket_talepleri tablosu basariyla olusturuldu!');
  } catch (err) {
    console.error('Hata:', err.message);
  }

  process.exit(0);
}

createTable();
