const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('sinav_merkezi.db', (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err);
  } else {
    console.log('✅ Veritabanı bağlandı');
  }
});

console.log('Cevap anahtarları verileri ekleniyor...');

// Önce tabloyu temizle
db.run('DELETE FROM cevap_anahtarlari', (err) => {
  if (err) {
    console.error('Temizleme hatası:', err);
  }
});

const cevapAnahtarlari = [
  // 12. Sınıf / Mezun
  {
    sinav_adi: 'KRALLAR KARMASI - TYT',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-15 10:15:00',
    durum: 'Uygulama aşaması tamamlandı',
    cevap_anahtari_url: '/login',
    sonuc_url: null,
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'KRALLAR KARMASI - LGS',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-11-09 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 2,
    aktif: 1
  },
  {
    sinav_adi: '365 GÜN - Lise 10',
    sinav_turu: '365 GÜN',
    sinif: '10. Sınf.',
    sinav_tarihi: '2025-11-09 10:15:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 3,
    aktif: 1
  },
  {
    sinav_adi: '365 GÜN - Lise 11',
    sinav_turu: '365 GÜN',
    sinif: '11. Sınf.',
    sinav_tarihi: '2025-11-09 10:15:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 4,
    aktif: 1
  },
  {
    sinav_adi: '365 GÜN - Lise 9',
    sinav_turu: '365 GÜN',
    sinif: '9. Sınf.',
    sinav_tarihi: '2025-11-09 10:15:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 5,
    aktif: 1
  },
  {
    sinav_adi: 'OKYANUS (Classmate) - Ortaokul 5',
    sinav_turu: 'OKYANUS',
    sinif: '5. Sınf.',
    sinav_tarihi: '2025-11-09 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 6,
    aktif: 1
  },
  // Daha eski sınavlar
  {
    sinav_adi: 'TYT Deneme Sınavı - 1',
    sinav_turu: 'TYT',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-01 10:00:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 7,
    aktif: 1
  },
  {
    sinav_adi: 'AYT Deneme Sınavı - 1',
    sinav_turu: 'AYT',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-10-25 10:00:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 8,
    aktif: 1
  },
  {
    sinav_adi: 'LGS Deneme Sınavı - 1',
    sinav_turu: 'LGS',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-10-20 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 9,
    aktif: 1
  },
  {
    sinav_adi: 'LGS Deneme Sınavı - 2',
    sinav_turu: 'LGS',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-10-15 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 10,
    aktif: 1
  },
  {
    sinav_adi: 'Lise 11 - Matematik Deneme',
    sinav_turu: 'Deneme',
    sinif: '11. Sınf.',
    sinav_tarihi: '2025-10-10 10:15:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 11,
    aktif: 1
  },
  {
    sinav_adi: 'Lise 10 - Fen Bilimleri Deneme',
    sinav_turu: 'Deneme',
    sinif: '10. Sınf.',
    sinav_tarihi: '2025-10-05 10:15:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 12,
    aktif: 1
  },
  {
    sinav_adi: 'Lise 9 - Genel Deneme',
    sinav_turu: 'Deneme',
    sinif: '9. Sınf.',
    sinav_tarihi: '2025-10-01 10:00:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 13,
    aktif: 1
  },
  {
    sinav_adi: 'Ortaokul 7 - Deneme Sınavı',
    sinav_turu: 'Deneme',
    sinif: '7. Sınf.',
    sinav_tarihi: '2025-09-28 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 14,
    aktif: 1
  },
  {
    sinav_adi: 'Ortaokul 6 - Deneme Sınavı',
    sinav_turu: 'Deneme',
    sinif: '6. Sınf.',
    sinav_tarihi: '2025-09-25 09:30:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 15,
    aktif: 1
  },
  {
    sinav_adi: 'İlkokul 5 - Deneme Sınavı',
    sinav_turu: 'Deneme',
    sinif: '5. Sınf.',
    sinav_tarihi: '2025-09-20 09:00:00',
    durum: 'Sonuç açıklandı',
    cevap_anahtari_url: '/login',
    sonuc_url: '/login',
    sira: 16,
    aktif: 1
  }
];

const stmt = db.prepare(`
  INSERT INTO cevap_anahtarlari 
  (sinav_adi, sinav_turu, sinif, sinav_tarihi, durum, cevap_anahtari_url, sonuc_url, sira, aktif)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

cevapAnahtarlari.forEach((item) => {
  stmt.run(
    item.sinav_adi,
    item.sinav_turu,
    item.sinif,
    item.sinav_tarihi,
    item.durum,
    item.cevap_anahtari_url,
    item.sonuc_url,
    item.sira,
    item.aktif
  );
});

stmt.finalize((err) => {
  if (err) {
    console.error('❌ Veri ekleme hatası:', err);
  } else {
    console.log(`✅ ${cevapAnahtarlari.length} adet cevap anahtarı verisi eklendi!`);
  }
  
  db.close((err) => {
    if (err) {
      console.error('Veritabanı kapatma hatası:', err);
    } else {
      console.log('✅ Veritabanı bağlantısı kapatıldı');
    }
  });
});

