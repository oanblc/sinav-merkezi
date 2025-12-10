// Mevcut ogrenci_kayitlari kayitlarina veli_id bagla
// TC eslesmesi uzerinden velileri bagla

require('dotenv').config();
const { initConnection, dbGet, dbAll, dbRun } = require('./db');

// Veritabani baglantisi
initConnection();

async function migrate() {
  console.log('===========================================');
  console.log('VELI BAGLANTISI MIGRATION BASLADI');
  console.log('===========================================\n');

  try {
    // 1. ogrenci_kayitlari tablosuna veli_id kolonu ekle (yoksa)
    try {
      await dbRun('ALTER TABLE ogrenci_kayitlari ADD COLUMN veli_id INTEGER');
      console.log('veli_id kolonu eklendi');
    } catch (e) {
      console.log('veli_id kolonu zaten var veya hata:', e.message);
    }

    // 2. Tum velileri al
    const veliler = await dbAll("SELECT id, username FROM users WHERE user_type = 'veli'");
    console.log('\nToplam ' + veliler.length + ' veli bulundu\n');

    let baglantiSayisi = 0;
    let eslesmeyenSayisi = 0;

    // 3. Her veli icin TC eslesmesi yap
    for (const veli of veliler) {
      // TC temizle (.0 kaldir)
      let tc = veli.username ? veli.username.toString().replace('.0', '').trim() : null;

      if (!tc || tc.length !== 11) {
        continue;
      }

      // ogrenci_kayitlari'nda TC eslesmesi ara
      const ogrenci = await dbGet(`
        SELECT id, ogrenci_adi_soyadi, veli_id
        FROM ogrenci_kayitlari
        WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = ?
      `, [tc]);

      if (ogrenci) {
        if (!ogrenci.veli_id) {
          // veli_id bagla
          await dbRun('UPDATE ogrenci_kayitlari SET veli_id = ? WHERE id = ?', [veli.id, ogrenci.id]);
          baglantiSayisi++;
          console.log('  Baglandi: ' + ogrenci.ogrenci_adi_soyadi + ' -> Veli ID: ' + veli.id);
        } else {
          console.log('  Zaten bagli: ' + ogrenci.ogrenci_adi_soyadi);
        }
      } else {
        eslesmeyenSayisi++;
      }
    }

    console.log('\n===========================================');
    console.log('MIGRATION TAMAMLANDI');
    console.log('===========================================');
    console.log('Yeni baglanti: ' + baglantiSayisi);
    console.log('Eslesmeyen: ' + eslesmeyenSayisi);

    // 4. Istatistikleri goster
    const kurumKayit = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    const veliKayit = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler');
    const bagliKayit = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari WHERE veli_id IS NOT NULL');

    console.log('\n--- TABLO ISTATISTIKLERI ---');
    console.log('ogrenci_kayitlari: ' + kurumKayit.sayi);
    console.log('ogrenciler (eski): ' + veliKayit.sayi);
    console.log('Veli bagli kayit: ' + bagliKayit.sayi);

  } catch (error) {
    console.error('HATA:', error);
  }

  process.exit(0);
}

migrate();
