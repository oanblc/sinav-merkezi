// Örnek sınav paketlerini veritabanına ekleyen script
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('sinav_merkezi.db');

// Önce tabloyu oluştur
db.serialize(() => {
  console.log('Tablo oluşturuluyor...');
  db.run(`
    CREATE TABLE IF NOT EXISTS satin_alinabilir_sinavlar (
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
    )
  `);
  console.log('✅ Tablo hazır');
});

const sinavPaketleri = [
  // YKS Paketleri
  {
    baslik: '2025-2026 YKS - TYT & AYT Tam Paket',
    aciklama: 'Mezun ve 12. Sınıflar için en kapsamlı sınav paketi. Tüm yıl boyunca gerçek sınav ortamında deneme sınavları.',
    kategori: 'YKS',
    sinav_sayisi: 60,
    tyt_sayisi: 40,
    ayt_sayisi: 20,
    fiyat: 16200,
    ozellikler: JSON.stringify([
      '60 Simülasyon Sınav',
      '40 TYT Simülasyon Sınav',
      '20 AYT Simülasyon Sınav',
      'Detaylı Analizler',
      'Net Analizi',
      'Soru Bazlı Çözümler'
    ]),
    aktif: 1,
    sira: 1
  },
  {
    baslik: '2025-2026 YKS - TYT & AYT Yarım Paket',
    aciklama: 'Mezun ve 12. Sınıflar için orta düzey paket.',
    kategori: 'YKS',
    sinav_sayisi: 30,
    tyt_sayisi: 20,
    ayt_sayisi: 10,
    fiyat: 8600,
    ozellikler: JSON.stringify([
      '30 Simülasyon Sınav',
      '20 TYT Simülasyon Sınav',
      '10 AYT Simülasyon Sınav',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 2
  },
  {
    baslik: 'YKS Tek Sınav',
    aciklama: 'İstediğiniz tek sınavı seçin.',
    kategori: 'YKS',
    sinav_sayisi: 1,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 380,
    ozellikler: JSON.stringify([
      '1 Simülasyon Sınav',
      'Ayrıntılı Karne'
    ]),
    aktif: 1,
    sira: 3
  },
  
  // LGS Paketleri
  {
    baslik: '2025-2026 LGS Tam Paket',
    aciklama: '8. Sınıflar için tam kapsamlı LGS hazırlık paketi.',
    kategori: 'LGS',
    sinav_sayisi: 40,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 12240,
    ozellikler: JSON.stringify([
      '40 Simülasyon Sınav',
      'Tamamı simülasyon LGS formatında',
      'Detaylı Analizler',
      'Ders Bazlı Net Analizi'
    ]),
    aktif: 1,
    sira: 1
  },
  {
    baslik: '2025-2026 LGS Yarım Paket',
    aciklama: '8. Sınıflar için orta düzey LGS paketi.',
    kategori: 'LGS',
    sinav_sayisi: 20,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 6552,
    ozellikler: JSON.stringify([
      '20 Simülasyon Sınav',
      'Tamamı simülasyon LGS formatında',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 2
  },
  {
    baslik: 'LGS 10 Sınavlık Paket',
    aciklama: 'İstediğiniz 10 sınavı seçin.',
    kategori: 'LGS',
    sinav_sayisi: 10,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 3420,
    ozellikler: JSON.stringify([
      '10 Simülasyon Sınav',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 3
  },
  {
    baslik: 'LGS Tek Sınav',
    aciklama: 'İstediğiniz tek sınavı seçin.',
    kategori: 'LGS',
    sinav_sayisi: 1,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 380,
    ozellikler: JSON.stringify([
      '1 Simülasyon Sınav',
      'Ayrıntılı Karne'
    ]),
    aktif: 1,
    sira: 4
  },
  
  // Lise Paketleri (9-10-11)
  {
    baslik: '2025-2026 Lise Tam Paket',
    aciklama: '9-10-11. Sınıflar için kapsamlı paket.',
    kategori: 'Lise',
    sinav_sayisi: 20,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 6552,
    ozellikler: JSON.stringify([
      '20 Simülasyon Sınav',
      'Tamamı simülasyon sınavlar',
      'Detaylı Analizler',
      '11. Sınıflar TYT & AYT de seçebilir'
    ]),
    aktif: 1,
    sira: 1
  },
  {
    baslik: '2025-2026 Lise Yarım Paket',
    aciklama: '9-10-11. Sınıflar için orta düzey paket.',
    kategori: 'Lise',
    sinav_sayisi: 10,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 3420,
    ozellikler: JSON.stringify([
      '10 Simülasyon Sınav',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 2
  },
  
  // Ortaokul Paketleri (5-6-7)
  {
    baslik: '2025-2026 Ortaokul Tam Paket',
    aciklama: '5-6-7. Sınıflar için kapsamlı paket.',
    kategori: 'Ortaokul',
    sinav_sayisi: 32,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 10150,
    ozellikler: JSON.stringify([
      '32 Simülasyon Sınav',
      'LGS formatında sınavlar',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 1
  },
  {
    baslik: '2025-2026 Ortaokul Yarım Paket',
    aciklama: '5-6-7. Sınıflar için orta düzey paket.',
    kategori: 'Ortaokul',
    sinav_sayisi: 20,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 6552,
    ozellikler: JSON.stringify([
      '20 Simülasyon Sınav',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 2
  },
  
  // İlkokul Paketleri (3-4)
  {
    baslik: '2025-2026 İlkokul Paketi',
    aciklama: '3-4. Sınıflar için özel paket.',
    kategori: 'İlkokul',
    sinav_sayisi: 10,
    tyt_sayisi: 0,
    ayt_sayisi: 0,
    fiyat: 3420,
    ozellikler: JSON.stringify([
      '10 Simülasyon Sınav',
      'Temel beceriler',
      'Detaylı Analizler'
    ]),
    aktif: 1,
    sira: 1
  }
];

// Verileri ekle
setTimeout(() => {
  db.serialize(() => {
    console.log('Sınav paketleri ekleniyor...');
    
    const stmt = db.prepare(`
    INSERT INTO satin_alinabilir_sinavlar 
    (baslik, aciklama, kategori, sinav_sayisi, tyt_sayisi, ayt_sayisi, fiyat, ozellikler, aktif, sira)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  sinavPaketleri.forEach(paket => {
    stmt.run(
      paket.baslik,
      paket.aciklama,
      paket.kategori,
      paket.sinav_sayisi,
      paket.tyt_sayisi,
      paket.ayt_sayisi,
      paket.fiyat,
      paket.ozellikler,
      paket.aktif,
      paket.sira
    );
  });
  
    stmt.finalize();
    
    console.log(`✅ ${sinavPaketleri.length} sınav paketi başarıyla eklendi!`);
    
    db.close((err) => {
      if (err) {
        console.error('Veritabanı kapatma hatası:', err);
      } else {
        console.log('✅ Veritabanı bağlantısı kapatıldı');
      }
    });
  });
}, 500);

