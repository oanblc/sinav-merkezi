// Turso'da admin kullanici olusturma scripti
require('dotenv').config();
const bcrypt = require('bcrypt');
const { initConnection, dbRun, dbGet } = require('./db');

async function createAdmin() {
  // Veritabani baglantisi
  initConnection();

  // Biraz bekle (baglanti icin)
  await new Promise(resolve => setTimeout(resolve, 1000));

  const username = 'kurum_admin';
  const email = 'admin@sinavmerkezi.com';
  const password = 'Admin2024!';
  const userType = 'kurum_yonetici';

  try {
    // Kullanici var mi kontrol et
    const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username]);

    if (existing) {
      console.log('Kullanici zaten mevcut:', username);
      process.exit(0);
    }

    // Sifre hash'le
    const passwordHash = await bcrypt.hash(password, 10);

    // Kullanici olustur
    const result = await dbRun(
      `INSERT INTO users (username, email, password_hash, user_type, ad_soyad)
       VALUES (?, ?, ?, ?, ?)`,
      [username, email, passwordHash, userType, 'Kurum Admin']
    );

    console.log('Admin kullanici olusturuldu!');
    console.log('Kullanici adi:', username);
    console.log('Sifre:', password);
    console.log('User ID:', result.lastID);

  } catch (err) {
    console.error('Hata:', err.message);
  }

  process.exit(0);
}

createAdmin();
