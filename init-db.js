// Database initialization module - works with both Turso and SQLite
const { dbRun, dbGet, dbAll, getDb, USE_TURSO } = require('./db');

// All CREATE TABLE statements
const createTableStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    user_type TEXT NOT NULL,
    ad_soyad TEXT,
    kurum TEXT,
    telefon TEXT,
    brans TEXT,
    uzmanlik_alani TEXT,
    mezuniyet TEXT,
    profil_foto TEXT,
    password_changed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS ogrenciler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad_soyad TEXT NOT NULL,
    tc_no TEXT,
    telefon TEXT,
    okul TEXT,
    sinif TEXT,
    ogrenci_no TEXT UNIQUE,
    veli_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (veli_id) REFERENCES users(id)
  )`,

  `CREATE TABLE IF NOT EXISTS sinavlar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad TEXT NOT NULL,
    tarih DATE NOT NULL,
    dosya_yolu TEXT,
    fiyat REAL DEFAULT 0,
    aciklama TEXT,
    sinif TEXT,
    ders TEXT,
    durum TEXT DEFAULT 'taslak',
    katilimci_sayisi INTEGER DEFAULT 0,
    sonuc_yuklendi INTEGER DEFAULT 0,
    sonuclar_aciklandi INTEGER DEFAULT 0,
    cevap_anahtari_pdf TEXT,
    sinav_durumu TEXT DEFAULT 'Basvuru asamasinda',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_katilimcilari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinav_id INTEGER NOT NULL,
    ogrenci_id INTEGER NOT NULL,
    ogrenci_kaynak TEXT DEFAULT 'kurum',
    pdf_path TEXT,
    sonuc_durumu TEXT DEFAULT 'beklemede',
    whatsapp_gonderim_tarihi DATETIME,
    pdf_goruldu INTEGER DEFAULT 0,
    pdf_gorunme_tarihi DATETIME,
    pdf_indirilme_sayisi INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sinav_id) REFERENCES sinavlar(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_sonuclari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinav_id INTEGER NOT NULL,
    ogrenci_id INTEGER NOT NULL,
    sayfa_no INTEGER NOT NULL,
    sonuc_verisi TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sinav_id) REFERENCES sinavlar(id),
    FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler(id)
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_talepleri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veli_id INTEGER NOT NULL,
    sinav_id INTEGER NOT NULL,
    durum TEXT DEFAULT 'beklemede',
    aciklama TEXT,
    yanit TEXT,
    talep_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    yanitlanma_tarihi DATETIME,
    FOREIGN KEY (veli_id) REFERENCES users(id),
    FOREIGN KEY (sinav_id) REFERENCES sinavlar(id)
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_paketleri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad TEXT NOT NULL,
    aciklama TEXT,
    sinif TEXT,
    toplam_sinav_sayisi INTEGER DEFAULT 0,
    aktif INTEGER DEFAULT 1,
    fiyat REAL DEFAULT 0,
    olusturulma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    kurum_id INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS paket_sinavlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paket_id INTEGER NOT NULL,
    sinav_id INTEGER NOT NULL,
    sira INTEGER DEFAULT 0,
    FOREIGN KEY (paket_id) REFERENCES sinav_paketleri(id) ON DELETE CASCADE,
    FOREIGN KEY (sinav_id) REFERENCES sinavlar(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS paket_atamalari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paket_id INTEGER NOT NULL,
    ogrenci_id INTEGER NOT NULL,
    ogrenci_kaynak TEXT DEFAULT 'kurum',
    atama_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    durum TEXT DEFAULT 'aktif',
    FOREIGN KEY (paket_id) REFERENCES sinav_paketleri(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_merkezleri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad TEXT NOT NULL,
    adres TEXT,
    telefon TEXT,
    eposta TEXT,
    sira INTEGER DEFAULT 0,
    aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS ogrenci_arsiv (
    arsiv_id INTEGER PRIMARY KEY AUTOINCREMENT,
    orijinal_id INTEGER,
    sinif TEXT, ogrenci_adi_soyadi TEXT, telefon TEXT, tc_kimlik_no TEXT,
    veli_adi TEXT, veli_telefon TEXT, tutar TEXT, odenen_tutar TEXT,
    odeme_durumu TEXT, odeme_turu TEXT, edessis_kaydi TEXT, taksit TEXT,
    veli_username TEXT,
    odeme_gecmisi_json TEXT,
    silinme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    silen TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS kurumsal_icerik (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sayfa_adi TEXT NOT NULL UNIQUE,
    baslik TEXT NOT NULL,
    alt_baslik TEXT,
    icerik TEXT,
    meta_description TEXT,
    meta_keywords TEXT,
    aktif INTEGER DEFAULT 1,
    sira INTEGER DEFAULT 0,
    guncelleme_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP,
    olusturulma_tarihi DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS ogrenci_kayitlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinif TEXT NOT NULL,
    ogrenci_adi_soyadi TEXT NOT NULL,
    telefon TEXT,
    tc_kimlik_no TEXT,
    veli_adi TEXT,
    veli_telefon TEXT,
    tutar TEXT,
    odenen_tutar TEXT DEFAULT '0',
    odeme_durumu TEXT DEFAULT 'BEKLIYOR',
    odeme_turu TEXT,
    edessis_kaydi TEXT,
    taksit TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS odeme_gecmisi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ogrenci_kayit_id INTEGER NOT NULL,
    tutar REAL NOT NULL DEFAULT 0,
    odeme_tarihi TEXT,
    aciklama TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ogrenci_kayit_id) REFERENCES ogrenci_kayitlari(id)
  )`,

  `CREATE TABLE IF NOT EXISTS whatsapp_ayarlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_url TEXT,
    api_token TEXT,
    phone_number TEXT,
    aktif INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS bildirim_gecmisi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bildirim_tipi TEXT,
    alici_telefon TEXT,
    mesaj TEXT,
    durum TEXT DEFAULT 'gonderildi',
    hata_mesaji TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS pdf_learning_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kurum_id INTEGER,
    sinav_tipi TEXT,
    name_line_number INTEGER,
    name_position_type TEXT,
    avg_font_size REAL,
    x_coordinate REAL,
    y_coordinate REAL,
    success_rate REAL DEFAULT 1.0,
    use_count INTEGER DEFAULT 1,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS matching_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinav_id INTEGER,
    attempted_name TEXT,
    correct_name TEXT,
    failure_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS pdf_structure_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kurum_id INTEGER,
    file_hash TEXT,
    name_extraction_method TEXT,
    name_pattern TEXT,
    success_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS slider (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baslik TEXT,
    aciklama TEXT,
    resim_yolu TEXT,
    link TEXT,
    sira INTEGER DEFAULT 0,
    aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS duyurular (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baslik TEXT NOT NULL,
    icerik TEXT,
    resim_yolu TEXT,
    tarih DATE,
    aktif INTEGER DEFAULT 1,
    sira INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS satin_alinabilir_sinavlar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baslik TEXT NOT NULL,
    aciklama TEXT,
    kategori TEXT NOT NULL,
    sinav_sayisi INTEGER,
    tyt_sayisi INTEGER,
    ayt_sayisi INTEGER,
    fiyat REAL NOT NULL,
    resim_yolu TEXT,
    ozellikler TEXT,
    aktif INTEGER DEFAULT 1,
    sira INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS site_ayarlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anahtar TEXT UNIQUE NOT NULL,
    deger TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS kurumsal_sayfalar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sayfa_slug TEXT UNIQUE NOT NULL,
    sayfa_adi TEXT NOT NULL,
    baslik TEXT NOT NULL,
    icerik TEXT,
    seo_baslik TEXT,
    seo_aciklama TEXT,
    aktif INTEGER DEFAULT 1,
    sira INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS cevap_anahtarlari (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinav_adi TEXT NOT NULL,
    sinif TEXT,
    dosya_yolu TEXT NOT NULL,
    dosya_adi TEXT,
    aciklama TEXT,
    tarih DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_sonuclari_pdf (
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
    pdf_isim TEXT,
    sayfa_no INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler(id)
  )`,

  `CREATE TABLE IF NOT EXISTS ogrenci_talepleri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ogrenci_no TEXT,
    ad_soyad TEXT,
    sinif TEXT,
    okul TEXT,
    veli_id INTEGER NOT NULL,
    rehber_id INTEGER,
    rehber_ogretmen_id INTEGER,
    ogrenci_id INTEGER,
    durum TEXT DEFAULT 'beklemede',
    mesaj TEXT,
    sonuc_goruntuleme_aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (veli_id) REFERENCES users (id),
    FOREIGN KEY (rehber_id) REFERENCES users (id),
    FOREIGN KEY (rehber_ogretmen_id) REFERENCES users (id),
    FOREIGN KEY (ogrenci_id) REFERENCES ogrenciler (id)
  )`,

  `CREATE TABLE IF NOT EXISTS sinav_takvimi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sinav_adi TEXT NOT NULL,
    sinif TEXT,
    tarih DATE NOT NULL,
    saat TEXT,
    sure TEXT,
    ders TEXT,
    konu TEXT,
    aciklama TEXT,
    durum TEXT DEFAULT 'yaklasan',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

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
    yanitlanma_tarihi DATETIME,
    FOREIGN KEY (veli_id) REFERENCES users(id),
    FOREIGN KEY (paket_id) REFERENCES sinav_paketleri(id)
  )`
];

// Default data inserts
const defaultInserts = [
  `INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adi', 'Adana Sınav Kulübü')`,
  `INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_adres', 'Toros Mah. Ahmet Sapmaz Blv. Yusuf Atlı Apt. A Blok No:61D, Çukurova / Adana')`,
  `INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_telefon', '0 (541) 190 24 25')`,
  `INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_email', 'adanasinavkulubu@outlook.com.tr')`,
  `INSERT OR IGNORE INTO site_ayarlari (anahtar, deger) VALUES ('site_aciklama', '30 yillik egitim tecrubesiyle ogrencilerimizi gelecege hazirliyoruz.')`
];

// Index creation
const createIndexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sinav_katilimci_unique ON sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak)`
];

// Safe ALTER TABLE helper - ignores "duplicate column" errors
async function safeAlterTable(sql) {
  try {
    await dbRun(sql);
    return true;
  } catch (err) {
    if (err.message && (err.message.includes('duplicate column') || err.message.includes('already exists'))) {
      return false; // Column already exists, that's ok
    }
    // For Turso, column exists errors may be different
    if (err.message && err.message.includes('SQLITE_ERROR')) {
      return false;
    }
    console.log('ALTER TABLE warning:', err.message);
    return false;
  }
}

// Initialize all tables
async function initDatabase() {
  console.log('Initializing database tables...');
  console.log('Database mode:', USE_TURSO ? 'Turso Cloud' : 'Local SQLite');

  try {
    // Create all tables
    for (const sql of createTableStatements) {
      try {
        await dbRun(sql);
      } catch (err) {
        // Table might already exist, that's ok
        if (!err.message.includes('already exists')) {
          console.log('Table creation note:', err.message.substring(0, 100));
        }
      }
    }
    console.log('Tables created/verified');

    // Create indexes
    for (const sql of createIndexes) {
      try {
        await dbRun(sql);
      } catch (err) {
        // Index might already exist
      }
    }
    console.log('Indexes created/verified');

    // Insert default data
    for (const sql of defaultInserts) {
      try {
        await dbRun(sql);
      } catch (err) {
        // Default data might already exist
      }
    }
    console.log('Default data inserted');

    // Add missing columns (migration)
    const alterStatements = [
      'ALTER TABLE users ADD COLUMN ad_soyad TEXT',
      'ALTER TABLE users ADD COLUMN kurum TEXT',
      'ALTER TABLE users ADD COLUMN password_changed INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN telefon TEXT',
      'ALTER TABLE users ADD COLUMN brans TEXT',
      'ALTER TABLE users ADD COLUMN uzmanlik_alani TEXT',
      'ALTER TABLE users ADD COLUMN mezuniyet TEXT',
      'ALTER TABLE users ADD COLUMN profil_foto TEXT',
      'ALTER TABLE ogrenciler ADD COLUMN telefon TEXT',
      'ALTER TABLE ogrenciler ADD COLUMN okul TEXT',
      'ALTER TABLE ogrenciler ADD COLUMN sinif TEXT',
      'ALTER TABLE ogrenciler ADD COLUMN ogrenci_no TEXT',
      'ALTER TABLE sinavlar ADD COLUMN fiyat REAL DEFAULT 0',
      'ALTER TABLE sinavlar ADD COLUMN aciklama TEXT',
      'ALTER TABLE sinavlar ADD COLUMN sinif TEXT',
      'ALTER TABLE sinavlar ADD COLUMN ders TEXT',
      'ALTER TABLE sinavlar ADD COLUMN durum TEXT DEFAULT \'taslak\'',
      'ALTER TABLE sinavlar ADD COLUMN sonuclar_aciklandi INTEGER DEFAULT 0',
      'ALTER TABLE sinavlar ADD COLUMN katilimci_sayisi INTEGER DEFAULT 0',
      'ALTER TABLE sinavlar ADD COLUMN sonuc_yuklendi INTEGER DEFAULT 0',
      'ALTER TABLE sinavlar ADD COLUMN cevap_anahtari_pdf TEXT',
      'ALTER TABLE sinavlar ADD COLUMN sinav_durumu TEXT DEFAULT \'Basvuru asamasinda\'',
      'ALTER TABLE sinav_katilimcilari ADD COLUMN ogrenci_kaynak TEXT DEFAULT \'kurum\'',
      'ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_goruldu INTEGER DEFAULT 0',
      'ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_gorunme_tarihi DATETIME',
      'ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_indirilme_sayisi INTEGER DEFAULT 0',
      'ALTER TABLE ogrenci_talepleri ADD COLUMN rehber_ogretmen_id INTEGER',
      'ALTER TABLE ogrenci_talepleri ADD COLUMN ogrenci_id INTEGER',
      'ALTER TABLE ogrenci_talepleri ADD COLUMN sonuc_goruntuleme_aktif INTEGER DEFAULT 1',
      'ALTER TABLE sinav_sonuclari_pdf ADD COLUMN pdf_isim TEXT',
      'ALTER TABLE sinav_sonuclari_pdf ADD COLUMN sayfa_no INTEGER',
      'ALTER TABLE sinav_paketleri ADD COLUMN fiyat REAL DEFAULT 0',
      'ALTER TABLE satinalma ADD COLUMN merchant_oid TEXT',
      'ALTER TABLE satinalma ADD COLUMN paytr_token TEXT',
      'ALTER TABLE ogrenci_kayitlari ADD COLUMN veli_id INTEGER',
      'ALTER TABLE ogrenci_kayitlari ADD COLUMN odenen_tutar TEXT DEFAULT \'0\''
    ];

    for (const sql of alterStatements) {
      await safeAlterTable(sql);
    }
    console.log('Schema migrations completed');

    console.log('Database initialization complete!');

    // Veli baglantisi migration - mevcut velileri ogrenci_kayitlari ile bagla
    await migrateVeliBaglantisi();

    return true;
  } catch (err) {
    console.error('Database initialization error:', err);
    throw err;
  }
}

// Mevcut velileri ogrenci_kayitlari tablosuna bagla (TC eslesmesi ile)
// NOT: Tek bir toplu UPDATE kullanir - onceki N+1 dongu Turso'da binlerce
// round-trip yapip deploy'u stall/crash ettirebiliyordu.
async function migrateVeliBaglantisi() {
  try {
    console.log('Veli baglantisi migration basliyor...');

    const sonuc = await dbRun(`
      UPDATE ogrenci_kayitlari
      SET veli_id = (
        SELECT u.id FROM users u
        WHERE u.user_type = 'veli'
          AND REPLACE(CAST(u.username AS TEXT), '.0', '') = REPLACE(CAST(ogrenci_kayitlari.tc_kimlik_no AS TEXT), '.0', '')
          AND LENGTH(REPLACE(CAST(u.username AS TEXT), '.0', '')) = 11
        LIMIT 1
      )
      WHERE veli_id IS NULL
        AND tc_kimlik_no IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users u2
          WHERE u2.user_type = 'veli'
            AND REPLACE(CAST(u2.username AS TEXT), '.0', '') = REPLACE(CAST(ogrenci_kayitlari.tc_kimlik_no AS TEXT), '.0', '')
            AND LENGTH(REPLACE(CAST(u2.username AS TEXT), '.0', '')) = 11
        )
    `);

    const sayi = sonuc && sonuc.changes ? sonuc.changes : 0;
    if (sayi > 0) {
      console.log('Veli baglantisi migration: ' + sayi + ' yeni baglanti yapildi');
    } else {
      console.log('Veli baglantisi migration: Tum veliler zaten bagli');
    }
  } catch (err) {
    console.log('Veli baglantisi migration hatasi (devam ediliyor):', err.message);
  }
}

module.exports = { initDatabase };
