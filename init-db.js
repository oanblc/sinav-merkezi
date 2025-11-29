const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('sinav_merkezi.db', (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err);
  } else {
    console.log('✅ Veritabanı bağlandı');
  }
});

db.serialize(() => {
  console.log('Tablolar oluşturuluyor...');
  
  // Users tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      user_type TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Öğrenciler tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS ogrenciler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_soyad TEXT NOT NULL,
      tc_no TEXT,
      veli_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (veli_id) REFERENCES users(id)
    )
  `);
  
  // Sınavlar tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS sinavlar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad TEXT NOT NULL,
      tarih DATE NOT NULL,
      dosya_yolu TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Sınav sonuçları tablosu (PDF bazlı)
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
  
  // Satın alınabilir sınavlar tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS satin_alinabilir_sinavlar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baslik TEXT NOT NULL,
      aciklama TEXT,
      fiyat REAL NOT NULL,
      kategori TEXT DEFAULT 'YKS',
      sinav_sayisi INTEGER,
      tyt_sayisi INTEGER,
      ayt_sayisi INTEGER,
      ozellikler TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Site ayarları tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS site_ayarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anahtar TEXT UNIQUE NOT NULL,
      deger TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Sınav takvimi tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS sinav_takvimi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT NOT NULL,
      sinif TEXT NOT NULL,
      sinav_tarihi DATETIME NOT NULL,
      son_secim_tarihi DATETIME,
      giris_belgesi_tarihi DATETIME,
      durum TEXT DEFAULT 'Açık',
      aciklama TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Cevap anahtarları tablosu
  db.run(`
    CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sinav_adi TEXT NOT NULL,
      sinav_turu TEXT NOT NULL,
      sinif TEXT NOT NULL,
      sinav_tarihi DATETIME NOT NULL,
      durum TEXT DEFAULT 'Sonuç açıklandı',
      cevap_anahtari_url TEXT,
      sonuc_url TEXT,
      sira INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('❌ Tablo oluşturma hatası:', err);
    } else {
      console.log('✅ Tüm tablolar başarıyla oluşturuldu!');
      db.close((err) => {
        if (err) {
          console.error(err.message);
        }
        console.log('✅ Veritabanı bağlantısı kapatıldı');
      });
    }
  });
});

