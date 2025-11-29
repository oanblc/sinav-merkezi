const sqlite3 = require('sqlite3').verbose();

// Veritabanı bağlantısı
const db = new sqlite3.Database('sinav_merkezi.db', (err) => {
  if (err) {
    console.error('Veritabanı bağlantı hatası:', err);
  } else {
    console.log('✅ Veritabanı bağlandı');
  }
});

// Sınav takvimi verilerini ekle
const sinavlar = [
  // 12. Sınıf/Mezun (Kasım 2025)
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-08 10:15:00',
    son_secim_tarihi: '2025-10-31 23:59:00',
    giris_belgesi_tarihi: '2025-11-06 10:00:00',
    durum: 'Tamamlandı',
    aciklama: 'Cevap Anahtarı',
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-09 10:15:00',
    son_secim_tarihi: '2025-10-31 23:59:00',
    giris_belgesi_tarihi: '2025-11-06 10:00:00',
    durum: 'Tamamlandı',
    aciklama: 'Cevap Anahtarı',
    sira: 2,
    aktif: 1
  },
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-15 10:15:00',
    son_secim_tarihi: '2025-11-06 23:59:00',
    giris_belgesi_tarihi: '2025-11-13 10:00:00',
    durum: 'Açık',
    aciklama: 'Cevap Anahtarı',
    sira: 3,
    aktif: 1
  },
  {
    sinav_adi: 'AYT Simülasyon Sınavı',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-16 10:15:00',
    son_secim_tarihi: '2025-11-06 23:59:00',
    giris_belgesi_tarihi: '2025-11-13 10:00:00',
    durum: 'Süreç devam ediyor',
    aciklama: null,
    sira: 4,
    aktif: 1
  },
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-22 10:15:00',
    son_secim_tarihi: '2025-11-13 23:59:00',
    giris_belgesi_tarihi: '2025-11-20 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 5,
    aktif: 1
  },
  {
    sinav_adi: 'AYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-23 10:15:00',
    son_secim_tarihi: '2025-11-13 23:59:00',
    giris_belgesi_tarihi: '2025-11-20 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 6,
    aktif: 1
  },
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-29 10:15:00',
    son_secim_tarihi: '2025-11-20 23:59:00',
    giris_belgesi_tarihi: '2025-11-27 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 7,
    aktif: 1
  },
  {
    sinav_adi: 'AYT Simülasyon Sınavı',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-11-30 10:15:00',
    son_secim_tarihi: '2025-11-20 23:59:00',
    giris_belgesi_tarihi: '2025-11-27 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 8,
    aktif: 1
  },
  // Aralık 2025
  {
    sinav_adi: 'TYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-12-06 10:15:00',
    son_secim_tarihi: '2025-11-27 23:59:00',
    giris_belgesi_tarihi: '2025-12-04 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 9,
    aktif: 1
  },
  {
    sinav_adi: 'AYT Simülasyon Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '12. Sınf./Mezun',
    sinav_tarihi: '2025-12-07 10:15:00',
    son_secim_tarihi: '2025-11-27 23:59:00',
    giris_belgesi_tarihi: '2025-12-04 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 10,
    aktif: 1
  },
  
  // 11. Sınıf
  {
    sinav_adi: 'TYT Hazırlık Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '11. Sınf.',
    sinav_tarihi: '2025-11-20 10:15:00',
    son_secim_tarihi: '2025-11-10 23:59:00',
    giris_belgesi_tarihi: '2025-11-18 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'Matematik Konu Tarama',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '11. Sınf.',
    sinav_tarihi: '2025-11-27 10:15:00',
    son_secim_tarihi: '2025-11-17 23:59:00',
    giris_belgesi_tarihi: '2025-11-25 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 2,
    aktif: 1
  },
  {
    sinav_adi: 'TYT Hazırlık Sınavı - 2',
    sinav_turu: 'TÖDER',
    sinif: '11. Sınf.',
    sinav_tarihi: '2025-12-04 10:15:00',
    son_secim_tarihi: '2025-11-24 23:59:00',
    giris_belgesi_tarihi: '2025-12-02 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 3,
    aktif: 1
  },
  
  // 10. Sınıf
  {
    sinav_adi: 'Temel Matematik Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '10. Sınf.',
    sinav_tarihi: '2025-11-18 10:15:00',
    son_secim_tarihi: '2025-11-08 23:59:00',
    giris_belgesi_tarihi: '2025-11-16 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'Fen Bilimleri Sınavı',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '10. Sınf.',
    sinav_tarihi: '2025-11-25 10:15:00',
    son_secim_tarihi: '2025-11-15 23:59:00',
    giris_belgesi_tarihi: '2025-11-23 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 2,
    aktif: 1
  },
  
  // 9. Sınıf
  {
    sinav_adi: 'Genel Yetenek Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '9. Sınf.',
    sinav_tarihi: '2025-11-19 10:15:00',
    son_secim_tarihi: '2025-11-09 23:59:00',
    giris_belgesi_tarihi: '2025-11-17 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'Matematik Temel Sınav',
    sinav_turu: 'KRALLAR KARMASI',
    sinif: '9. Sınf.',
    sinav_tarihi: '2025-11-26 10:15:00',
    son_secim_tarihi: '2025-11-16 23:59:00',
    giris_belgesi_tarihi: '2025-11-24 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 2,
    aktif: 1
  },
  
  // 8. Sınıf (LGS Hazırlık)
  {
    sinav_adi: 'LGS Deneme Sınavı - 1',
    sinav_turu: 'LGS',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-11-23 10:00:00',
    son_secim_tarihi: '2025-11-13 23:59:00',
    giris_belgesi_tarihi: '2025-11-21 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  {
    sinav_adi: 'LGS Deneme Sınavı - 2',
    sinav_turu: 'LGS',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-11-30 10:00:00',
    son_secim_tarihi: '2025-11-20 23:59:00',
    giris_belgesi_tarihi: '2025-11-28 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 2,
    aktif: 1
  },
  {
    sinav_adi: 'LGS Deneme Sınavı - 3',
    sinav_turu: 'LGS',
    sinif: '8. Sınf.',
    sinav_tarihi: '2025-12-07 10:00:00',
    son_secim_tarihi: '2025-11-27 23:59:00',
    giris_belgesi_tarihi: '2025-12-05 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 3,
    aktif: 1
  },
  // 7. Sınıf
  {
    sinav_adi: 'Genel Yetenek Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '7. Sınf.',
    sinav_tarihi: '2025-11-21 10:00:00',
    son_secim_tarihi: '2025-11-11 23:59:00',
    giris_belgesi_tarihi: '2025-11-19 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  // 6. Sınıf
  {
    sinav_adi: 'Temel Beceri Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '6. Sınf.',
    sinav_tarihi: '2025-11-22 10:00:00',
    son_secim_tarihi: '2025-11-12 23:59:00',
    giris_belgesi_tarihi: '2025-11-20 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  // 5. Sınıf
  {
    sinav_adi: 'Matematik ve Türkçe',
    sinav_turu: 'TÖDER',
    sinif: '5. Sınf.',
    sinav_tarihi: '2025-11-23 09:30:00',
    son_secim_tarihi: '2025-11-13 23:59:00',
    giris_belgesi_tarihi: '2025-11-21 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  // 4. Sınıf
  {
    sinav_adi: 'Temel Yetenek Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '4. Sınf.',
    sinav_tarihi: '2025-11-24 09:30:00',
    son_secim_tarihi: '2025-11-14 23:59:00',
    giris_belgesi_tarihi: '2025-11-22 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  },
  // 3. Sınıf
  {
    sinav_adi: 'Okuma Yazma Sınavı',
    sinav_turu: 'TÖDER',
    sinif: '3. Sınf.',
    sinav_tarihi: '2025-11-25 09:30:00',
    son_secim_tarihi: '2025-11-15 23:59:00',
    giris_belgesi_tarihi: '2025-11-23 10:00:00',
    durum: 'Açık',
    aciklama: null,
    sira: 1,
    aktif: 1
  }
];

console.log('Sınav takvimi verileri ekleniyor...');

const stmt = db.prepare(`
  INSERT INTO sinav_takvimi (
    sinav_adi, sinav_turu, sinif, sinav_tarihi, 
    son_secim_tarihi, giris_belgesi_tarihi, durum, 
    aciklama, sira, aktif
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let eklenenSayisi = 0;

sinavlar.forEach((sinav) => {
  stmt.run(
    sinav.sinav_adi,
    sinav.sinav_turu,
    sinav.sinif,
    sinav.sinav_tarihi,
    sinav.son_secim_tarihi,
    sinav.giris_belgesi_tarihi,
    sinav.durum,
    sinav.aciklama,
    sinav.sira,
    sinav.aktif,
    (err) => {
      if (err) {
        console.error('❌ Hata:', err.message);
      } else {
        eklenenSayisi++;
        if (eklenenSayisi === sinavlar.length) {
          console.log(`✅ ${eklenenSayisi} sınav takvimi verisi başarıyla eklendi!`);
          db.close();
        }
      }
    }
  );
});

stmt.finalize();

