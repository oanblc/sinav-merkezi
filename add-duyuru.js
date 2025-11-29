// Duyuru ekleyen script
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('sinav_merkezi.db');

const duyurular = [
  {
    baslik: '2025-2026 Eğitim Öğretim Yılı Paketlerimiz Hazır!',
    icerik: 'Yeni eğitim-öğretim yılı için tüm sınav paketlerimiz hazırlandı. LGS, YKS, Lise, Ortaokul ve İlkokul grupları için özel hazırlanmış deneme sınavları ile başarıya ulaşın. Hemen kaydolun ve erken kayıt fırsatlarından yararlanın!',
    tarih: '2024-11-15',
    aktif: 1,
    sira: 1
  },
  {
    baslik: 'Gerçek Sınav Ortamında Deneme Sınavları',
    icerik: 'MEB ve ÖSYM standartlarında, gerçek sınav koşullarıyla birebir aynı ortamda sınavlarımız devam ediyor. Giriş belgesinden güvenliğe, gözetmenden optik forma kadar her detay gerçek sınav gibi!',
    tarih: '2024-11-10',
    aktif: 1,
    sira: 2
  },
  {
    baslik: 'Detaylı Analiz ve Karne Sistemi',
    icerik: 'Her sınav sonrası detaylı karneler, net analizleri ve branş bazlı performans raporlarıyla eksiklerinizi görün ve başarınızı artırın. Öğrencilerimiz için özel hazırlanmış analiz sistemimiz ile güçlü ve zayıf yönlerinizi keşfedin.',
    tarih: '2024-11-05',
    aktif: 1,
    sira: 3
  }
];

db.serialize(() => {
  console.log('Duyurular ekleniyor...');
  
  const stmt = db.prepare(`
    INSERT INTO duyurular (baslik, icerik, tarih, aktif, sira)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  duyurular.forEach(duyuru => {
    stmt.run(
      duyuru.baslik,
      duyuru.icerik,
      duyuru.tarih,
      duyuru.aktif,
      duyuru.sira
    );
  });
  
  stmt.finalize();
  
  console.log(`✅ ${duyurular.length} duyuru başarıyla eklendi!`);
  
  db.close((err) => {
    if (err) {
      console.error('Veritabanı kapatma hatası:', err);
    } else {
      console.log('✅ Veritabanı bağlantısı kapatıldı');
    }
  });
});

