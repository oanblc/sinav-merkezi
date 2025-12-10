const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const csv = require('csv-parser');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sinav_merkezi.db');
// Secret password reset endpoint removed for security

// Kurum Dashboard
app.get('/kurum/dashboard', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    // ÃÂ°statistikler
    const sinavSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar');
    const sinavAktif = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 0 AND katilimci_sayisi > 0');
    const sinavTamamlandi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE sonuc_yuklendi = 1');
    const sinavTaslak = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar WHERE katilimci_sayisi = 0');
    const toplamKatilimci = await dbGet('SELECT SUM(katilimci_sayisi) as toplam FROM sinavlar');
    const takvimSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinavlar'); // DÃÂ¼zeltildi: sinav_takvimi Ã¢ÂÂ sinavlar
    const veliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM users WHERE user_type = "veli"');
    
    // TÃÂ¼m ÃÂ¶ÃÂrenci sayÃÂ±sÃÂ± (kurum + veli kay�tlarÃÂ±)
    const ogrenciKurumSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    const ogrenciVeliSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenciler');
    const ogrenciSayisi = { sayi: (ogrenciKurumSayisi.sayi || 0) + (ogrenciVeliSayisi.sayi || 0) };
    const ogrenciKayitSayisi = ogrenciKurumSayisi; // Kurum kay�tlarÃÂ± iÃÂ§in ayrÃÂ±
    
    const talepBeklemede = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "beklemede"');
    const talepOnaylandi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "onaylandi"');
    const talepReddedildi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri WHERE durum = "reddedildi"');
    const talepToplam = await dbGet('SELECT COUNT(*) as sayi FROM sinav_talepleri');
    
    // Paket ÃÂ°statistikleri
    const paketSayisi = await dbGet('SELECT COUNT(*) as sayi FROM sinav_paketleri WHERE aktif = 1');
    const paketToplamOgrenci = await dbGet('SELECT COUNT(DISTINCT ogrenci_id) as sayi FROM paket_atamalari WHERE durum = "aktif"');
    
    res.render('kurum_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
      istatistikler: {
        sinav: sinavSayisi.sayi,
        sinavAktif: sinavAktif.sayi,
        sinavTamamlandi: sinavTamamlandi.sayi,
        sinavTaslak: sinavTaslak.sayi,
        toplamKatilimci: toplamKatilimci.toplam || 0,
        takvim: takvimSayisi.sayi,
        veli: veliSayisi.sayi,
        ogrenci: ogrenciSayisi.sayi,
        ogrenciKayit: ogrenciKayitSayisi.sayi,
        talepBeklemede: talepBeklemede.sayi,
        talepOnaylandi: talepOnaylandi.sayi,
        talepReddedildi: talepReddedildi.sayi,
        talepToplam: talepToplam.sayi,
        paket: paketSayisi.sayi,
        paketOgrenci: paketToplamOgrenci.sayi
      }
    });
  } catch (error) {
    console.error('Kurum dashboard hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// PayTR Entegrasyon SayfasÃÂ± - KALDIRILDI (Gerek yok)

// Kurum - WhatsApp Ayarlar� (GET)
app.get('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    let ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE id = 1');
    
    if (!ayarlar) {
      ayarlar = {
        api_url: '',
        api_token: '',
        phone_number: '',
        aktif: 0
      };
    }
    
    res.render('kurum/whatsapp-ayarlari', {
      user: { username: req.session.username, type: req.session.userType },
      ayarlar: ayarlar,
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('WhatsApp ayarlar� hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - WhatsApp Ayarlar� (POST)
app.post('/kurum/whatsapp-ayarlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    const { api_url, api_token, phone_number, aktif } = req.body;
    
    const mevcutAyar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE id = 1');
    
    if (mevcutAyar) {
      await dbRun(
        `UPDATE whatsapp_ayarlari 
         SET api_url = ?, api_token = ?, phone_number = ?, aktif = ?, updated_at = datetime('now')
         WHERE id = 1`,
        [api_url || '', api_token || '', phone_number || '', aktif ? 1 : 0]
      );
    } else {
      await dbRun(
        `INSERT INTO whatsapp_ayarlari (api_url, api_token, phone_number, aktif) 
         VALUES (?, ?, ?, ?)`,
        [api_url || '', api_token || '', phone_number || '', aktif ? 1 : 0]
      );
    }
    
    req.session.success = 'WhatsApp ayarlar� ba�ar�yla kaydedildi!';
    res.redirect('/kurum/whatsapp-ayarlari');
  } catch (error) {
    console.error('WhatsApp ayarlar� kaydetme hatasÃÂ±:', error);
    req.session.error = 'Ayarlar kaydedilirken bir hata olu�tu!';
    res.redirect('/kurum/whatsapp-ayarlari');
  }
});

// Kurum - WhatsApp Test Bildirimi
// Test iÃÂ§in manuel endpoint (GEÃÂÃÂ°CÃÂ° - ÃÂ¼retimde kaldÃÂ±rÃÂ±lmalÃÂ±)
app.post('/test-whatsapp-mesaj', async (req, res) => {
  try {
    const { telefon, mesaj } = req.body;
    
    if (!telefon || !mesaj) {
      return res.json({ success: false, message: 'Telefon ve mesaj gerekli!' });
    }
    
    console.log('\nÃ°ÂÂ§Âª Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ');
    console.log('Ã°ÂÂ§Âª MANUEL TEST MESAJI GÃÂNDERÃÂ°LÃÂ°YOR');
    console.log('Ã°ÂÂ§Âª Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ');
    console.log(`Ã°ÂÂÂ Telefon: ${telefon}`);
    console.log(`Ã°ÂÂÂ Mesaj: ${mesaj}`);
    console.log('Ã°ÂÂ§Âª Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ\n');
    
    const result = await whatsappBildirimGonder(telefon, mesaj, 'test_manuel');
    
    res.json(result);
  } catch (error) {
    console.error('Ã¢ÂÂ Test mesajÃÂ± hatasÃÂ±:', error);
    res.json({ success: false, message: error.message });
  }
});

app.post('/kurum/whatsapp-test', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const ayarlar = await dbGet('SELECT * FROM whatsapp_ayarlari WHERE aktif = 1');
    
    if (!ayarlar || !ayarlar.phone_number) {
      return res.json({ 
        success: false, 
        message: 'WhatsApp ayarlar� yapÃÂ±lmamÃÂ±ÃÂ veya telefon numarasÃÂ± eksik!' 
      });
    }
    
    const testMesaj = `Ã°ÂÂ§Âª TEST BÃÂ°LDÃÂ°RÃÂ°MÃÂ°

Bu bir test mesajÃÂ±dÃÂ±r.

Ã¢ÂÂ WhatsApp API entegrasyonunuz ba�ar�yla ÃÂ§alÃÂ±ÃÂÃÂ±yor!

Ã°ÂÂÂ Test ZamanÃÂ±: ${new Date().toLocaleString('tr-TR')}`;
    
    const result = await whatsappBildirimGonder(ayarlar.phone_number, testMesaj, 'test');
    
    if (result.success) {
      return res.json({ 
        success: true, 
        message: 'Test mesajÃÂ± ba�ar�yla gÃÂ¶nderildi! Console loglarÃÂ± kontrol edin.' 
      });
    } else {
      return res.json({ 
        success: false, 
        message: 'Test mesajÃÂ± gÃÂ¶nderilemedi: ' + result.message 
      });
    }
  } catch (error) {
    console.error('Test bildirimi hatasÃÂ±:', error);
    res.json({ success: false, message: 'Test s�ras�nda bir hata olu�tu: ' + error.message });
  }
});

// Kurum - Talep YÃÂ¶netimi
app.get('/kurum/talepler', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    // S�nav Talepleri (Veli -> Kurum)
    const sinavTalepleri = await dbAll(`
      SELECT 
        st.*,
        s.ad as sinav_adi,
        s.fiyat,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        u.username as veli_username,
        u.email as veli_email,
        u.telefon as veli_telefon,
        u.ad_soyad as veli_ad_soyad,
        'sinav' as talep_tipi
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      INNER JOIN users u ON st.veli_id = u.id
    `);
    
    // Rehber ÃÂÃÂretmen Talepleri (Hem kurum hem veli ÃÂ¶ÃÂrencileri)
    const rehberTalepleri = await dbAll(`
      SELECT 
        ot.*,
        ot.ad_soyad as sinav_adi,
        0 as fiyat,
        NULL as sinav_tarihi,
        ot.sinif,
        NULL as ders,
        v.username as veli_username,
        v.email as veli_email,
        v.telefon as veli_telefon,
        v.ad_soyad as veli_ad_soyad,
        r.ad_soyad as rehber_ad_soyad,
        r.brans as rehber_brans,
        'rehber' as talep_tipi
      FROM ogrenci_talepleri ot
      INNER JOIN users v ON ot.veli_id = v.id
      LEFT JOIN users r ON ot.rehber_ogretmen_id = r.id
      WHERE ot.durum IN ('beklemede', 'onaylandi', 'reddedildi')
    `);
    
    // ÃÂ°ki listeyi birleÃÂtir
    const talepler = [...sinavTalepleri, ...rehberTalepleri].sort((a, b) => {
      // ÃÂnce duruma gÃÂ¶re sÃÂ±rala
      const durumOrder = { 'beklemede': 1, 'onaylandi': 2, 'reddedildi': 3 };
      const durumDiff = durumOrder[a.durum] - durumOrder[b.durum];
      if (durumDiff !== 0) return durumDiff;
      
      // Sonra tarihe gÃÂ¶re sÃÂ±rala (en yeni en ÃÂ¼stte)
      return new Date(b.talep_tarihi || b.created_at) - new Date(a.talep_tarihi || a.created_at);
    });
    
    res.render('kurum/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talep listesi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - Talep YÃÂ¶netimi (Alias - /kurum/talepler ile aynÃÂ±)
app.get('/kurum/talep-yonetimi', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const talepler = await dbAll(`
      SELECT 
        st.*,
        s.ad as sinav_adi,
        s.fiyat,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        u.username as veli_username,
        u.email as veli_email,
        u.telefon as veli_telefon,
        u.ad_soyad as veli_ad_soyad
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      INNER JOIN users u ON st.veli_id = u.id
      ORDER BY 
        CASE st.durum
          WHEN 'beklemede' THEN 1
          WHEN 'onaylandi' THEN 2
          WHEN 'reddedildi' THEN 3
        END,
        st.talep_tarihi DESC
    `);
    
    res.render('kurum/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talep listesi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - Talep YanÃÂ±tla (Onayla/Reddet)
app.post('/kurum/talep-yanitla', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { talep_id, durum, yanit, talep_tipi } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'GeÃÂ§ersiz parametreler!' });
    }
    
    // Talep tipine gÃÂ¶re farklÃÂ± tablolardan gÃÂ¼ncelle
    if (talep_tipi === 'rehber') {
      // Rehber ÃÂ¶ÃÂretmen talebi
      await dbRun(
        `UPDATE ogrenci_talepleri 
         SET durum = ?, mesaj = ?
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al
      const talep = await dbGet(`
        SELECT 
          ot.*,
          ot.ad_soyad as ogrenci_adi,
          v.ad_soyad as veli_ad_soyad,
          v.telefon as veli_telefon,
          r.ad_soyad as rehber_ad_soyad
        FROM ogrenci_talepleri ot
        INNER JOIN users v ON ot.veli_id = v.id
        LEFT JOIN users r ON ot.rehber_ogretmen_id = r.id
        WHERE ot.id = ?
      `, [talep_id]);
      
      // WhatsApp bildirimi gÃÂ¶nder
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `Ã¢ÂÂ REHBER ÃÂÃÂRETMEN TALEBÃÂ°NÃÂ°Z ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
            `Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ« ��renci: ${talep.ogrenci_adi}\n` +
            `Ã°ÂÂÂ Rehber: ${talep.rehber_ad_soyad || 'Rehber ÃÂÃÂretmen'}\n` +
            `Ã¢ÂÂ Durum: OnaylandÃÂ±\n\n` +
            (yanit ? `Ã°ÂÂÂ¬ Kurum YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
            `Rehber ÃÂ¶ÃÂretmen yetkisi aktif hale getirilmiÃÂtir.`
          : `Ã¢ÂÂ REHBER ÃÂÃÂRETMEN TALEBÃÂ°NÃÂ°Z REDDEDÃÂ°LDÃÂ°\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
            `Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ« ��renci: ${talep.ogrenci_adi}\n` +
            `Ã¢ÂÂ Durum: Reddedildi\n\n` +
            (yanit ? `Ã°ÂÂÂ¬ Kurum YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
            `Daha fazla bilgi iÃÂ§in lÃÂ¼tfen bizimle iletiÃÂime geÃÂ§iniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
          .then(result => console.log('Ã¢ÂÂ WhatsApp bildirimi gÃÂ¶nderildi:', result))
          .catch(error => console.error('Ã¢ÂÂ WhatsApp bildirimi hatasÃÂ±:', error));
      }
      
    } else {
      // S�nav talebi (eski kod)
      await dbRun(
        `UPDATE sinav_talepleri 
         SET durum = ?, yanit = ?, yanitlanma_tarihi = datetime('now')
         WHERE id = ?`,
        [durum, yanit || '', talep_id]
      );
      
      // Talep bilgilerini al (WhatsApp bildirimi iÃÂ§in)
      const talep = await dbGet(`
        SELECT 
          st.*,
          s.ad as sinav_adi,
          u.ad_soyad as veli_ad_soyad,
          u.telefon as veli_telefon
        FROM sinav_talepleri st
        INNER JOIN sinavlar s ON st.sinav_id = s.id
        INNER JOIN users u ON st.veli_id = u.id
        WHERE st.id = ?
      `, [talep_id]);
      
      // WhatsApp bildirimi gÃÂ¶nder (arka planda)
      if (talep && talep.veli_telefon) {
        const mesaj = durum === 'onaylandi' 
          ? `Ã¢ÂÂ TALEBÃÂ°NÃÂ°Z ONAYLANDI!\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
            `Ã°ÂÂÂ S�nav: ${talep.sinav_adi}\n` +
            `Ã¢ÂÂ Durum: OnaylandÃÂ±\n\n` +
            (yanit ? `Ã°ÂÂÂ¬ Kurum YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
            `S�nav eri�iminiz aktif hale getirilmiÃÂtir. ÃÂ°yi s�navlar dileriz! Ã°ÂÂÂ`
          : `Ã¢ÂÂ TALEBÃÂ°NÃÂ°Z REDDEDÃÂ°LDÃÂ°\n\n` +
            `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
            `Ã°ÂÂÂ S�nav: ${talep.sinav_adi}\n` +
            `Ã¢ÂÂ Durum: Reddedildi\n\n` +
            (yanit ? `Ã°ÂÂÂ¬ Kurum YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
            `Daha fazla bilgi iÃÂ§in lÃÂ¼tfen bizimle iletiÃÂime geÃÂ§iniz.`;
        
        whatsappBildirimGonder(talep.veli_telefon, mesaj, `talep_${durum}`)
          .then(result => console.log('Ã¢ÂÂ WhatsApp bildirimi gÃÂ¶nderildi:', result))
          .catch(error => console.error('Ã¢ÂÂ WhatsApp bildirimi hatasÃÂ±:', error));
      }
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep ba�ar�yla onaylandÃÂ±!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Talep yanÃÂ±tlama hatasÃÂ±:', error);
    res.json({ success: false, message: 'Talep iÃÂlenirken bir hata olu�tu!' });
  }
});

// Kurum - Veli Listesi API (Rehber Talep iÃÂ§in)
app.get('/kurum/veliler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('Ã°ÂÂÂ¡ Veli listesi API ÃÂ§aÃÂrÃÂ±ldÃÂ±');
    const veliler = await dbAll(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE user_type = 'veli'
      ORDER BY ad_soyad ASC, username ASC
    `);
    
    console.log(`Ã¢ÂÂ ${veliler.length} veli bulundu`);
    res.json(veliler);
  } catch (error) {
    console.error('Ã¢ÂÂ Veli listesi hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - Rehber ÃÂÃÂretmen Listesi API
app.get('/kurum/rehberler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const rehberler = await dbAll(`
      SELECT 
        id,
        username,
        ad_soyad,
        brans,
        email,
        telefon
      FROM users
      WHERE user_type = 'rehber_ogretmen'
      ORDER BY ad_soyad ASC, username ASC
    `);
    
    res.json(rehberler);
  } catch (error) {
    console.error('Rehber listesi hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - TÃÂ¼m ��renciler API (Kurum + Veli ÃÂ¶ÃÂrencileri)
app.get('/kurum/tum-ogrenciler-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('Ã°ÂÂÂ¡ TÃÂ¼m ÃÂ¶ÃÂrenciler API ÃÂ§aÃÂrÃÂ±ldÃÂ±');
    
    // Veli ÃÂ¶ÃÂrencileri
    let veliOgrencileri = [];
    try {
      veliOgrencileri = await dbAll(`
        SELECT 
          o.id,
          o.ad_soyad,
          o.tc_no,
          o.sinif,
          o.okul,
          o.telefon,
          o.ogrenci_no,
          o.veli_id,
          'veli' as kaynak
        FROM ogrenciler o
        WHERE o.veli_id IS NOT NULL
        ORDER BY o.ad_soyad ASC
      `);
      console.log(`Ã¢ÂÂ ${veliOgrencileri.length} veli ÃÂ¶ÃÂrencisi bulundu`);
    } catch (error) {
      console.error('Ã¢ÂÂ Veli ÃÂ¶ÃÂrencileri yÃÂ¼kleme hatasÃÂ±:', error);
    }
    
    // Kurum ÃÂ¶ÃÂrencileri
    let kurumOgrencileri = [];
    try {
      kurumOgrencileri = await dbAll(`
        SELECT 
          ok.id,
          ok.ogrenci_adi_soyadi as ad_soyad,
          ok.tc_kimlik_no as tc_no,
          ok.sinif,
          '' as okul,
          ok.telefon,
          '' as ogrenci_no,
          NULL as veli_id,
          ok.veli_adi,
          ok.veli_telefon,
          'kurum' as kaynak
        FROM ogrenci_kayitlari ok
        ORDER BY ok.ogrenci_adi_soyadi ASC
      `);
      console.log(`Ã¢ÂÂ ${kurumOgrencileri.length} kurum ÃÂ¶ÃÂrencisi bulundu`);
    } catch (error) {
      console.error('Ã¢ÂÂ Kurum ÃÂ¶ÃÂrencileri yÃÂ¼kleme hatasÃÂ±:', error);
    }
    
    // TC bazlÃÂ± tekrarlarÃÂ± temizle
    const tumOgrenciler = temizleOgrenciTekrarlari(veliOgrencileri, kurumOgrencileri);
    
    console.log(`Ã¢ÂÂ Toplam ${tumOgrenciler.length} ÃÂ¶ÃÂrenci dÃÂ¶ndÃÂ¼rÃÂ¼lÃÂ¼yor`);
    
    res.json(tumOgrenciler);
  } catch (error) {
    console.error('Ã¢ÂÂ TÃÂ¼m ÃÂ¶ÃÂrenci listesi hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Kurum - Veli Bilgisi API
app.get('/kurum/veli-bilgi-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id } = req.query;
    
    if (!veli_id) {
      return res.status(400).json({ success: false, message: 'Veli ID gerekli!' });
    }
    
    const veli = await dbGet(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE id = ? AND user_type = 'veli'
    `, [veli_id]);
    
    if (!veli) {
      return res.status(404).json({ success: false, message: 'Veli bulunamad�!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Veli bilgisi hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - Telefon ile Veli Bul API
app.get('/kurum/veli-bul-telefon', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { telefon } = req.query;
    
    if (!telefon) {
      return res.status(400).json({ success: false, message: 'Telefon numarasÃÂ± gerekli!' });
    }
    
    // Telefon numarasÃÂ±nÃÂ± temizle (.0 gibi ekleri kaldÃÂ±r)
    let temizTelefon = telefon.toString().trim();
    if (temizTelefon.endsWith('.0')) {
      temizTelefon = temizTelefon.replace('.0', '');
    }
    const telefonNokta = temizTelefon + '.0';
    
    // Telefon numarasÃÂ± ile veli ara - hem temiz hem de .0 formatÃÂ±nda ara
    const veli = await dbGet(`
      SELECT 
        id,
        username,
        ad_soyad,
        email,
        telefon
      FROM users
      WHERE user_type = 'veli' 
        AND (telefon = ? OR telefon = ? OR username = ? OR username = ?)
      LIMIT 1
    `, [temizTelefon, telefonNokta, temizTelefon, telefonNokta]);
    
    if (!veli) {
      return res.status(404).json({ success: false, message: 'Veli bulunamad�!' });
    }
    
    res.json(veli);
  } catch (error) {
    console.error('Telefon ile veli arama hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - Veli ��rencileri API
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id } = req.query;
    
    if (!veli_id) {
      return res.status(400).json({ success: false, message: 'Veli ID gerekli!' });
    }
    
    const ogrenciler = await dbAll(`
      SELECT 
        id,
        ad_soyad,
        tc_no,
        sinif,
        okul,
        telefon,
        ogrenci_no
      FROM ogrenciler
      WHERE veli_id = ?
      ORDER BY ad_soyad ASC
    `, [veli_id]);
    
    res.json(ogrenciler);
  } catch (error) {
    console.error('��renci listesi hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - Rehber ÃÂÃÂretmene Talep GÃÂ¶nder
app.post('/kurum/rehber-talep-gonder', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { veli_id, ogrenci_id, rehber_ogretmen_id, ogrenci_no, ad_soyad, sinif, okul, mesaj, ogrenci_kaynak } = req.body;
    
    console.log('Ã°ÂÂÂ¥ Talep gÃÂ¶nderme isteÃÂi:', { veli_id, ogrenci_id, rehber_ogretmen_id, ad_soyad, ogrenci_kaynak });
    
    if (!veli_id || !rehber_ogretmen_id || !ad_soyad) {
      return res.json({ success: false, message: 'Eksik bilgiler! (veli_id, rehber_ogretmen_id, ad_soyad gerekli)' });
    }
    
    // Kurum ÃÂ¶ÃÂrencileri iÃÂ§in ogrenci_id NULL olabilir
    const kullanilacakOgrenciId = (ogrenci_kaynak === 'kurum') ? null : ogrenci_id;
    
    // AynÃÂ± talep var mÃÂ± kontrol et (ogrenci_id varsa) - Beklemede VEYA OnaylÃÂ± talep kontrolÃÂ¼
    if (kullanilacakOgrenciId) {
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi')
      `, [kullanilacakOgrenciId, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci iÃÂ§in bu rehber ÃÂ¶ÃÂretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci iÃÂ§in bu rehber ÃÂ¶ÃÂretmene zaten onaylÃÂ± bir talep var!' });
        }
      }
    } else {
      // Kurum ÃÂ¶ÃÂrencileri iÃÂ§in ad_soyad ve veli_id ile kontrol et
      const mevcutTalep = await dbGet(`
        SELECT id, durum FROM ogrenci_talepleri 
        WHERE ad_soyad = ? AND veli_id = ? AND rehber_ogretmen_id = ? AND durum IN ('beklemede', 'onaylandi') AND ogrenci_id IS NULL
      `, [ad_soyad, veli_id, rehber_ogretmen_id]);
      
      if (mevcutTalep) {
        if (mevcutTalep.durum === 'beklemede') {
          return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci iÃÂ§in bu rehber ÃÂ¶ÃÂretmene zaten bekleyen bir talep var!' });
        } else {
          return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci iÃÂ§in bu rehber ÃÂ¶ÃÂretmene zaten onaylÃÂ± bir talep var!' });
        }
      }
    }
    
    // Talep olu�tur
    // rehber_id ve rehber_ogretmen_id aynÃÂ± deÃÂer (kurum tarafÃÂ±ndan gÃÂ¶nderildiÃÂi iÃÂ§in)
    await dbRun(`
      INSERT INTO ogrenci_talepleri 
      (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum, mesaj)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'beklemede', ?)
    `, [kullanilacakOgrenciId, ogrenci_no || '', ad_soyad, sinif || '', okul || '', veli_id, rehber_ogretmen_id, rehber_ogretmen_id, mesaj || '']);
    
    console.log('Ã¢ÂÂ Talep ba�ar�yla olu�turuldu');
    
    // Veli ve rehber bilgilerini al
    const veli = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [veli_id]);
    const rehber = await dbGet('SELECT ad_soyad, telefon FROM users WHERE id = ?', [rehber_ogretmen_id]);
    
    // WhatsApp bildirimi gÃÂ¶nder (arka planda)
    if (veli && veli.telefon) {
      const veliMesaj = `Ã°ÂÂÂ© YENÃÂ° REHBER ÃÂÃÂRETMEN TALEBÃÂ°\n\n` +
        `Merhaba ${veli.ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
        `Kurum tarafÃÂ±ndan sizin ad�nÃÂ±za rehber ÃÂ¶ÃÂretmen yetki talebi gÃÂ¶nderilmiÃÂtir.\n\n` +
        `Ã°ÂÂÂ¤ ��renci: ${ad_soyad}\n` +
        `Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ« Rehber: ${rehber?.ad_soyad || 'Rehber ÃÂÃÂretmen'}\n\n` +
        `Talebiniz onaylandÃÂ±ÃÂÃÂ±nda rehber ÃÂ¶ÃÂretmen ÃÂ¶ÃÂrenciniz hakkÃÂ±nda bilgilere eriÃÂebilecektir.`;
      
      whatsappBildirimGonder(veli.telefon, veliMesaj, 'rehber_talep_kurum')
        .then(result => console.log('Ã¢ÂÂ Veli WhatsApp bildirimi gÃÂ¶nderildi:', result))
        .catch(error => console.error('Ã¢ÂÂ Veli WhatsApp bildirimi hatasÃÂ±:', error));
    }
    
    if (rehber && rehber.telefon) {
      const rehberMesaj = `Ã°ÂÂÂ© YENÃÂ° ÃÂÃÂRENCÃÂ° YETKÃÂ° TALEBÃÂ°\n\n` +
        `Merhaba ${rehber.ad_soyad || 'DeÃÂerli Rehber ÃÂÃÂretmenimiz'},\n\n` +
        `Kurum tarafÃÂ±ndan size yeni bir ÃÂ¶ÃÂrenci yetki talebi gÃÂ¶nderilmiÃÂtir.\n\n` +
        `Ã°ÂÂÂ¤ ��renci: ${ad_soyad}\n` +
        `Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ©Ã¢ÂÂÃ°ÂÂÂ§ Veli: ${veli?.ad_soyad || 'Veli'}\n` +
        `${sinif ? `Ã°ÂÂÂ SÃÂ±nÃÂ±f: ${sinif}\n` : ''}` +
        `${okul ? `Ã°ÂÂÂ« Okul: ${okul}\n` : ''}` +
        `${mesaj ? `\nÃ°ÂÂÂ¬ Mesaj: ${mesaj}\n` : ''}\n` +
        `LÃÂ¼tfen veli panelinden talebi inceleyip onaylayÃÂ±n veya reddedin.`;
      
      whatsappBildirimGonder(rehber.telefon, rehberMesaj, 'rehber_talep_kurum')
        .then(result => console.log('Ã¢ÂÂ Rehber WhatsApp bildirimi gÃÂ¶nderildi:', result))
        .catch(error => console.error('Ã¢ÂÂ Rehber WhatsApp bildirimi hatasÃÂ±:', error));
    }
    
    res.json({ 
      success: true, 
      message: 'Rehber ÃÂ¶ÃÂretmene talep ba�ar�yla gÃÂ¶nderildi!' 
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ Rehber talep gÃÂ¶nderme hatasÃÂ±:', error);
    console.error('Hata detayÃÂ±:', error.message);
    console.error('Stack trace:', error.stack);
    res.json({ 
      success: false, 
      message: `Talep gÃÂ¶nderilirken bir hata olu�tu: ${error.message}` 
    });
  }
});

// Kurum - ��renci Kay�tlarÃÂ± YÃÂ¶netimi
// API: Kurum ��renci Kay�tlarÃÂ± (JSON)
app.get('/kurum/ogrenci-kayitlari-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY ogrenci_adi_soyadi ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API ÃÂ¶ÃÂrenci kay�tlarÃÂ± hatasÃÂ±:', error);
    res.json([]);
  }
});

// API: Veli ��rencileri (JSON)
app.get('/kurum/veli-ogrencileri-api', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json([]);
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenciler ORDER BY ad_soyad ASC');
    res.json(ogrenciler);
  } catch (error) {
    console.error('API veli ÃÂ¶ÃÂrencileri hatasÃÂ±:', error);
    res.json([]);
  }
});

app.get('/kurum/ogrenci-kayitlari', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    const ogrenciler = await dbAll('SELECT * FROM ogrenci_kayitlari ORDER BY created_at DESC');
    
    // Benzersiz sÃÂ±nÃÂ±f listesi
    const siniflar = [...new Set(ogrenciler.map(o => o.sinif).filter(s => s))].sort();
    
    // Session mesajlarÃÂ±nÃÂ± al ve hemen temizle
    const errorMsg = req.session.error;
    const successMsg = req.session.success;
    req.session.error = null;
    req.session.success = null;
    
    res.render('kurum/ogrenci-kayitlari', {
      ogrenciler: ogrenciler,
      siniflar: siniflar,
      user: { username: req.session.username, type: req.session.userType },
      error: errorMsg,
      success: successMsg
    });
  } catch (error) {
    console.error('��renci kay�tlarÃÂ± listesi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - ��renci Kay�t Ekle
app.post('/kurum/ogrenci-kayit-ekle', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const {
      sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
      veli_adi, veli_telefon, tutar, odeme_durumu,
      odeme_turu, edessis_kaydi, taksit
    } = req.body;
    
    await dbRun(
      `INSERT INTO ogrenci_kayitlari (
        sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
        veli_adi, veli_telefon, tutar, odeme_durumu,
        odeme_turu, edessis_kaydi, taksit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
       veli_adi, veli_telefon, tutar, odeme_durumu,
       odeme_turu, edessis_kaydi, taksit]
    );
    
    res.json({ success: true, message: '��renci kayd� ba�ar�yla eklendi!' });
  } catch (error) {
    console.error('��renci kay�t ekleme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Kay�t eklenirken bir hata olu�tu: ' + error.message });
  }
});

// Kurum - HesapsÃÂ±z Velileri Kontrol Et
// ESKÃÂ° TELEFON BAZLI SÃÂ°STEM KALDIRILDI - SADECE TC BAZLI SÃÂ°STEM KULLANILIYOR

// Kurum - Veli GiriÃÂ Bilgisi Getir (ESKÃÂ° - KALDIRILDI)
app.get('/kurum/veli-giris-bilgisi', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz eri�im!' });
  }
  
  try {
    let { telefon } = req.query;
    
    if (!telefon) {
      return res.json({ success: false, message: 'Telefon numarasÃÂ± gerekli!' });
    }
    
    // Telefon formatÃÂ±nÃÂ± temizle (.0 ile biten)
    telefon = telefon.toString().trim();
    const telefonTemiz = telefon.endsWith('.0') ? telefon.replace('.0', '') : telefon;
    const telefonNokta = telefonTemiz + '.0';
    
    // Veli hesabÃÂ±nÃÂ± bul - hem temiz hem de .0 formatÃÂ±nda ara
    const veli = await dbGet(
      'SELECT username, password_hash, created_at FROM users WHERE (telefon = ? OR telefon = ? OR username = ? OR username = ?) AND user_type = ?',
      [telefonTemiz, telefonNokta, telefonTemiz, telefonNokta, 'veli']
    );
    
    if (!veli) {
      return res.json({ 
        success: true, 
        hesapVar: false 
      });
    }
    
    // ÃÂ°lk �ifre hash'i
    const ilkSifreHash = '$2b$10$';  // bcrypt baÃÂlangÃÂ±cÃÂ±
    const defaultPassword = 'Veli2024!';
    
    // ÃÂifre deÃÂiÃÂtirilmiÃÂ mi kontrol et
    // (Basit kontrol: created_at ile password_hash hash'i aynÃÂ± zamanda mÃÂ± olu�turulmuÃÂ)
    // Daha gÃÂ¼venli: password_hash'i "Veli2024!" ile karÃÂÃÂ±laÃÂtÃÂ±r
    const sifreDegismis = !await bcrypt.compare(defaultPassword, veli.password_hash);
    
    // Username'deki .0 formatÃÂ±nÃÂ± temizle
    let usernameTemiz = veli.username.toString();
    if (usernameTemiz.endsWith('.0')) {
      usernameTemiz = usernameTemiz.replace('.0', '');
    }
    
    console.log(`\nÃ°ÂÂÂÃ¯Â¸Â VELÃÂ° BÃÂ°LGÃÂ°SÃÂ° GÃÂSTERÃÂ°LDÃÂ°`);
    console.log(`   Telefon: ${telefon}`);
    console.log(`   Username (orijinal): ${veli.username}`);
    console.log(`   Username (temiz): ${usernameTemiz}`);
    console.log(`   ÃÂifre deÃÂiÃÂmiÃÂ: ${sifreDegismis ? 'Evet' : 'HayÃÂ±r'}`);
    
    res.json({
      success: true,
      hesapVar: true,
      username: usernameTemiz,
      sifre: defaultPassword,
      sifreDegismis: sifreDegismis
    });
  } catch (error) {
    console.error('Veli bilgi getirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - ��renci Kay�t Guncelle
app.post('/kurum/ogrenci-kayit-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { id } = req.params;
    const {
      sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
      veli_adi, veli_telefon, tutar, odeme_durumu,
      odeme_turu, edessis_kaydi, taksit
    } = req.body;
    
    await dbRun(
      `UPDATE ogrenci_kayitlari SET
        sinif = ?, ogrenci_adi_soyadi = ?, telefon = ?, tc_kimlik_no = ?,
        veli_adi = ?, veli_telefon = ?, tutar = ?, odeme_durumu = ?,
        odeme_turu = ?, edessis_kaydi = ?, taksit = ?,
        updated_at = datetime('now')
      WHERE id = ?`,
      [sinif, ogrenci_adi_soyadi, telefon, tc_kimlik_no,
       veli_adi, veli_telefon, tutar, odeme_durumu,
       odeme_turu, edessis_kaydi, taksit, id]
    );
    
    res.json({ success: true, message: '��renci kayd� g�ncellendi!' });
  } catch (error) {
    console.error('��renci kay�t gÃÂ¼ncelleme hatasÃÂ±:', error);
    res.json({ success: false, message: 'GÃÂ¼ncelleme s�ras�nda bir hata olu�tu!' });
  }
});

// Kurum - ��renci Kay�t Sil
app.post('/kurum/ogrenci-kayit-sil/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM ogrenci_kayitlari WHERE id = ?', [id]);
    res.json({ success: true, message: '��renci kayd� silindi!' });
  } catch (error) {
    console.error('��renci kay�t silme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Silme s�ras�nda bir hata olu�tu!' });
  }
});

// Kurum - TUM Ogrenci Kayitlarini Sil
app.post('/kurum/ogrenci-kayitlari-tumunu-sil', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { onayKodu } = req.body;
    
    // GÃÂ¼venlik kontrolÃÂ¼: "SÃÂ°L" yazmasÃÂ± gerekiyor
    if (onayKodu !== 'SIL') {
      return res.json({ success: false, message: 'Onay kodu hatali! "SIL" yazmaniz gerekiyor.' });
    }
    
    // KaÃÂ§ kay�t var?
    const kayitSayisi = await dbGet('SELECT COUNT(*) as sayi FROM ogrenci_kayitlari');
    
    // TÃÂ¼m kay�tlarÃÂ± sil
    await dbRun('DELETE FROM ogrenci_kayitlari');
    
    console.log(`\nÃ¢ÂÂ Ã¯Â¸Â  TÃÂM ÃÂÃÂRENCÃÂ° KAYITLARI SÃÂ°LÃÂ°NDÃÂ°!`);
    console.log(`   Silinen kay�t sayÃÂ±sÃÂ±: ${kayitSayisi.sayi}`);
    console.log(`   Yapan kullan�c�: ${req.session.username}\n`);
    
    res.json({ 
      success: true, 
      message: `${kayitSayisi.sayi} ÃÂ¶ÃÂrenci kaydÃÂ± ba�ar�yla silindi!` 
    });
  } catch (error) {
    console.error('Toplu silme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Silme iÃÂlemi s�ras�nda bir hata olu�tu!' });
  }
});

// Kurum - Excel Import
app.post('/kurum/ogrenci-import-excel', requireAuth, upload.single('excelFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath } = req.body;
    const isUploaded = !!req.file;
    const sourcePath = isUploaded ? req.file.path : pdfPath;
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sinav ID eksik!' });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi bulunamadi!' });
    }
    console.log('SINAV SONUCU ANALIZ EDILIYOR:', isUploaded && req.file ? req.file.originalname : path.basename(sourcePath));
    console.log('Sinav ID:', sinav_id);
    // PDF\'i yukle
    const pdfBytes = fs.readFileSync(sourcePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`Ã°ÂÂÂ Toplam sayfa: ${totalPages}`);
    
    // Her sayfayÃÂ± ayrÃÂ± PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya ad�: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join('uploads', 'sinav-sonuclari', sayfaFileName);
      
      // KlasÃÂ¶r yoksa olu�tur
      const dir = path.dirname(sayfaYolu);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`   Ã¢ÂÂ Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join('uploads', 'sinav-sonuclari', orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // VeritabanÃÂ±na kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // GeÃÂ§ici dosyayÃÂ± sil
    fs.unlinkSync(req.file.path);
    
    console.log(`Ã¢ÂÂ PDF ba�ar�yla ${totalPages} sayfaya ayrÃÂ±ldÃÂ±!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // AkÃÂ±llÃÂ± eÃÂleÃÂtirme (analiz/pattern seÃÂ§imi) ekranÃÂ±na yÃÂ¶nlendir
        redirectTo: `/kurum/sinav-sonuc-yukle/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ PDF ayÃÂ±rma hatasÃÂ±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ESKÃÂ° SÃÂ°STEM (Yedek olarak kalÃÂ±yor)
app.post('/kurum/sinav-sonuc-yukle-analiz', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath } = req.body;
    const isUploaded = !!req.file;
    const sourcePath = isUploaded ? req.file.path : pdfPath;
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'Sinav ID eksik!' });
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasi bulunamadi!' });
    }
    console.log('SINAV SONUCU ANALIZ EDILIYOR:', isUploaded && req.file ? req.file.originalname : path.basename(sourcePath));
    console.log('Sinav ID:', sinav_id);
    // PDF\'i yukle
    const pdfBytes = fs.readFileSync(sourcePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`Ã°ÂÂÂ Toplam sayfa: ${totalPages}`);
    
    // Sadece ilk sayfayÃÂ± analiz et
    const singlePagePdf = await PDFDocument.create();
    const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [0]);
    singlePagePdf.addPage(copiedPage);
    const singlePageBytes = await singlePagePdf.save();
    
    // GeÃÂ§ici dosya olu�tur
    const tempFileName = `temp_analyze_sinav_${Date.now()}.pdf`;
    const tempFilePath = path.join('uploads', tempFileName);
    fs.writeFileSync(tempFilePath, singlePageBytes);
    
    // Text ÃÂ§ÃÂ±kar - HÃÂ°BRÃÂ°T YÃÂNTEM
    const extractionResult = await extractTextHybrid(tempFilePath);
    const text = extractionResult.text;
    
    console.log(`Ã°ÂÂÂ ÃÂ°lk sayfa text uzunluÃÂu: ${text.length} (YÃÂ¶ntem: ${extractionResult.method})`);
    
    if (extractionResult.garbled) {
      console.log('Ã¢ÂÂ Ã¯Â¸Â ÃÂ°lk sayfada encoding sorunu tespit edildi!');
      console.log('Ã°ÂÂÂ¡ Manuel giriÃÂ ÃÂ¶nerilir.');
    }
    
    // Potansiyel isim adaylarÃÂ±nÃÂ± bul - YENÃÂ° GELÃÂ°ÃÂMÃÂ°ÃÂ SÃÂ°STEM
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const potansiyelIsimler = [];
    
    console.log(`Ã°ÂÂÂ Analiz: ${lines.length} satÃÂ±r bulundu`);
    
    // 1. GELÃÂ°ÃÂMÃÂ°ÃÂ FÃÂ°LTRELEME: Yeni looksLikeName fonksiyonunu kullan
    for (let i = 0; i < Math.min(lines.length, 80); i++) { // 80 satÃÂ±ra ÃÂ§ÃÂ±kardÃÂ±k
      const line = lines[i];
      
      // ÃÂ°sim gibi mi kontrol et (yeni fonksiyon)
      if (!looksLikeName(line)) continue;
      
      // ÃÂ°smi temizle (yeni fonksiyon)
      const cleanLine = cleanExtractedName(line);
      if (!cleanLine || cleanLine.length < 5) continue;
      
      // Kelime sayÃÂ±sÃÂ± kontrolÃÂ¼
      const words = cleanLine.split(/\s+/);
      const wordCount = words.length;
      
      // GÃÂ¼ven seviyesi hesapla
      let confidence = 'medium';
      
      // Sadece harf ve boÃÂluk + 2-3 kelime = yÃÂ¼ksek gÃÂ¼ven
      if (wordCount === 2 || wordCount === 3) {
        confidence = 'high';
      }
      // 4-6 kelime = dÃÂ¼ÃÂÃÂ¼k gÃÂ¼ven
      else if (wordCount > 3) {
        confidence = 'low';
      }
      
      potansiyelIsimler.push({
        text: cleanLine,
        lineNumber: i,
        confidence: confidence,
        originalLine: line // Orijinal satÃÂ±rÃÂ± da sakla
      });
      
      console.log(`   Ã¢ÂÂ Aday ${potansiyelIsimler.length}: "${cleanLine}" (SatÃÂ±r: ${i}, GÃÂ¼ven: ${confidence})`);
    }
    
    // 2. HiÃÂ§ isim bulunamad�ysa, en uzun satÃÂ±rlarÃÂ± gÃÂ¶ster (fallback)
    if (potansiyelIsimler.length === 0) {
      console.log('Ã¢ÂÂ Ã¯Â¸Â HiÃÂ§ isim adayÃÂ± bulunamad�, en uzun satÃÂ±rlar gÃÂ¶steriliyor...');
      
      const longLines = lines
        .map((line, i) => ({ line, index: i, length: line.length }))
        .filter(l => l.length >= 10 && l.length <= 100)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      
      longLines.forEach(l => {
        potansiyelIsimler.push({
          text: l.line,
          lineNumber: l.index,
          confidence: 'low',
          originalLine: l.line
        });
      });
      
      console.log(`   Ã¢ÂÂ ${potansiyelIsimler.length} uzun satÃÂ±r eklendi (fallback)`);
    }
    
    // Ã°ÂÂ§Â  AkÃÂ±llÃÂ± sistem ile ilk sayfayÃÂ± test et
    console.log('\nÃ°ÂÂ§Â  AkÃÂ±llÃÂ± sistem ile ilk sayfa test ediliyor...');
    const testMatch = await intelligentCascadeMatching(
      text, 
      sinav_id, 
      req.session.userId, 
      tempFilePath
    );
    
    let autoSelectedPattern = null;
    let autoConfidence = 0;
    
    if (testMatch && testMatch.confidence >= 0.80) {
      autoSelectedPattern = {
        text: testMatch.extractedName,
        lineNumber: testMatch.lineNumber,
        confidence: testMatch.confidence,
        strategy: testMatch.usedStrategy,
        matchedStudent: testMatch.ogrenciAd
      };
      autoConfidence = testMatch.confidence;
      console.log(`Ã¢ÂÂ Otomatik pattern bulundu: "${testMatch.extractedName}" (GÃÂ¼ven: ${(autoConfidence * 100).toFixed(0)}%)`);
    } else {
      console.log('Ã¢ÂÂ Ã¯Â¸Â Otomatik pattern bulunamad�, manuel seÃÂ§im gerekli');
    }
    
    // GeÃÂ§ici dosyalarÃÂ± temizle
    fs.unlinkSync(tempFilePath);
    
    console.log(`Ã¢ÂÂ ${potansiyelIsimler.length} potansiyel isim bulundu`);
    potansiyelIsimler.forEach(p => console.log(`   - ${p.text} (satÃÂ±r ${p.lineNumber}, gÃÂ¼ven: ${p.confidence})`));
    
    res.json({
      success: true,
      data: {
        totalPages: totalPages,
        uploadPath: req.file.path,
        originalName: req.file.originalname,
        sinavId: sinav_id,
        potansiyelIsimler: potansiyelIsimler.slice(0, 15), // ÃÂ°lk 15 aday
        ornekText: text.substring(0, 500), // Kullan�c�ya gÃÂ¶ster
        allLines: lines, // TÃÂ¼m satÃÂ±rlarÃÂ± da gÃÂ¶nder (frontend iÃÂ§in)
        autoSelectedPattern: autoSelectedPattern, // Ã°ÂÂÂ¯ Otomatik seÃÂ§ilen pattern
        useAutoMode: autoConfidence >= 0.85 // %85+ gÃÂ¼ven varsa direkt kullan
      }
    });
    
  } catch (error) {
    console.error('SonuÃÂ§ analiz hatasÃÂ±:', error);
    
    // DosyayÃÂ± temizle
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Analiz s�ras�nda bir hata olu�tu: ' + error.message 
    });
  }
});

// Kurum - SonuÃÂ§ PDF Kaydet (TÃÂ¼m sayfalarÃÂ± iÃÂle, eÃÂleÃÂtir, kaydet)
app.post('/kurum/sinav-sonuc-yukle-kaydet', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, pdfPath, selectedPattern, selectedLineNumber, manuelEslesmeler } = req.body;
    
    if (!sinav_id || !pdfPath) {
      return res.status(400).json({ success: false, error: 'S�nav ID veya PDF dosya yolu eksik!' });
    }
    
    console.log('\nÃ°ÂÂ§Â  AKILLI SINAV SONUÃÂLARI YÃÂKLENÃÂ°YOR');
    console.log('Ã¢ÂÂ S�nav ID:', sinav_id);
    console.log('Ã¢ÂÂ PDF Path:', pdfPath);
    console.log('Ã°ÂÂÂ¯ Mod: AkÃÂ±llÃÂ± Cascade Matching (5 strateji)');
    
    const results = [];
    let matchedCount = 0;
    let unmatchedCount = 0;
    let savedCount = 0;
    let strategyStats = {};
    
    // S�nav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'S�nav bulunamad�!' });
    }
    
    // SonuÃÂ§ klasÃÂ¶rÃÂ¼nÃÂ¼ olu�tur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // PDF'i yÃÂ¼kle
    if (!fs.existsSync(pdfPath)) {
      return res.status(400).json({ success: false, error: 'PDF dosyasÃÂ± bulunamad�!' });
    }
    
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`Ã°ÂÂÂ Toplam sayfa: ${totalPages}`);
    console.log(`Ã°ÂÂÂ SonuÃÂ§ klasÃÂ¶rÃÂ¼: ${sonucKlasoru}`);
    
    // Manuel eÃÂleÃÂmeleri map'e ÃÂ§evir (sayfa numarasÃÂ± Ã¢ÂÂ ÃÂ¶ÃÂrenci ID)
    const manuelMap = {};
    if (manuelEslesmeler && Array.isArray(manuelEslesmeler)) {
      manuelEslesmeler.forEach(m => {
        if (m.sayfaNo && m.ogrenciId) {
          manuelMap[m.sayfaNo] = m.ogrenciId;
        }
      });
      console.log(`Ã°ÂÂÂ ${Object.keys(manuelMap).length} manuel eÃÂleÃÂme alÃÂ±ndÃÂ±`);
    }
    
    // Her sayfayÃÂ± iÃÂle
    for (let i = 0; i < totalPages; i++) {
      try {
        const sayfaNo = i + 1;
        console.log(`\nÃ°ÂÂÂ Sayfa ${sayfaNo}/${totalPages} iÃÂleniyor...`);
        
        // Bu sayfayÃÂ± ayrÃÂ± bir PDF olarak olu�tur
        const singlePagePdf = await PDFDocument.create();
        const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
        singlePagePdf.addPage(copiedPage);
        const singlePageBytes = await singlePagePdf.save();
        
        // GeÃÂ§ici dosya ad� olu�tur
        const tempFileName = `temp_sinav_page_${sayfaNo}_${Date.now()}.pdf`;
        const tempFilePath = path.join('uploads', tempFileName);
        fs.writeFileSync(tempFilePath, singlePageBytes);
        
        // Bu sayfadan text ÃÂ§ÃÂ±kar
        const extractionResult = await extractTextHybrid(tempFilePath);
        const text = extractionResult.text;
        const isGarbled = extractionResult.garbled || false;
        
        let ogrenciId = null;
        let ogrenciAdi = 'BÃÂ°LÃÂ°NMEYEN';
        let kaynak = 'kurum';
        let usedStrategy = null;
        let confidence = 0;
        let extractedName = '';
        
        // Manuel eÃÂleÃÂme var mÃÂ± kontrol et
        if (manuelMap[sayfaNo]) {
          // Manuel eÃÂleÃÂme var
          ogrenciId = manuelMap[sayfaNo];
          const ogrenci = await dbGet('SELECT * FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          if (ogrenci) {
            ogrenciAdi = ogrenci.ogrenci_adi_soyadi;
            console.log(`Ã¢ÂÂ Manuel eÃÂleÃÂme: ${ogrenciAdi} (ID: ${ogrenciId})`);
            matchedCount++;
            usedStrategy = 'Manuel';
            confidence = 1.0;
          } else {
            console.log(`Ã¢ÂÂ Ã¯Â¸Â Manuel eÃÂleÃÂme geÃÂ§ersiz! ��renci ID ${ogrenciId} bulunamad�.`);
            unmatchedCount++;
          }
        } else {
          // Ã°ÂÂ§Â  AKILLI CASCADE MATCHING KULLAN
          const matchResult = await intelligentCascadeMatching(
            text, 
            sinav_id, 
            req.session.userId,
            tempFilePath
          );
          
          if (matchResult && matchResult.confidence >= 0.75) {
            // BaÃÂarÃÂ±lÃÂ± eÃÂleÃÂme
            ogrenciId = matchResult.ogrenciId;
            ogrenciAdi = matchResult.ogrenciAd;
            kaynak = matchResult.kaynak;
            extractedName = matchResult.extractedName;
            confidence = matchResult.confidence;
            usedStrategy = matchResult.usedStrategy;
            
            // Strateji istatistiklerini gÃÂ¼ncelle
            strategyStats[usedStrategy] = (strategyStats[usedStrategy] || 0) + 1;
            
            console.log(`Ã¢ÂÂ AkÃÂ±llÃÂ± eÃÂleÃÂme: ${ogrenciAdi} (Strateji: ${usedStrategy}, GÃÂ¼ven: ${(confidence * 100).toFixed(0)}%)`);
            matchedCount++;
          } else {
            // EÃÂleÃÂme baÃÂarÃÂ±sÃÂ±z
            console.log(`Ã¢ÂÂ TÃÂ¼m stratejiler baÃÂarÃÂ±sÃÂ±z - Manuel gerekli`);
            unmatchedCount++;
          }
        }
        
        // PDF'i kaydet
        const sanitizedName = ogrenciAdi.replace(/[^a-zA-ZÃÂ§ÃÂÃÂÃÂÃÂ±ÃÂ°ÃÂ¶ÃÂÃÂÃÂÃÂ¼ÃÂ\s]/g, '').replace(/\s+/g, '_');
        const finalFileName = ogrenciId 
          ? `${sayfaNo}_${sanitizedName}_${ogrenciId}.pdf`
          : `${sayfaNo}_BILINMEYEN_${Date.now()}.pdf`;
        
        const finalFilePath = path.join(sonucKlasoru, finalFileName);
        fs.writeFileSync(finalFilePath, singlePageBytes);
        
        console.log(`Ã°ÂÂÂ¾ PDF kaydedildi: ${finalFileName}`);
        
        // VeritabanÃÂ±na kaydet (eÃÂer eÃÂleÃÂme varsa)
        if (ogrenciId) {
          try {
            // sinav_katilimcilari tablosunu gÃÂ¼ncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi' 
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [finalFilePath, sinav_id, ogrenciId, kaynak]);
            
            savedCount++;
            console.log(`Ã¢ÂÂ VeritabanÃÂ±na kaydedildi`);
          } catch (dbError) {
            console.error(`Ã¢ÂÂ VeritabanÃÂ± kay�t hatasÃÂ±:`, dbError);
          }
        }
        
        // SonuÃÂ§ listesine ekle
        results.push({
          sayfaNo: sayfaNo,
          ogrenciId: ogrenciId,
          ogrenciAdi: ogrenciAdi,
          pdfYolu: finalFilePath,
          eslesti: !!ogrenciId,
          extractedName: extractedName,
          isGarbled: isGarbled,
          strategy: usedStrategy,
          confidence: confidence
        });
        
        // GeÃÂ§ici dosyayÃÂ± temizle
        fs.unlinkSync(tempFilePath);
        
      } catch (pageError) {
        console.error(`Ã¢ÂÂ Sayfa ${i + 1} iÃÂlenirken hata:`, pageError);
        results.push({
          sayfaNo: i + 1,
          ogrenciId: null,
          ogrenciAdi: 'HATA',
          pdfYolu: null,
          eslesti: false,
          error: pageError.message
        });
        unmatchedCount++;
      }
    }
    
    // S�navÃÂ± gÃÂ¼ncelle (sonuc_yuklendi = 1)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    // YÃÂ¼klenen PDF dosyasÃÂ±nÃÂ± temizle
    try {
      fs.unlinkSync(pdfPath);
    } catch (cleanError) {
      console.error('Ã¢ÂÂ Ã¯Â¸Â GeÃÂ§ici PDF temizlenemedi:', cleanError);
    }
    
    console.log('\nÃ¢ÂÂ ÃÂ°ÃÂLEM TAMAMLANDI!');
    console.log(`   Toplam sayfa: ${totalPages}`);
    console.log(`   EÃÂleÃÂen: ${matchedCount}`);
    console.log(`   EÃÂleÃÂmeyen: ${unmatchedCount}`);
    console.log(`   Kaydedilen: ${savedCount}`);
    console.log(`\nÃ°ÂÂÂ Strateji ÃÂ°statistikleri:`);
    Object.entries(strategyStats).forEach(([strategy, count]) => {
      console.log(`   ${strategy}: ${count} sayfa`);
    });
    
    res.json({
      success: true,
      message: `${matchedCount}/${totalPages} sayfa otomatik eÃÂleÃÂtirildi (AkÃÂ±llÃÂ± Sistem)`,
      data: {
        totalPages: totalPages,
        matchedCount: matchedCount,
        unmatchedCount: unmatchedCount,
        savedCount: savedCount,
        strategyStats: strategyStats,
        results: results
      }
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ SonuÃÂ§ kaydetme hatasÃÂ±:', error);
    
    res.status(500).json({ 
      success: false, 
      error: 'Kaydetme s�ras�nda bir hata olu�tu: ' + error.message 
    });
  }
});

// Kurum - Manuel S�nav SonuÃÂ§ EÃÂleÃÂtirme
app.post('/kurum/sinav-manuel-eslestir/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    const { eslesmeler } = req.body;
    
    if (!eslesmeler || eslesmeler.length === 0) {
      return res.json({ success: false, message: 'EÃÂleÃÂtirme bilgisi eksik!' });
    }
    
    console.log(`\nÃ°ÂÂÂ MANUEL EÃÂLEÃÂTIRME (S�nav ID: ${sinavId})`);
    console.log(`   ${eslesmeler.length} adet eÃÂleÃÂtirme yapÃÂ±lacak`);
    
    let basarili = 0;
    let hatali = 0;
    
    for (const eslesme of eslesmeler) {
      try {
        const { sayfaNo, pdfYolu, ogrenciId, kaynak } = eslesme;
        
        console.log(`   Ã°ÂÂÂ Sayfa ${sayfaNo}:`);
        console.log(`      - ��renci ID: ${ogrenciId}`);
        console.log(`      - Kaynak: ${kaynak}`);
        console.log(`      - PDF Yolu: ${pdfYolu}`);
        console.log(`      - Dosya var mÃÂ±: ${pdfYolu ? fs.existsSync(pdfYolu) : 'PDF yolu boÃÂ'}`);
        
        // PDF dosyasÃÂ±nÃÂ± yeni isimle kaydet
        if (pdfYolu && fs.existsSync(pdfYolu)) {
          // ��renci bilgilerini al
          let ogrenci;
          if (kaynak === 'veli') {
            ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenciId]);
          } else {
            ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenciId]);
          }
          
          if (ogrenci) {
            // Yeni dosya ad� olu�tur
            const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
            if (!fs.existsSync(sonucKlasoru)) {
              fs.mkdirSync(sonucKlasoru, { recursive: true });
            }
            
            const timestamp = Date.now();
            const safeIsim = ogrenci.ad_soyad.replace(/[^a-zA-ZÃÂ§ÃÂÃÂÃÂÃÂ±ÃÂ°ÃÂ¶ÃÂÃÂÃÂÃÂ¼ÃÂ\s]/g, '').replace(/\s+/g, '_');
            const yeniDosyaAdi = `${safeIsim}_${timestamp}.pdf`;
            const yeniDosyaYolu = path.join(sonucKlasoru, yeniDosyaAdi);
            
            // DosyayÃÂ± kopyala
            fs.copyFileSync(pdfYolu, yeniDosyaYolu);
            
            // sinav_katilimcilari tablosunu gÃÂ¼ncelle
            await dbRun(`
              UPDATE sinav_katilimcilari 
              SET pdf_path = ?, sonuc_durumu = 'yuklendi'
              WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
            `, [yeniDosyaYolu, sinavId, ogrenciId, kaynak]);
            
            console.log(`   Ã¢ÂÂ BaÃÂarÃÂ±lÃÂ±: ${ogrenci.ad_soyad}`);
            basarili++;
          } else {
            console.log(`   Ã¢ÂÂ ��renci bulunamad�: ${ogrenciId}`);
            hatali++;
          }
        } else {
          console.log(`   Ã¢ÂÂ PDF dosyasÃÂ± bulunamad�: ${pdfYolu}`);
          hatali++;
        }
      } catch (error) {
        console.error(`   Ã¢ÂÂ EÃÂleÃÂtirme hatasÃÂ±:`, error);
        hatali++;
      }
    }
    
    // S�navÃÂ±n sonuc_yuklendi durumunu gÃÂ¼ncelle (ama henÃÂ¼z yayÃÂ±nlanmamÃÂ±ÃÂ)
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1, sonuc_yayinlandi = 0 WHERE id = ?', [sinavId]);
    
    // Ã¢ÂÂ GÃÂNCEL ÃÂ°STATÃÂ°STÃÂ°KLERÃÂ° HESAPLA
    const istatistikler = await dbGet(`
      SELECT 
        COUNT(*) as toplam,
        SUM(CASE WHEN pdf_path IS NOT NULL AND pdf_path != '' THEN 1 ELSE 0 END) as eslesmis,
        SUM(CASE WHEN pdf_path IS NULL OR pdf_path = '' THEN 1 ELSE 0 END) as eslesmemis
      FROM sinav_katilimcilari
      WHERE sinav_id = ?
    `, [sinavId]);
    
    console.log(`\nÃ°ÂÂÂ MANUEL EÃÂLEÃÂTIRME TAMAMLANDI:`);
    console.log(`   Ã¢ÂÂ BaÃÂarÃÂ±lÃÂ±: ${basarili}`);
    console.log(`   Ã¢ÂÂ HatalÃÂ±: ${hatali}`);
    console.log(`\nÃ°ÂÂÂ GÃÂNCEL DURUM:`);
    console.log(`   Toplam KatÃÂ±lÃÂ±mcÃÂ±: ${istatistikler.toplam}`);
    console.log(`   EÃÂleÃÂen: ${istatistikler.eslesmis}`);
    console.log(`   EÃÂleÃÂmeyen: ${istatistikler.eslesmemis}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} ÃÂ¶ÃÂrenci eÃÂleÃÂtirildi! ${hatali > 0 ? `(${hatali} hata)` : ''}`,
      matchedCount: istatistikler.eslesmis || 0,
      unmatchedCount: istatistikler.eslesmemis || 0,
      totalCount: istatistikler.toplam || 0
    });
  } catch (error) {
    console.error('Ã¢ÂÂ Manuel eÃÂleÃÂtirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Ã°ÂÂÂ Kurum - EÃÂleÃÂmemiÃÂ PDF SayfalarÃÂ±nÃÂ± Listele
app.get('/kurum/sinav-eslesmemis-pdfler/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\nÃ°ÂÂÂ TÃÂM PDF SAYFALARI LÃÂ°STELENÃÂ°YOR (EÃÂleÃÂen + EÃÂleÃÂmeyen):', sinavId);
    
    // TÃÂM yÃÂ¼klenmiÃÂ PDF'leri al - HEM EÃÂLEÃÂEN HEM EÃÂLEÃÂMEYEN
    // pdf_path NULL olanlar = henÃÂ¼z eÃÂleÃÂmemiÃÂ (BÃÂ°LÃÂ°NMEYEN)
    // pdf_path dolu olanlar = eÃÂleÃÂmiÃÂ
    // BÃÂ°LÃÂ°NMEYEN olanlar = PDF var ama ÃÂ¶ÃÂrenci eÃÂleÃÂmemiÃÂ
    const eslesmemisOgrenciler = await dbAll(`
      SELECT 
        sk.id as katilimci_id,
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
          ELSE 'BÃÂ°LÃÂ°NMEYEN'
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY 
        CASE 
          WHEN sk.pdf_path IS NOT NULL AND (ok.ogrenci_adi_soyadi = 'BÃÂ°LÃÂ°NMEYEN' OR o.ad_soyad = 'BÃÂ°LÃÂ°NMEYEN' OR (ok.ogrenci_adi_soyadi IS NULL AND o.ad_soyad IS NULL)) THEN 0
          WHEN sk.pdf_path IS NULL THEN 1
          ELSE 2
        END,
        sk.id
    `, [sinavId]);
    
    // EÃÂleÃÂtirilebilir ÃÂ¶ÃÂrencileri al (tÃÂ¼m katÃÂ±lÃÂ±mcÃÂ±lar)
    const tumOgrenciler = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY ad_soyad
    `, [sinavId]);
    
    // Orijinal PDF yolunu bul - eÃÂleÃÂmiÃÂ herhangi bir ÃÂ¶ÃÂrencinin PDF'inden al
    let orijinalPdfYolu = null;
    
    // ÃÂnce sinavlar tablosuna bak
    const sinav = await dbGet('SELECT dosya_yolu FROM sinavlar WHERE id = ?', [sinavId]);
    if (sinav && sinav.dosya_yolu) {
        orijinalPdfYolu = sinav.dosya_yolu;
    } else {
        // Yoksa eÃÂleÃÂmiÃÂ herhangi bir ÃÂ¶ÃÂrencinin PDF'ini al
        const eslesmisOgrenci = await dbGet(
            'SELECT pdf_path FROM sinav_katilimcilari WHERE sinav_id = ? AND pdf_path IS NOT NULL LIMIT 1',
            [sinavId]
        );
        if (eslesmisOgrenci && eslesmisOgrenci.pdf_path) {
            orijinalPdfYolu = eslesmisOgrenci.pdf_path;
        }
    }
    
    console.log(`   Ã°ÂÂÂ EÃÂleÃÂmemiÃÂ: ${eslesmemisOgrenciler.length}`);
    console.log(`   Ã°ÂÂÂ¥ Toplam ��renci: ${tumOgrenciler.length}`);
    console.log(`   Ã°ÂÂÂ PDF Yolu: ${orijinalPdfYolu}`);
    
    res.json({
      success: true,
      data: {
        eslesmemisPdfler: eslesmemisOgrenciler,
        tumOgrenciler: tumOgrenciler,
        orijinalPdfYolu: orijinalPdfYolu
      }
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ EÃÂleÃÂmemiÃÂ PDF listeleme hatasÃÂ±:', error);
    res.json({ success: false, error: error.message });
  }
});

// Ã°ÂÂÂ Kurum - Mevcut PDF'i BaÃÂka ��renciye Ata
app.post('/kurum/sinav-pdf-yeniden-eslestir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { katilimci_id, yeni_ogrenci_id, yeni_kaynak, sinav_id } = req.body;
    
    console.log(`\nÃ°ÂÂÂ PDF YENÃÂ°DEN EÃÂLEÃÂTÃÂ°RÃÂ°LÃÂ°YOR`);
    console.log(`   KatÃÂ±lÃÂ±mcÃÂ± ID: ${katilimci_id}`);
    console.log(`   Yeni ��renci ID: ${yeni_ogrenci_id}`);
    console.log(`   Yeni Kaynak: ${yeni_kaynak}`);
    
    // Eski katÃÂ±lÃÂ±mcÃÂ±nÃÂ±n PDF yolunu al
    const eskiKatilimci = await dbGet('SELECT pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimci_id]);
    
    if (!eskiKatilimci || !eskiKatilimci.pdf_path) {
      return res.json({ success: false, message: 'PDF bulunamad�!' });
    }
    
    // Yeni ÃÂ¶ÃÂrenci bilgilerini al
    let yeniOgrenci;
    if (yeni_kaynak === 'kurum') {
      yeniOgrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [yeni_ogrenci_id]);
    } else {
      yeniOgrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [yeni_ogrenci_id]);
    }
    
    if (!yeniOgrenci) {
      return res.json({ success: false, message: '��renci bulunamad�!' });
    }
    
    // Eski PDF yolunu al
    const eskiPdfPath = eskiKatilimci.pdf_path;
    
    // Yeni dosya ad� olu�tur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    const guvenliIsim = yeniOgrenci.ad_soyad.replace(/[^a-zA-Z0-9ÃÂÃÂ¼ÃÂÃÂ¶ÃÂ§ÃÂ°ÃÂÃÂÃÂÃÂÃÂ\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // DosyayÃÂ± kopyala/taÃÂÃÂ±
    const eskiTamYol = path.join(__dirname, eskiPdfPath);
    if (fs.existsSync(eskiTamYol)) {
      fs.copyFileSync(eskiTamYol, yeniDosyaYolu);
    }
    
    // VeritabanÃÂ±nÃÂ± gÃÂ¼ncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    
    // Yeni ÃÂ¶ÃÂrenci iÃÂ§in kay�t olu�tur/gÃÂ¼ncelle
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, yeni_ogrenci_id, yeni_kaynak]);
    
    // Eski kaydÃÂ± temizle (PDF'i kaldÃÂ±r)
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = NULL, sonuc_durumu = 'bekleniyor'
      WHERE id = ?
    `, [katilimci_id]);
    
    // Eski dosyayÃÂ± sil
    if (fs.existsSync(eskiTamYol)) {
      fs.unlinkSync(eskiTamYol);
    }
    
    console.log(`   Ã¢ÂÂ PDF ba�ar�yla "${yeniOgrenci.ad_soyad}" iÃÂ§in atandÃÂ±`);
    
    res.json({ 
      success: true, 
      message: `Ã¢ÂÂ PDF ba�ar�yla "${yeniOgrenci.ad_soyad}" ile eÃÂleÃÂtirildi!`
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ PDF yeniden eÃÂleÃÂtirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Ã°ÂÂÂ¤ Kurum - Tek ��renci ÃÂ°ÃÂ§in PDF EÃÂleÃÂtir
app.post('/kurum/sinav-tek-ogrenci-eslestir', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    const pdfFile = req.file;
    
    if (!pdfFile) {
      return res.json({ success: false, message: 'PDF dosyasÃÂ± yÃÂ¼klenmedi!' });
    }
    
    console.log(`\nÃ°ÂÂÂ¤ TEK ÃÂÃÂRENCÃÂ° EÃÂLEÃÂTÃÂ°RME`);
    console.log(`   S�nav ID: ${sinav_id}`);
    console.log(`   ��renci ID: ${ogrenci_id}`);
    console.log(`   Kaynak: ${kaynak}`);
    console.log(`   PDF: ${pdfFile.filename}`);
    
    // ��renci bilgilerini al
    let ogrenci;
    if (kaynak === 'kurum') {
      ogrenci = await dbGet('SELECT ogrenci_adi_soyadi as ad_soyad FROM ogrenci_kayitlari WHERE id = ?', [ogrenci_id]);
    } else {
      ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    }
    
    if (!ogrenci) {
      return res.json({ success: false, message: '��renci bulunamad�!' });
    }
    
    // S�nav klasÃÂ¶rÃÂ¼nÃÂ¼ olu�tur
    const sinavKlasoru = path.join(__dirname, 'uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sinavKlasoru)) {
      fs.mkdirSync(sinavKlasoru, { recursive: true });
    }
    
    // Dosya ad�nÃÂ± olu�tur
    const guvenliIsim = ogrenci.ad_soyad.replace(/[^a-zA-Z0-9ÃÂÃÂ¼ÃÂÃÂ¶ÃÂ§ÃÂ°ÃÂÃÂÃÂÃÂÃÂ\s]/g, '').replace(/\s+/g, '_');
    const timestamp = Date.now();
    const yeniDosyaAdi = `${guvenliIsim}_${timestamp}.pdf`;
    const yeniDosyaYolu = path.join(sinavKlasoru, yeniDosyaAdi);
    
    // DosyayÃÂ± taÃÂÃÂ±
    fs.copyFileSync(pdfFile.path, yeniDosyaYolu);
    fs.unlinkSync(pdfFile.path); // GeÃÂ§ici dosyayÃÂ± sil
    
    // VeritabanÃÂ±nÃÂ± gÃÂ¼ncelle
    const relativePath = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`, yeniDosyaAdi);
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET pdf_path = ?, sonuc_durumu = 'yuklendi'
      WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
    `, [relativePath, sinav_id, ogrenci_id, kaynak]);
    
    // S�navÃÂ±n sonuc_yuklendi durumunu gÃÂ¼ncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`   Ã¢ÂÂ BaÃÂarÃÂ±lÃÂ±: ${ogrenci.ad_soyad} iÃÂ§in PDF eÃÂleÃÂtirildi`);
    
    res.json({ 
      success: true, 
      message: `Ã¢ÂÂ ${ogrenci.ad_soyad} iÃÂ§in sonuÃÂ§ ba�ar�yla eÃÂleÃÂtirildi!`
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ Tek ÃÂ¶ÃÂrenci eÃÂleÃÂtirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Ã°ÂÂÂ¢ Kurum - S�nav Sonu�lar�nÃÂ± YayÃÂ±nla (Velilere gÃÂ¶rÃÂ¼nÃÂ¼r hale getir)
app.post('/kurum/sinav-sonuclari-yayinla/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    console.log('\nÃ°ÂÂÂ¢ SINAV SONUÃÂLARI YAYINLANIYOR:', sinavId);
    
    // S�nav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'S�nav bulunamad�!' });
    }
    
    if (!sinav.sonuc_yuklendi) {
      return res.json({ success: false, message: 'HenÃÂ¼z sonuÃÂ§ yÃÂ¼klenmemiÃÂ!' });
    }
    
    if (sinav.sonuc_yayinlandi) {
      return res.json({ success: false, message: 'SonuÃÂ§lar zaten yayÃÂ±nlanmÃÂ±ÃÂ!' });
    }
    
    // EÃÂleÃÂmiÃÂ sonuÃÂ§ sayÃÂ±sÃÂ±nÃÂ± kontrol et
    const eslesmisler = await dbAll(`
      SELECT COUNT(*) as sayi 
      FROM sinav_katilimcilari 
      WHERE sinav_id = ? AND pdf_path IS NOT NULL
    `, [sinavId]);
    
    const eslesmeSayisi = eslesmisler[0]?.sayi || 0;
    
    if (eslesmeSayisi === 0) {
      return res.json({ success: false, message: 'HiÃÂ§ eÃÂleÃÂmiÃÂ sonuÃÂ§ yok! LÃÂ¼tfen ÃÂ¶nce eÃÂleÃÂtirme yapÃÂ±n.' });
    }
    
    // S�navÃÂ± yayÃÂ±nla
    await dbRun('UPDATE sinavlar SET sonuc_yayinlandi = 1 WHERE id = ?', [sinavId]);
    
    console.log(`   Ã¢ÂÂ YayÃÂ±nlandÃÂ±: ${eslesmeSayisi} sonuÃÂ§ velilere gÃÂ¶rÃÂ¼nÃÂ¼r hale geldi`);
    
    res.json({ 
      success: true, 
      message: `Ã¢ÂÂ SonuÃÂ§lar yayÃÂ±nlandÃÂ±! ${eslesmeSayisi} ÃÂ¶ÃÂrencinin velisi artÃÂ±k sonu�lar� gÃÂ¶rebilir.`
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ YayÃÂ±nlama hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Kurum - S�nav SonuÃÂ§ WhatsApp Bildirim GÃÂ¶nder
app.post('/kurum/sinav-sonuc-whatsapp-gonder/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const sinavId = req.params.id;
    
    // S�nav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    
    if (!sinav) {
      return res.json({ success: false, message: 'S�nav bulunamad�!' });
    }
    
    // Sonucu yÃÂ¼klenmiÃÂ katÃÂ±lÃÂ±mcÃÂ±larÃÂ± al (hem kurum hem veli ÃÂ¶ÃÂrencileri)
    const kurumKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        ok.ogrenci_adi_soyadi as ogrenci_adi,
        ok.veli_adi,
        ok.veli_telefon,
        ok.telefon as ogrenci_telefon,
        'kurum' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ? AND sk.sonuc_durumu IN ('yuklendi', 'bildirildi') AND sk.pdf_path IS NOT NULL
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT 
        sk.*,
        o.ad_soyad as ogrenci_adi,
        u.ad_soyad as veli_adi,
        u.telefon as veli_telefon,
        o.telefon as ogrenci_telefon,
        'veli' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE sk.sinav_id = ? AND sk.sonuc_durumu IN ('yuklendi', 'bildirildi') AND sk.pdf_path IS NOT NULL
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    if (katilimcilar.length === 0) {
      return res.json({ success: false, message: 'Sonucu yÃÂ¼klenmiÃÂ ÃÂ¶ÃÂrenci bulunamad�!' });
    }
    
    console.log(`\nÃ°ÂÂÂ± WHATSAPP BÃÂ°LDÃÂ°RÃÂ°MLERÃÂ° GÃÂNDERÃÂ°LÃÂ°YOR`);
    console.log(`   S�nav: ${sinav.ad}`);
    console.log(`   Toplam katÃÂ±lÃÂ±mcÃÂ±: ${katilimcilar.length}\n`);
    
    let basarili = 0;
    let basarisiz = 0;
    
    // Her ÃÂ¶ÃÂrenci iÃÂ§in veli telefonuna bildirim gÃÂ¶nder
    for (const katilimci of katilimcilar) {
      // Veli telefonu ÃÂ¶ncelikli, yoksa ÃÂ¶ÃÂrenci telefonu
      const telefon = katilimci.veli_telefon || katilimci.ogrenci_telefon;
      
      console.log(`   Ã°ÂÂÂ ${katilimci.ogrenci_adi} (Veli: ${katilimci.veli_adi || 'Bilinmiyor'}) Ã¢ÂÂ ${telefon || 'TELEFON YOK'}`);
      
      if (!telefon) {
        console.log(`   Ã¢ÂÂ Ã¯Â¸Â ${katilimci.ogrenci_adi} - Telefon numarasÃÂ± yok!`);
        basarisiz++;
        continue;
      }
      
      // WhatsApp mesajÃÂ±nÃÂ± olu�tur
      const mesaj = `Ã°ÂÂÂ S�nav Sonucu AÃÂ§ÃÂ±klandÃÂ±

SayÃÂ±n ${katilimci.veli_adi || 'Veli'},

${katilimci.ogrenci_adi} ÃÂ¶ÃÂrencinizin s�nav sonucu aÃÂ§ÃÂ±klanmÃÂ±ÃÂtÃÂ±r.

Ã°ÂÂÂ S�nav: ${sinav.ad}
Ã°ÂÂÂ Tarih: ${new Date(sinav.tarih).toLocaleDateString('tr-TR')}

Ã°ÂÂÂ¥ Sonucu gÃÂ¶rÃÂ¼ntÃÂ¼lemek iÃÂ§in sisteme giriÃÂ yapÃÂ±n:
Ã°ÂÂÂ ${req.protocol}://${req.get('host')}/login

Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
Ã°ÂÂÂ« S�nav Merkezi`;
      
      // WhatsApp gÃÂ¶nder
      const result = await whatsappBildirimGonder(
        telefon,
        mesaj,
        'sinav_sonuc'
      );
      
      if (result.success) {
        console.log(`   Ã¢ÂÂ ${katilimci.ogrenci_adi} - ${telefon}`);
        basarili++;
        
        // Bildirim durumunu gÃÂ¼ncelle
        await dbRun(
          'UPDATE sinav_katilimcilari SET sonuc_durumu = ?, whatsapp_gonderim_tarihi = datetime("now") WHERE id = ?',
          ['bildirildi', katilimci.id]
        );
      } else {
        console.log(`   Ã¢ÂÂ ${katilimci.ogrenci_adi} - ${telefon} - ${result.message}`);
        basarisiz++;
      }
      
      // API rate limit iÃÂ§in kÃÂ¼ÃÂ§ÃÂ¼k gecikme
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\nÃ¢ÂÂ Bildirim gÃÂ¶nderimi tamamlandÃÂ±!`);
    console.log(`   BaÃÂarÃÂ±lÃÂ±: ${basarili}`);
    console.log(`   BaÃÂarÃÂ±sÃÂ±z: ${basarisiz}`);
    
    res.json({ 
      success: true, 
      message: `${basarili} bildirim gÃÂ¶nderildi, ${basarisiz} baÃÂarÃÂ±sÃÂ±z.`,
      basarili: basarili,
      basarisiz: basarisiz
    });
    
  } catch (error) {
    console.error('WhatsApp bildirim hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bildirim gÃÂ¶nderilirken bir hata olu�tu!' });
  }
});

// Veli - S�nav Sonu�lar�
app.get('/veli/sinav-sonuclari', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log(`\nÃ°ÂÂÂ SINAV SONUÃÂLARI (Veli ID: ${req.session.userId}, Username: ${req.session.username})`);
    
    // 1. Veli'nin kendi eklediÃÂi ÃÂ¶ÃÂrenciler (ogrenciler tablosu)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`   Veli ekledi: ${veliOgrencileri.length} ÃÂ¶ÃÂrenci`);
    
    // 2. Kurum tarafÃÂ±ndan eklenen ÃÂ¶ÃÂrenciler (TC eÃÂleÃÂmesi ile)
    const kurumOgrencileri = await dbAll(`
      SELECT 
        id,
        ogrenci_adi_soyadi as ad_soyad,
        sinif,
        tc_kimlik_no as tc_no,
        telefon,
        'kurum' as kaynak
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = ?
    `, [req.session.username]);
    console.log(`   Kurum ekledi: ${kurumOgrencileri.length} ÃÂ¶ÃÂrenci (TC eÃÂleÃÂtirme)`);
    
    // 3. ÃÂ°ki listeyi birleÃÂtir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    console.log(`   Ã°ÂÂÂ TOPLAM: ${ogrenciler.length} ÃÂ¶ÃÂrenci`);
    
    if (ogrenciler.length === 0) {
      return res.render('veli/sinav-sonuclari', {
        user: { username: req.session.username, type: req.session.userType },
        sonuclar: [],
        ogrenciler: [],
        error: 'HenÃÂ¼z ÃÂ¶ÃÂrenci kaydÃÂ±nÃÂ±z bulunmuyor.',
        success: req.session.success
      });
    }
    
    // Veli'nin kendi eklediÃÂi ÃÂ¶ÃÂrencilerin sonu�lar� (ogrenciler tablosu)
    const veliSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.sinav_id,
        sk.ogrenci_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        'veli' as kaynak,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        s.sinav_durumu,
        o.ad_soyad as ogrenci_adi_soyadi,
        o.sinif as ogrenci_sinif
      FROM sinav_katilimcilari sk
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id
      WHERE sk.ogrenci_kaynak = 'veli'
        AND o.veli_id = ?
        AND s.sonuc_yayinlandi = 1
        AND sk.pdf_path IS NOT NULL
    `, [req.session.userId]);
    
    console.log(`   Ã¢ÂÂ Veli ekledi: ${veliSonuclari.length} sonuÃÂ§`);
    
    // Kurum tarafÃÂ±ndan eklenen ÃÂ¶ÃÂrencilerin sonu�lar� (ogrenci_kayitlari tablosu)
    const kurumSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.sinav_id,
        sk.ogrenci_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        'kurum' as kaynak,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif,
        s.ders,
        s.sinav_durumu,
        ok.ogrenci_adi_soyadi,
        ok.sinif as ogrenci_sinif
      FROM sinav_katilimcilari sk
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id
      WHERE sk.ogrenci_kaynak = 'kurum'
        AND REPLACE(CAST(ok.tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
        AND s.sonuc_yayinlandi = 1
        AND sk.pdf_path IS NOT NULL
    `, [req.session.userId]);
    
    console.log(`   Ã¢ÂÂ Kurum ekledi: ${kurumSonuclari.length} sonuÃÂ§`);
    
    // ÃÂ°ki kaynaÃÂÃÂ± birleÃÂtir
    const sonuclar = [...veliSonuclari, ...kurumSonuclari].sort((a, b) => {
      return new Date(b.sinav_tarihi) - new Date(a.sinav_tarihi);
    });
    
    console.log(`   Ã°ÂÂÂ Toplam: ${sonuclar.length} sonuÃÂ§`);
    
    res.render('veli/sinav-sonuclari', {
      user: { username: req.session.username, type: req.session.userType },
      sonuclar: sonuclar,
      ogrenciler: ogrenciler,
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('S�nav sonu�lar� hatasÃÂ±:', error);
    req.session.error = 'S�nav sonu�lar� y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - S�nav SonuÃÂ§ PDF ÃÂ°ndir
app.get('/veli/sinav-sonuc-indir/:katilimciId', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const katilimciId = req.params.katilimciId;
    
    // ÃÂnce ogrenci_kaynak'a bak
    const katilimciBilgi = await dbGet('SELECT ogrenci_kaynak, ogrenci_id, pdf_path FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    
    if (!katilimciBilgi) {
      return res.status(404).send('SonuÃÂ§ bulunamad�!');
    }
    
    let yetkiVar = false;
    
    // Kaynak'a gÃÂ¶re yetki kontrolÃÂ¼
    if (katilimciBilgi.ogrenci_kaynak === 'veli') {
      // Veli'nin kendi eklediÃÂi ÃÂ¶ÃÂrenci
      const ogrenci = await dbGet('SELECT veli_id FROM ogrenciler WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && ogrenci.veli_id === req.session.userId;
    } else {
      // Kurum ekledi, veli telefonuyla kontrol
      const user = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      const ogrenci = await dbGet('SELECT veli_telefon FROM ogrenci_kayitlari WHERE id = ?', [katilimciBilgi.ogrenci_id]);
      yetkiVar = ogrenci && user && user.telefon === ogrenci.veli_telefon;
    }
    
    if (!yetkiVar) {
      return res.status(403).send('Bu sonuca eri�im yetkiniz yok!');
    }
    
    // PDF var mÃÂ± kontrol et
    if (!katilimciBilgi.pdf_path || !fs.existsSync(katilimciBilgi.pdf_path)) {
      return res.status(404).send('PDF dosyasÃÂ± bulunamad�!');
    }
    
    // PDF indirme kaydÃÂ±nÃÂ± gÃÂ¼ncelle
    const simdi = new Date().toISOString();
    await dbRun(`
      UPDATE sinav_katilimcilari 
      SET 
        pdf_goruldu = 1,
        pdf_gorunme_tarihi = ?,
        pdf_indirilme_sayisi = COALESCE(pdf_indirilme_sayisi, 0) + 1
      WHERE id = ?
    `, [simdi, katilimciId]);
    
    console.log(`\nÃ°ÂÂÂ¥ PDF ÃÂ°NDÃÂ°RME KAYDI`);
    console.log(`   KatÃÂ±lÃÂ±mcÃÂ± ID: ${katilimciId}`);
    console.log(`   Tarih: ${simdi}`);
    console.log(`   Veli ID: ${req.session.userId}`);
    
    // PDF'i indir
    res.download(katilimciBilgi.pdf_path, path.basename(katilimciBilgi.pdf_path), (err) => {
      if (err) {
        console.error('PDF indirme hatasÃÂ±:', err);
        res.status(500).send('PDF indirilemedi!');
      }
    });
    
  } catch (error) {
    console.error('PDF indirme hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Veli Profil
app.get('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // Talep edilen s�navlarÃÂ± getir
    const talepEdilenSinavlar = await dbAll(`
      SELECT 
        s.*,
        st.durum,
        st.talep_tarihi,
        st.yanitlanma_tarihi,
        st.yanit,
        COUNT(DISTINCT o.id) as ogrenci_sayisi
      FROM sinav_talepleri st
      INNER JOIN sinavlar s ON st.sinav_id = s.id
      LEFT JOIN ogrenciler o ON o.veli_id = ?
      WHERE st.veli_id = ?
      GROUP BY s.id, st.id
      ORDER BY st.talep_tarihi DESC
    `, [req.session.userId, req.session.userId]);
    
    // Login hatalarÃÂ±nÃÂ± filtrele - sadece profil ile ilgili hatalarÃÂ± gÃÂ¶ster
    let error = req.session.error;
    if (error && (error.includes('Kullan�c� ad� veya �ifre') || error.includes('�ifre hatalÃÂ±'))) {
      error = null; // Login hatalarÃÂ±nÃÂ± gÃÂ¶sterme
    }
    
    res.render('veli_profil', {
      user: { username: req.session.username, type: req.session.userType },
      kullanici: kullanici,
      talepEdilenSinavlar: talepEdilenSinavlar,
      error: error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Profil hatasÃÂ±:', error);
    req.session.error = 'Profil y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli Profil GÃÂ¼ncelleme
app.post('/veli/profil', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, telefon, current_password, new_password } = req.body;
    
    if (!ad_soyad) {
      req.session.error = 'Ad Soyad alan� zorunludur';
      res.redirect('/veli/profil');
      return;
    }
    
    // ÃÂifre de�i�tirme kontrolÃÂ¼
    if (new_password && new_password.trim() !== '') {
      if (!current_password || current_password.trim() === '') {
        req.session.error = 'ÃÂifre de�i�tirmek iÃÂ§in mevcut �ifrenizi girmelisiniz!';
        res.redirect('/veli/profil');
        return;
      }
      
      if (new_password.length < 6) {
        req.session.error = 'Yeni �ifre en az 6 karakter olmal�d�r!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Mevcut �ifreyi kontrol et
      const kullanici = await dbGet('SELECT password_hash FROM users WHERE id = ?', [req.session.userId]);
      const sifreDogruMu = await bcrypt.compare(current_password, kullanici.password_hash);
      
      if (!sifreDogruMu) {
        req.session.error = 'Mevcut �ifreniz yanlÃÂ±ÃÂ!';
        res.redirect('/veli/profil');
        return;
      }
      
      // Yeni �ifreyi hashle
      const yeniSifreHash = await bcrypt.hash(new_password, 10);
      
      // Profil ve �ifreyi gÃÂ¼ncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ?, password_hash = ? WHERE id = ?',
        [ad_soyad, telefon, yeniSifreHash, req.session.userId]
      );
      
      console.log(`Ã¢ÂÂ Veli �ifre deÃÂiÃÂtirdi: User ID ${req.session.userId}`);
      req.session.success = 'Profil bilgileriniz ve �ifreniz ba�ar�yla g�ncellendi!';
    } else {
      // Sadece profil bilgilerini gÃÂ¼ncelle
      await dbRun(
        'UPDATE users SET ad_soyad = ?, telefon = ? WHERE id = ?',
        [ad_soyad, telefon, req.session.userId]
      );
      
      req.session.success = 'Profil bilgileriniz ba�ar�yla g�ncellendi!';
    }
    
    res.redirect('/veli/profil');
  } catch (error) {
    console.error('Profil gÃÂ¼ncelleme hatasÃÂ±:', error);
    req.session.error = 'Profil g�ncellenirken bir hata olu�tu!';
    res.redirect('/veli/profil');
  }
});

// Veli - ��renci Ekle (GET)
app.get('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    res.render('veli_ogrenci_ekle', {
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('��renci ekle sayfasÃÂ± hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - ��renci Ekle (POST)
app.post('/veli/ogrenci-ekle', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    
    console.log('��renci ekleme isteÃÂi:', { ad_soyad, tc_no, telefon, okul, sinif, veli_id: req.session.userId });
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = '��renci ad� soyad�, okul ve sÃÂ±nÃÂ±f zorunludur!';
      res.redirect('/veli/ogrenci-ekle');
      return;
    }
    
    // ��renci numarasÃÂ± olu�tur
    const ogrenciNo = await generateOgrenciNo();
    
    // ��renci ekle
    const result = await dbRun(
      'INSERT INTO ogrenciler (ad_soyad, tc_no, telefon, okul, sinif, veli_id, ogrenci_no) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ad_soyad, tc_no, telefon, okul, sinif, req.session.userId, ogrenciNo]
    );
    
    console.log('��renci eklendi! ID:', result.lastID, '��renci No:', ogrenciNo);
    
    req.session.success = `${ad_soyad} ba�ar�yla eklendi! ��renci No: ${ogrenciNo}`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('��renci ekleme hatasÃÂ±:', error);
    req.session.error = '��renci eklenirken bir hata olu�tu: ' + error.message;
    res.redirect('/veli/ogrenci-ekle');
  }
});

// Veli - ��renci DÃÂ¼zenle (GET)
app.get('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [req.params.id, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = '��renci bulunamad�!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // Bu ÃÂ¶ÃÂrenciye yetki verilmiÃÂ rehber ÃÂ¶ÃÂretmenleri getir
    const rehberOgretmenler = await dbAll(`
      SELECT 
        t.id as talep_id, 
        t.created_at, 
        t.sonuc_goruntuleme_aktif,
        u.id as ogretmen_id, 
        u.ad_soyad, 
        u.kurum, 
        u.brans, 
        u.telefon
      FROM ogrenci_talepleri t
      INNER JOIN users u ON t.rehber_ogretmen_id = u.id
      WHERE t.ogrenci_id = ? AND t.durum = 'onaylandi'
      ORDER BY t.created_at DESC
    `, [req.params.id]);
    
    res.render('veli_ogrenci_duzenle', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenci: ogrenci,
      rehberOgretmenler: rehberOgretmenler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('��renci dÃÂ¼zenle sayfasÃÂ± hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - ��renci DÃÂ¼zenle (POST)
app.post('/veli/ogrenci-duzenle/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { ad_soyad, tc_no, telefon, okul, sinif } = req.body;
    const ogrenciId = req.params.id;
    
    // ��rencinin bu veliye ait olduÃÂunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = '��renci bulunamad� veya size ait deÃÂil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    if (!ad_soyad || !okul || !sinif) {
      req.session.error = '��renci ad� soyad�, okul ve sÃÂ±nÃÂ±f zorunludur!';
      res.redirect(`/veli/ogrenci-duzenle/${ogrenciId}`);
      return;
    }
    
    // ��renci gÃÂ¼ncelle
    await dbRun(
      'UPDATE ogrenciler SET ad_soyad = ?, tc_no = ?, telefon = ?, okul = ?, sinif = ? WHERE id = ? AND veli_id = ?',
      [ad_soyad, tc_no, telefon, okul, sinif, ogrenciId, req.session.userId]
    );
    
    req.session.success = `${ad_soyad} ba�ar�yla g�ncellendi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('��renci gÃÂ¼ncelleme hatasÃÂ±:', error);
    req.session.error = '��renci g�ncellenirken bir hata olu�tu!';
    res.redirect(`/veli/ogrenci-duzenle/${req.params.id}`);
  }
});

// Veli - Rehber ÃÂÃÂretmen Yetkisini KaldÃÂ±r
app.post('/veli/rehber-yetki-kaldir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    console.log('Ã°ÂÂÂÃ¯Â¸Â  Yetki kaldÃÂ±rma isteÃÂi:', { talepId, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduÃÂunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    console.log('Ã°ÂÂÂ Talep bulundu:', talep);
    
    if (!talep || talep.veli_id !== req.session.userId) {
      console.log('Ã¢ÂÂ Yetki kontrolÃÂ¼ baÃÂarÃÂ±sÃÂ±z');
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Talebi sil (yetkiyi kaldÃÂ±r)
    await dbRun('DELETE FROM ogrenci_talepleri WHERE id = ?', [talepId]);
    console.log('Ã¢ÂÂ Yetki ba�ar�yla kaldÃÂ±rÃÂ±ldÃÂ±');
    
    res.json({ success: true, message: 'Rehber ÃÂ¶ÃÂretmen yetkisi kaldÃÂ±rÃÂ±ldÃÂ±!' });
  } catch (error) {
    console.error('Ã¢ÂÂ Yetki kaldÃÂ±rma hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Veli - Rehber ÃÂÃÂretmen S�nav Sonucu GÃÂ¶rme Yetkisini DeÃÂiÃÂtir
app.post('/veli/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('Ã°ÂÂÂ SonuÃÂ§ yetkisi de�i�tirme isteÃÂi:', { talepId, yeniDurum: yeni_durum, veliId: req.session.userId });
    
    // Talebin bu veliye ait olduÃÂunu kontrol et
    const talep = await dbGet(
      'SELECT t.*, o.veli_id FROM ogrenci_talepleri t INNER JOIN ogrenciler o ON t.ogrenci_id = o.id WHERE t.id = ?',
      [talepId]
    );
    
    if (!talep || talep.veli_id !== req.session.userId) {
      return res.json({ success: false, message: 'Yetkiniz yok!' });
    }
    
    // Yetkiyi gÃÂ¼ncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`Ã¢ÂÂ S�nav sonucu gÃÂ¶rme yetkisi ${yeni_durum == 1 ? 'aÃÂ§ÃÂ±ldÃÂ±' : 'kapatÃÂ±ldÃÂ±'}`);
    res.json({ 
      success: true, 
      message: `S�nav sonucu gÃÂ¶rme yetkisi ${yeni_durum == 1 ? 'aÃÂ§ÃÂ±ldÃÂ±' : 'kapatÃÂ±ldÃÂ±'}!` 
    });
  } catch (error) {
    console.error('Yetki de�i�tirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Kurum - Rehber ÃÂÃÂretmenler Listesi (Yetki YÃÂ¶netimi)
app.get('/kurum/rehber-ogretmenler', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    // TÃÂ¼m onaylÃÂ± talepleri rehber ÃÂ¶ÃÂretmene gÃÂ¶re grupla
    const talepler = await dbAll(`
      SELECT 
        t.id as talep_id,
        t.ogrenci_id,
        t.ad_soyad,
        t.sinif,
        t.veli_id,
        t.rehber_ogretmen_id,
        t.sonuc_goruntuleme_aktif,
        u.ad_soyad as rehber_ad_soyad,
        u.brans,
        u.kurum,
        u.telefon as rehber_telefon,
        o.ad_soyad as ogrenci_veli_ad,
        o.sinif as ogrenci_sinif,
        v.ad_soyad as veli_adi
      FROM ogrenci_talepleri t
      INNER JOIN users u ON t.rehber_ogretmen_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      LEFT JOIN users v ON t.veli_id = v.id
      WHERE t.durum = 'onaylandi'
      ORDER BY u.ad_soyad ASC, o.ad_soyad ASC
    `);
    
    // Rehber ÃÂ¶ÃÂretmene gÃÂ¶re grupla
    const rehberMap = new Map();
    
    talepler.forEach(talep => {
      const rehberId = talep.rehber_ogretmen_id;
      
      if (!rehberMap.has(rehberId)) {
        rehberMap.set(rehberId, {
          rehber_id: rehberId,
          ad_soyad: talep.rehber_ad_soyad,
          brans: talep.brans,
          kurum: talep.kurum,
          telefon: talep.rehber_telefon,
          ogrenci_sayisi: 0,
          ogrenciler: []
        });
      }
      
      const rehber = rehberMap.get(rehberId);
      rehber.ogrenci_sayisi++;
      rehber.ogrenciler.push({
        talep_id: talep.talep_id,
        ad_soyad: talep.ogrenci_veli_ad || talep.ad_soyad,
        sinif: talep.ogrenci_sinif || talep.sinif,
        veli_adi: talep.veli_adi,
        sonuc_goruntuleme_aktif: talep.sonuc_goruntuleme_aktif
      });
    });
    
    const rehberOgretmenler = Array.from(rehberMap.values());
    
    res.render('kurum/rehber-ogretmenler', {
      rehberOgretmenler: rehberOgretmenler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Rehber ÃÂ¶ÃÂretmen listesi hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - Rehber ÃÂÃÂretmen S�nav Sonucu GÃÂ¶rme Yetkisini DeÃÂiÃÂtir
app.post('/kurum/rehber-sonuc-yetki-degistir/:talep_id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkiniz yok!' });
  }
  
  try {
    const talepId = req.params.talep_id;
    const { yeni_durum } = req.body;
    
    console.log('Ã°ÂÂÂ Kurum - SonuÃÂ§ yetkisi de�i�tirme:', { talepId, yeniDurum: yeni_durum });
    
    // Yetkiyi gÃÂ¼ncelle
    await dbRun(
      'UPDATE ogrenci_talepleri SET sonuc_goruntuleme_aktif = ? WHERE id = ?',
      [yeni_durum, talepId]
    );
    
    console.log(`Ã¢ÂÂ S�nav sonucu gÃÂ¶rme yetkisi ${yeni_durum == 1 ? 'aÃÂ§ÃÂ±ldÃÂ±' : 'kapatÃÂ±ldÃÂ±'}`);
    res.json({ 
      success: true, 
      message: `S�nav sonucu gÃÂ¶rme yetkisi ${yeni_durum == 1 ? 'aÃÂ§ÃÂ±ldÃÂ±' : 'kapatÃÂ±ldÃÂ±'}!` 
    });
  } catch (error) {
    console.error('Yetki de�i�tirme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu!' });
  }
});

// Veli - ��renci Sil
app.post('/veli/ogrenci-sil/:id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.id;
    
    // ��rencinin bu veliye ait olduÃÂunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = '��renci bulunamad� veya size ait deÃÂil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // ��renciyi sil
    await dbRun('DELETE FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    req.session.success = `${ogrenci.ad_soyad} ba�ar�yla silindi!`;
    res.redirect('/veli/dashboard');
  } catch (error) {
    console.error('��renci silme hatasÃÂ±:', error);
    req.session.error = '��renci silinirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - TÃÂ¼m S�nav Takvimi (TÃÂ¼m ��renciler)
app.get('/veli/tum-sinav-takvimi', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    // Velinin tÃÂ¼m ÃÂ¶ÃÂrencilerini getir (her iki tablodan)
    const veliOgrencileri = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    const kurumOgrencileri = await dbAll(`
      SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif, tc_kimlik_no as tc_no
      FROM ogrenci_kayitlari
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
    `, [req.session.userId]);
    
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    // Her ÃÂ¶ÃÂrenci iÃÂ§in s�nav takvimini getir (her iki kaynaktan)
    let tumTakvim = [];
    try {
      // Veli eklediÃÂi ÃÂ¶ÃÂrencilerin s�navlarÃÂ±
      const veliTakvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          o.ad_soyad as ogrenci_ad_soyad,
          o.ogrenci_no,
          o.id as ogrenci_id,
          sk.sonuc_durumu,
          sk.pdf_path,
          'veli' as kaynak
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
        WHERE o.veli_id = ? 
        ORDER BY s.tarih ASC
      `, [req.session.userId]);
      
      // Kurum eklediÃÂi ÃÂ¶ÃÂrencilerin s�navlarÃÂ±
      const kurumTakvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          ok.ogrenci_adi_soyadi as ogrenci_ad_soyad,
          ok.id as ogrenci_id,
          sk.sonuc_durumu,
          sk.pdf_path,
          'kurum' as kaynak
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
        WHERE REPLACE(CAST(ok.tc_kimlik_no AS TEXT), '.0', '') = (SELECT username FROM users WHERE id = ?)
        ORDER BY s.tarih ASC
      `, [req.session.userId]);
      
      tumTakvim = [...veliTakvim, ...kurumTakvim].sort((a, b) => new Date(a.tarih) - new Date(b.tarih));
      
      console.log(`\nÃ°ÂÂÂ Veli S�nav Takvimi (User ID: ${req.session.userId}):`);
      console.log(`   Veli ekledi: ${veliTakvim.length} s�nav`);
      console.log(`   Kurum ekledi: ${kurumTakvim.length} s�nav`);
      console.log(`   Toplam: ${tumTakvim.length} s�nav`);
      if (tumTakvim.length > 0) {
        tumTakvim.forEach(t => {
          console.log(`   - ${t.sinav_adi} | ${t.ogrenci_ad_soyad} | ${t.tarih} (${t.kaynak})`);
        });
      }
    } catch (error) {
      console.log('Ã¢ÂÂ S�nav takvimi sorgusu hatasÃÂ±:', error);
      tumTakvim = [];
    }
    
    res.render('veli_tum_sinav_takvimi', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenciler: ogrenciler,
      tumTakvim: tumTakvim,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Ã¢ÂÂ S�nav takvimi sayfasÃÂ± hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - S�nav Takvimi (Tek ��renci)
app.get('/veli/sinav-takvimi/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const ogrenciId = req.params.ogrenci_id;
    
    // ��rencinin bu veliye ait olduÃÂunu kontrol et
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    
    if (!ogrenci) {
      req.session.error = '��renci bulunamad� veya size ait deÃÂil!';
      res.redirect('/veli/dashboard');
      return;
    }
    
    // S�nav takvimini getir (yeni sistem)
    let takvim = [];
    try {
      takvim = await dbAll(`
        SELECT 
          s.id as sinav_id,
          s.ad as sinav_adi,
          s.tarih,
          s.sinif,
          s.aciklama,
          s.sinav_durumu,
          sk.sonuc_durumu,
          sk.pdf_path
        FROM sinav_katilimcilari sk
        INNER JOIN sinavlar s ON sk.sinav_id = s.id
        WHERE sk.ogrenci_id = ? AND sk.ogrenci_kaynak = 'veli'
        ORDER BY s.tarih ASC
      `, [ogrenciId]);
      
      console.log(`\nÃ°ÂÂÂ ��renci S�nav Takvimi (��renci ID: ${ogrenciId}):`);
      console.log(`   Toplam ${takvim.length} s�nav bulundu`);
    } catch (error) {
      console.log('Ã¢ÂÂ S�nav takvimi sorgusu hatasÃÂ±:', error);
      takvim = [];
    }
    
    res.render('veli_sinav_takvimi', {
      user: { username: req.session.username, type: req.session.userType },
      ogrenci: ogrenci,
      takvim: takvim,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Ã¢ÂÂ S�nav takvimi sayfasÃÂ± hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Bekleyen Talepler
app.get('/veli/talepler', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const talepler = await dbAll(`
      SELECT 
        t.*, 
        u.ad_soyad as rehber_adi, 
        u.kurum,
        o.ad_soyad as ogrenci_adi,
        o.ogrenci_no,
        o.okul,
        o.sinif
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.rehber_ogretmen_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      WHERE t.veli_id = ? AND t.durum = 'beklemede'
      ORDER BY t.created_at DESC
    `, [req.session.userId]);
    
    res.render('veli_talepler', {
      user: { username: req.session.username, type: req.session.userType },
      talepler: talepler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Talepler hatasÃÂ±:', error);
    req.session.error = 'Talepler y�klenirken bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// Veli - Talep Onayla/Reddet
app.post('/veli/talep/:id/:islem', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    const { id, islem } = req.params;
    
    const talep = await dbGet('SELECT * FROM ogrenci_talepleri WHERE id = ? AND veli_id = ?', [id, req.session.userId]);
    
    if (!talep) {
      req.session.error = 'Talep bulunamad�!';
      res.redirect('/veli/talepler');
      return;
    }
    
    if (islem === 'onayla') {
      // Talebi onayla - ÃÂ°liÃÂki ogrenci_talepleri tablosunda durum='onaylandi' ile saklanÃÂ±r
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['onaylandi', id]);
      
      // ��renci bilgisini al
      const ogrenci = await dbGet('SELECT ad_soyad FROM ogrenciler WHERE id = ?', [talep.ogrenci_id]);
      
      // Rehber ÃÂ¶ÃÂretmen bilgisini al
      const rehber = await dbGet('SELECT ad_soyad, brans FROM users WHERE id = ?', [talep.rehber_ogretmen_id]);
      
      req.session.success = `${ogrenci.ad_soyad} iÃÂ§in ${rehber.ad_soyad} (${rehber.brans}) rehber ÃÂ¶ÃÂretmen talebi onaylandÃÂ±!`;
    } else if (islem === 'reddet') {
      // Talebi reddet
      await dbRun('UPDATE ogrenci_talepleri SET durum = ? WHERE id = ?', ['reddedildi', id]);
      
      req.session.success = 'Talep reddedildi!';
    }
    
    res.redirect('/veli/talepler');
  } catch (error) {
    console.error('Talep iÃÂleme hatasÃÂ±:', error);
    req.session.error = 'Talep iÃÂlenirken bir hata olu�tu!';
    res.redirect('/veli/talepler');
  }
});

// Veli Dashboard
app.get('/veli/dashboard', requireAuth, requireRole('veli'), async (req, res) => {
  try {
    console.log('===========================================');
    console.log('?? DASHBOARD Y�KLEME');
    console.log('Session User ID:', req.session.userId);
    console.log('Session Username:', req.session.username);
    console.log('Session UserType:', req.session.userType);
    console.log('===========================================');
    
    // Kullan�c� bilgilerini al (telefon ve TC i�in)
    const kullanici = await dbGet('SELECT username, telefon FROM users WHERE id = ?', [req.session.userId]);
    if (!kullanici) {
      req.session.error = 'Kullan�c� bilgileri bulunamad�!';
      return res.redirect('/login');
    }
    
    // TC kimlik numaras�n� belirle: �nce username'i dene, sonra telefon'u
    let tcKimlikNo = req.session.username;
    // E�er username say�sal de�ilse veya telefon varsa, telefon'u kullan
    if (kullanici.telefon && (!/^\d+$/.test(req.session.username) || req.session.username.length !== 11)) {
      // Telefon numaras�ndan TC ��kar (telefon format�: 5XXXXXXXXX gibi)
      const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
      // E�er telefon 11 haneli ise TC olabilir
      if (telefonTemiz.length === 11) {
        tcKimlikNo = telefonTemiz;
      }
    }
    
    console.log(`?? TC Kimlik No: ${tcKimlikNo} (username: ${req.session.username}, telefon: ${kullanici.telefon})`);
    
    // 1. Veli'nin kendi ekledi�i ��renciler (ogrenciler tablosu)
    const veliOgrenciler = await dbAll('SELECT * FROM ogrenciler WHERE veli_id = ?', [req.session.userId]);
    console.log(`? Veli tablosundan ${veliOgrenciler.length} ��renci bulundu`);
    
    // 2. Kurum taraf�ndan eklenen ��renciler (TC e�le�mesi ile)
    // Hem username hem de telefon ile e�le�tir
    const kurumOgrenciler = await dbAll(`
      SELECT 
        id,
        ogrenci_adi_soyadi as ad_soyad,
        tc_kimlik_no as tc_no,
        sinif,
        'kurum' as kaynak
      FROM ogrenci_kayitlari 
      WHERE REPLACE(CAST(tc_kimlik_no AS TEXT), '.0', '') = REPLACE(?, '.0', '')
         OR (veli_telefon IS NOT NULL AND REPLACE(CAST(veli_telefon AS TEXT), '.0', '') = REPLACE(?, '.0', ''))
    `, [tcKimlikNo, kullanici.telefon ? kullanici.telefon.toString().replace(/\D/g, '') : '']);
    console.log(`? Kurum tablosundan ${kurumOgrenciler.length} ��renci bulundu (TC: ${tcKimlikNo}, Telefon: ${kullanici.telefon})`);
    
    // 3. BirleÃÂtir
    const ogrenciler = [...veliOgrenciler, ...kurumOgrenciler];
    console.log(`Ã°ÂÂÂ TOPLAM ${ogrenciler.length} ÃÂ¶ÃÂrenci`);
    
    // 4. ÃÂ°statistikler
    for (let ogrenci of ogrenciler) {
      if (ogrenci.kaynak === 'kurum') {
        // Kurum ÃÂ¶ÃÂrencisi - sinav_katilimcilari'ndan s�navlarÃÂ± al
        const katilimlar = await dbAll(`
          SELECT s.ad AS sinav_adi, s.tarih AS sinav_tarihi, sk.pdf_path
          FROM sinav_katilimcilari sk
          JOIN sinavlar s ON sk.sinav_id = s.id
          WHERE sk.ogrenci_id = ? AND sk.ogrenci_kaynak = 'kurum'
        `, [ogrenci.id]);
        
        ogrenci.pdf_sonuc_sayisi = katilimlar.filter(k => k.pdf_path).length;
        ogrenci.excel_sonuc_sayisi = 0;
        ogrenci.sinavlar = katilimlar;
      } else {
        // Veli ÃÂ¶ÃÂrencisi - eski sistem
        const pdfCount = await dbGet(
          'SELECT COUNT(*) as sayi FROM sinav_sonuclari_pdf WHERE ogrenci_id = ?',
          [ogrenci.id]
        );
        ogrenci.pdf_sonuc_sayisi = pdfCount ? pdfCount.sayi : 0;
        
        const excelCount = await dbGet(
          'SELECT COUNT(DISTINCT sinav_id) as sayi FROM sinav_sonuclari WHERE ogrenci_id = ?',
          [ogrenci.id]
        );
        ogrenci.excel_sonuc_sayisi = excelCount ? excelCount.sayi : 0;
      }
    }
    
    // Bekleyen talep sayÃÂ±sÃÂ±nÃÂ± al
    const bekleyenTalepler = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE veli_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    // YaklaÃÂan s�navlar (s�nav takvimi henÃÂ¼z kullanÃÂ±lmÃÂ±yor, boÃÂ liste gÃÂ¶nder)
    let yaklasanSinavlar = [];
    try {
      yaklasanSinavlar = await dbAll(`
        SELECT * FROM sinav_takvimi 
        WHERE tarih >= date('now') 
        ORDER BY tarih ASC 
        LIMIT 5
      `);
    } catch (sinavErr) {
      console.log('Ã¢ÂÂ Ã¯Â¸Â S�nav takvimi sorgulanamad� (henÃÂ¼z kullanÃÂ±lmÃÂ±yor)');
      yaklasanSinavlar = [];
    }
    
    console.log('Ã°ÂÂÂ Dashboard render ediliyor!');
    // Dashboard'da g�sterilecek username: Her zaman kullan�c�n�n giri� yapt��� username'i g�ster
    // Kullan�c� hangi username ile giri� yapt�ysa, o g�sterilmeli
    const displayUsername = req.session.username;
    
    res.render('veli_dashboard', { 
      user: { username: displayUsername, type: req.session.userType },
      ogrenciler: ogrenciler,
      bekleyenTalepSayisi: bekleyenTalepler ? bekleyenTalepler.sayi : 0,
      yaklasanSinavlar: yaklasanSinavlar
    });
  } catch (error) {
    console.error('Ã¢ÂÂ Dashboard HATA:', error);
    // Hata durumunda boÃÂ listelerle render et (redirect dÃÂ¶ngÃÂ¼sÃÂ¼nÃÂ¼ ÃÂ¶nlemek iÃÂ§in)
    // Kullan�c� bilgilerini tekrar al
    let displayUsername = req.session.username;
    try {
      const kullanici = await dbGet('SELECT telefon FROM users WHERE id = ?', [req.session.userId]);
      // E�er username 11 haneli bir say� de�ilse ve telefon 11 haneli ise, telefon'u g�ster
      if (!/^\d{11}$/.test(req.session.username) && kullanici && kullanici.telefon) {
        const telefonTemiz = kullanici.telefon.toString().replace(/\D/g, '');
        if (telefonTemiz.length === 11) {
          displayUsername = telefonTemiz;
        }
      }
    } catch (err) {
      console.error('Kullan�c� bilgisi al�namad�:', err);
    }
    
    res.render('veli_dashboard', { 
      user: { username: displayUsername, type: req.session.userType },
      ogrenciler: [],
      bekleyenTalepSayisi: 0,
      yaklasanSinavlar: []
    });
  }
});

// Rehber Dashboard
app.get('/rehber/dashboard', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY tarih DESC');
    
    // ÃÂ°statistikler - ONAYLANMIÃÂ ÃÂÃÂRENCÃÂ°LER
    const ogrenciSayisi = await dbGet(
      'SELECT COUNT(DISTINCT ogrenci_id) as sayi FROM ogrenci_talepleri WHERE rehber_ogretmen_id = ? AND durum = ?',
      [req.session.userId, 'onaylandi']
    );
    const veliSayisi = await dbGet(`
      SELECT COUNT(DISTINCT o.veli_id) as sayi 
      FROM ogrenciler o
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? AND t.durum = ?
    `, [req.session.userId, 'onaylandi']);
    
    // S�nav sonu�lar� sayÃÂ±sÃÂ± (onaylÃÂ± ÃÂ¶ÃÂrencilerin PDF sonu�lar�)
    const sinavSonucSayisi = await dbGet(`
      SELECT COUNT(DISTINCT sk.id) as sayi 
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_talepleri t ON sk.ogrenci_id = t.ogrenci_id AND sk.ogrenci_kaynak = 'veli'
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
    `, [req.session.userId]);
    
    // Bekleyen talepler sayÃÂ±sÃÂ±
    const bekleyenTalepSayisi = await dbGet(
      'SELECT COUNT(*) as sayi FROM ogrenci_talepleri WHERE rehber_ogretmen_id = ? AND durum = ?',
      [req.session.userId, 'beklemede']
    );
    
    res.render('rehber_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
      sinavlar: sinavlar,
      istatistikler: {
        ogrenci: ogrenciSayisi?.sayi || 0,
        veli: veliSayisi?.sayi || 0,
        sinavSonucSayisi: sinavSonucSayisi?.sayi || 0,
        bekleyenTalep: bekleyenTalepSayisi?.sayi || 0
      }
    });
  } catch (error) {
    console.error('Dashboard hatasÃÂ±:', error);
    // Sonsuz dÃÂ¶ngÃÂ¼yÃÂ¼ ÃÂ¶nlemek iÃÂ§in boÃÂ veri ile render et
    res.render('rehber_dashboard', {
      user: { username: req.session.username, type: req.session.userType },
      sinavlar: [],
      istatistikler: {
        ogrenci: 0,
        veli: 0,
        sinavSonucSayisi: 0,
        bekleyenTalep: 0
      }
    });
  }
});

// S�nav YÃÂ¼kleme
// Rehber - S�nav YÃÂ¼kleme Route'larÃÂ± KALDIRILDI (Sadece kurum yapabilir)

// Rehber ÃÂÃÂretmen - S�nav Sonu�lar�
app.get('/rehber/sinav-sonuclari', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // OnaylÃÂ± VE yetkisi aktif olan ÃÂ¶ÃÂrencilerin s�nav sonu�lar�nÃÂ± getir
    // Veli ÃÂ¶ÃÂrencileri
    const veliSonuclari = await dbAll(`
      SELECT 
        sk.id,
        sk.ogrenci_id,
        sk.sinav_id,
        sk.pdf_path,
        sk.sonuc_durumu,
        sk.pdf_goruldu,
        sk.pdf_gorunme_tarihi,
        sk.pdf_indirilme_sayisi,
        o.ad_soyad as ogrenci_ad_soyad,
        o.sinif as ogrenci_sinif,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi,
        s.sinif as sinav_sinif,
        'veli' as kaynak
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      INNER JOIN sinavlar s ON sk.sinav_id = s.id
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi'
        AND t.sonuc_goruntuleme_aktif = 1
        AND sk.pdf_path IS NOT NULL
        AND sk.pdf_path != ''
      ORDER BY s.tarih DESC, o.ad_soyad ASC
    `, [req.session.userId]);
    
    // Kurum ÃÂ¶ÃÂrencileri iÃÂ§in (ogrenci_kaynak = 'kurum' olanlar)
    // Not: Kurum ÃÂ¶ÃÂrencileri iÃÂ§in ogrenci_id NULL olabilir, bu durumda ad_soyad ile eÃÂleÃÂtirme yapÃÂ±lmalÃÂ±
    // ÃÂimdilik sadece veli ÃÂ¶ÃÂrencilerini gÃÂ¶steriyoruz
    // TODO: Kurum ÃÂ¶ÃÂrencileri iÃÂ§in sinav_katilimcilari tablosuna ogrenci_ad_soyad kolonu eklenebilir
    
    const sonuclar = veliSonuclari;
    
    res.render('rehber/sinav-sonuclari', {
      sonuclar: sonuclar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('S�nav sonu�lar� hatasÃÂ±:', error);
    req.session.error = 'S�nav sonu�lar� y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/dashboard');
  }
});

// ��renci Listesi
app.get('/rehber/ogrenciler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // VELÃÂ° ÃÂÃÂRENCÃÂ°LERÃÂ° (ogrenciler tablosundan)
    const veliOgrencileri = await dbAll(`
      SELECT 
        o.*,
        u.username as veli_username,
        u.email as veli_email,
        u.ad_soyad as veli_ad_soyad,
        u.telefon as veli_telefon,
        (SELECT COUNT(*) FROM sinav_sonuclari_pdf WHERE ogrenci_id = o.id) as pdf_sonuc_sayisi,
        (SELECT COUNT(*) FROM sinav_sonuclari WHERE ogrenci_id = o.id) as excel_sonuc_sayisi,
        'veli' as kaynak
      FROM ogrenciler o
      LEFT JOIN users u ON o.veli_id = u.id
      INNER JOIN ogrenci_talepleri t ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ? AND t.durum = 'onaylandi'
      ORDER BY o.ad_soyad ASC
    `, [req.session.userId]);
    
    // KURUM ÃÂÃÂRENCÃÂ°LERÃÂ° (ogrenci_kayitlari tablosundan - ogrenci_id NULL olanlar)
    const kurumTalepleri = await dbAll(`
      SELECT DISTINCT
        t.ad_soyad,
        t.veli_id,
        t.sinif,
        t.okul
      FROM ogrenci_talepleri t
      WHERE t.rehber_ogretmen_id = ? 
        AND t.durum = 'onaylandi' 
        AND t.ogrenci_id IS NULL
    `, [req.session.userId]);
    
    const kurumOgrencileri = [];
    for (const talep of kurumTalepleri) {
      // Veli bilgisini al
      const veli = talep.veli_id ? await dbGet('SELECT ad_soyad, telefon, email, username FROM users WHERE id = ?', [talep.veli_id]) : null;
      
      kurumOgrencileri.push({
        id: null,
        ad_soyad: talep.ad_soyad,
        tc_no: null,
        sinif: talep.sinif,
        okul: talep.okul || '',
        telefon: null,
        ogrenci_no: '',
        veli_id: talep.veli_id,
        veli_ad_soyad: veli?.ad_soyad || null,
        veli_telefon: veli?.telefon || null,
        veli_username: veli?.username || null,
        veli_email: veli?.email || null,
        pdf_sonuc_sayisi: 0,
        excel_sonuc_sayisi: 0,
        kaynak: 'kurum'
      });
    }
    
    // BirleÃÂtir
    const ogrenciler = [...veliOgrencileri, ...kurumOgrencileri];
    
    res.render('ogrenci_listesi', { 
      user: { username: req.session.username },
      ogrenciler: ogrenciler
    });
  } catch (error) {
    console.error('��renci listesi hatasÃÂ±:', error);
    req.session.error = '��renci listesi y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/dashboard');
  }
});

// ��renci Detay/Profil
app.get('/rehber/ogrenci/:ogrenci_id', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // ��renci bilgileri - VELÃÂ° TARAFINDAN ONAYLANMIÃÂ MI KONTROL ET
    const onay = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenciId, req.session.userId, 'onaylandi']
    );
    
    if (!onay) {
      req.session.error = '��renci bulunamad� veya size ait deÃÂil!';
      return res.redirect('/rehber/ogrenciler');
    }
    
    const ogrenci = await dbGet(`
      SELECT 
        o.*,
        u.username as veli_username,
        u.email as veli_email
      FROM ogrenciler o
      LEFT JOIN users u ON o.veli_id = u.id
      WHERE o.id = ?
    `, [ogrenciId]);
    
    if (!ogrenci) {
      req.session.error = '��renci bulunamad�!';
      return res.redirect('/rehber/ogrenciler');
    }
    
    // PDF s�nav sonu�lar�
    const pdfSonuclari = await dbAll(`
      SELECT * FROM sinav_sonuclari_pdf
      WHERE ogrenci_id = ?
      ORDER BY sinav_tarihi DESC, created_at DESC
    `, [ogrenciId]);
    
    // Excel/CSV s�nav sonu�lar�
    const excelSonuclari = await dbAll(`
      SELECT 
        ss.*,
        s.ad as sinav_adi,
        s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY s.tarih DESC
    `, [ogrenciId]);
    
    res.render('ogrenci_detay', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      pdf_sonuclari: pdfSonuclari,
      excel_sonuclari: excelSonuclari
    });
  } catch (error) {
    console.error('��renci detay hatasÃÂ±:', error);
    req.session.error = '��renci bilgileri y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/ogrenciler');
  }
});

// Rehber ÃÂÃÂretmen Profili
app.get('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const kullanici = await dbGet('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    
    // BaÃÂka sayfalardan gelen hatalarÃÂ± filtrele - sadece profil ile ilgili hatalarÃÂ± gÃÂ¶ster
    let error = req.session.error;
    if (error && (
      error.includes('Kullan�c� ad� veya �ifre') || 
      error.includes('�ifre hatalÃÂ±') ||
      error.includes('Veli listesi y�klenirken') ||
      error.includes('��renci listesi y�klenirken') ||
      error.includes('S�nav sonu�lar� y�klenirken')
    )) {
      error = null; // BaÃÂka sayfalardan gelen hatalarÃÂ± gÃÂ¶sterme
    }
    
    res.render('rehber_profil', {
      user: { username: req.session.username },
      kullanici: kullanici,
      error: error,
      success: req.session.success
    });
    
    // Session'daki error ve success'i temizle
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Profil hatasÃÂ±:', error);
    req.session.error = 'Profil y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/dashboard');
  }
});

// Profil GÃÂ¼ncelleme
app.post('/rehber/profil', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { ad_soyad, kurum, telefon, brans, mezuniyet } = req.body;
    
    // Zorunlu alanlarÃÂ± kontrol et
    if (!ad_soyad || !kurum || !telefon || !brans) {
      req.session.error = 'LÃÂ¼tfen tÃÂ¼m zorunlu alanlarÃÂ± doldurun (Ad Soyad, Kurum, Telefon, BranÃÂ)';
      res.redirect('/rehber/profil');
      return;
    }
    
    await dbRun(
      'UPDATE users SET ad_soyad = ?, kurum = ?, telefon = ?, brans = ?, mezuniyet = ? WHERE id = ?',
      [ad_soyad, kurum, telefon, brans, mezuniyet, req.session.userId]
    );
    
    req.session.success = 'Profil bilgileriniz ba�ar�yla g�ncellendi!';
    res.redirect('/rehber/profil');
  } catch (error) {
    console.error('Profil gÃÂ¼ncelleme hatasÃÂ±:', error);
    req.session.error = 'Profil g�ncellenirken bir hata olu�tu!';
    res.redirect('/rehber/profil');
  }
});

// Veli ÃÂ°letiÃÂim Listesi
app.get('/rehber/veliler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    // Sadece onaylanmÃÂ±ÃÂ ÃÂ¶ÃÂrencilerin velilerini gÃÂ¶ster
    // ÃÂnce veli ID'lerini al
    const veliIds = await dbAll(`
      SELECT DISTINCT t.veli_id
      FROM ogrenci_talepleri t
      WHERE t.rehber_ogretmen_id = ?
        AND t.durum = 'onaylandi'
        AND t.veli_id IS NOT NULL
    `, [req.session.userId]);
    
    if (veliIds.length === 0) {
      return res.render('veli_listesi', {
        user: { username: req.session.username },
        veliler: []
      });
    }
    
    // Her veli iÃÂ§in bilgileri ve ÃÂ¶ÃÂrenci sayÃÂ±sÃÂ±nÃÂ± al
    const veliler = [];
    for (const veliIdRow of veliIds) {
      const veliId = veliIdRow.veli_id;
      
      // Veli bilgilerini al
      const veli = await dbGet('SELECT id, username, ad_soyad, email, telefon, created_at FROM users WHERE id = ? AND user_type = ?', [veliId, 'veli']);
      
      if (!veli) continue;
      
      // ��renci sayÃÂ±sÃÂ±nÃÂ± al
      const ogrenciSayisi = await dbGet(`
        SELECT COUNT(DISTINCT CASE WHEN t.ogrenci_id IS NOT NULL THEN t.ogrenci_id ELSE NULL END) as sayi
        FROM ogrenci_talepleri t
        WHERE t.veli_id = ?
          AND t.rehber_ogretmen_id = ?
          AND t.durum = 'onaylandi'
      `, [veliId, req.session.userId]);
      
      // ��renci isimlerini al
      const ogrenciIsimleri = await dbAll(`
        SELECT DISTINCT CASE 
          WHEN t.ogrenci_id IS NOT NULL THEN o.ad_soyad 
          ELSE t.ad_soyad 
        END as isim
        FROM ogrenci_talepleri t
        LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
        WHERE t.veli_id = ?
          AND t.rehber_ogretmen_id = ?
          AND t.durum = 'onaylandi'
      `, [veliId, req.session.userId]);
      
      // GeÃÂ§ersiz email ve telefon formatlarÃÂ±nÃÂ± filtrele
      let email = veli.email;
      if (email && (email.includes('@temp.com') || email.includes('.0@') || email.match(/^\d+\.0@/))) {
        email = null; // GeÃÂ§ersiz email'leri gÃÂ¶sterme
      }
      
      let telefon = veli.telefon;
      if (telefon && (telefon.toString().endsWith('.0') || telefon.toString().includes('.0@'))) {
        telefon = null; // GeÃÂ§ersiz telefon formatlarÃÂ±nÃÂ± gÃÂ¶sterme
      }
      
      veliler.push({
        id: veli.id,
        username: veli.username,
        ad_soyad: veli.ad_soyad,
        email: email,
        telefon: telefon,
        created_at: veli.created_at,
        ogrenci_sayisi: ogrenciSayisi?.sayi || 0,
        ogrenci_isimleri: ogrenciIsimleri.map(o => o.isim).filter(Boolean).join(', ')
      });
    }
    
    // Ad soyad'a gÃÂ¶re sÃÂ±rala
    veliler.sort((a, b) => {
      const aAd = (a.ad_soyad || a.username || '').toLowerCase();
      const bAd = (b.ad_soyad || b.username || '').toLowerCase();
      return aAd.localeCompare(bAd);
    });
    
    res.render('veli_listesi', {
      user: { username: req.session.username },
      veliler: veliler || []
    });
  } catch (error) {
    console.error('Veli listesi hatasÃÂ±:', error);
    req.session.error = 'Veli listesi y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber ÃÂÃÂretmen - Gelen Talepler
app.get('/rehber/talepler', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const talepler = await dbAll(`
      SELECT 
        t.*,
        u.ad_soyad as veli_ad_soyad,
        u.telefon as veli_telefon,
        u.email as veli_email,
        o.ad_soyad as ogrenci_ad_soyad,
        o.sinif as ogrenci_sinif,
        o.okul as ogrenci_okul
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      LEFT JOIN ogrenciler o ON t.ogrenci_id = o.id
      WHERE t.rehber_ogretmen_id = ?
      ORDER BY 
        CASE t.durum
          WHEN 'beklemede' THEN 1
          WHEN 'onaylandi' THEN 2
          WHEN 'reddedildi' THEN 3
        END,
        t.created_at DESC
    `, [req.session.userId]);
    
    res.render('rehber/talepler', {
      talepler: talepler,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Rehber talep listesi hatasÃÂ±:', error);
    req.session.error = 'Talep listesi y�klenirken bir hata olu�tu!';
    res.redirect('/rehber/dashboard');
  }
});

// Rehber ÃÂÃÂretmen - Talep YanÃÂ±tla (Onayla/Reddet)
app.post('/rehber/talep-yanitla', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    const { talep_id, durum, yanit } = req.body;
    
    if (!talep_id || !durum || !['onaylandi', 'reddedildi'].includes(durum)) {
      return res.json({ success: false, message: 'GeÃÂ§ersiz parametreler!' });
    }
    
    // Talebin bu rehber ÃÂ¶ÃÂretmene ait olduÃÂunu kontrol et
    const talep = await dbGet(`
      SELECT t.*, u.telefon as veli_telefon, u.ad_soyad as veli_ad_soyad
      FROM ogrenci_talepleri t
      LEFT JOIN users u ON t.veli_id = u.id
      WHERE t.id = ? AND t.rehber_ogretmen_id = ?
    `, [talep_id, req.session.userId]);
    
    if (!talep) {
      return res.json({ success: false, message: 'Talep bulunamad� veya size ait deÃÂil!' });
    }
    
    // Talebi gÃÂ¼ncelle
    await dbRun(`
      UPDATE ogrenci_talepleri 
      SET durum = ?, mesaj = ?
      WHERE id = ? AND rehber_ogretmen_id = ?
    `, [durum, yanit || '', talep_id, req.session.userId]);
    
    // WhatsApp bildirimi gÃÂ¶nder (arka planda)
    if (talep.veli_telefon) {
      const mesaj = durum === 'onaylandi' 
        ? `Ã¢ÂÂ TALEBÃÂ°NÃÂ°Z ONAYLANDI!\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
          `Rehber ÃÂ¶ÃÂretmen talebinizi onaylad�.\n\n` +
          `Ã°ÂÂÂ¤ ��renci: ${talep.ad_soyad}\n` +
          (yanit ? `Ã°ÂÂÂ¬ Rehber ÃÂÃÂretmen YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
          `ArtÃÂ±k rehber ÃÂ¶ÃÂretmen ÃÂ¶ÃÂrenciniz hakkÃÂ±nda bilgilere eriÃÂebilecektir.`
        : `Ã¢ÂÂ TALEBÃÂ°NÃÂ°Z REDDEDÃÂ°LDÃÂ°\n\n` +
          `Merhaba ${talep.veli_ad_soyad || 'DeÃÂerli Velimiz'},\n\n` +
          `Rehber ÃÂ¶ÃÂretmen talebinizi reddetti.\n\n` +
          `Ã°ÂÂÂ¤ ��renci: ${talep.ad_soyad}\n` +
          (yanit ? `Ã°ÂÂÂ¬ Rehber ÃÂÃÂretmen YanÃÂ±tÃÂ±: ${yanit}\n\n` : '') +
          `Daha fazla bilgi iÃÂ§in lÃÂ¼tfen rehber ÃÂ¶ÃÂretmen ile iletiÃÂime geÃÂ§iniz.`;
      
      whatsappBildirimGonder(talep.veli_telefon, mesaj, `rehber_talep_${durum}`)
        .then(result => console.log('Ã¢ÂÂ Veli WhatsApp bildirimi gÃÂ¶nderildi:', result))
        .catch(error => console.error('Ã¢ÂÂ Veli WhatsApp bildirimi hatasÃÂ±:', error));
    }
    
    res.json({ 
      success: true, 
      message: durum === 'onaylandi' ? 'Talep ba�ar�yla onaylandÃÂ±!' : 'Talep reddedildi.' 
    });
    
  } catch (error) {
    console.error('Rehber talep yanÃÂ±tlama hatasÃÂ±:', error);
    res.json({ success: false, message: 'Talep iÃÂlenirken bir hata olu�tu!' });
  }
});

// ��renci Ekleme - KALDIRILDI (Rehber ÃÂ¶ÃÂretmen artÃÂ±k direkt ÃÂ¶ÃÂrenci ekleyemez, sadece talep gÃÂ¶nderebilir)
// app.get('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// ��renci Arama API - KALDIRILDI (��renci ekleme ÃÂ¶zelliÃÂi kaldÃÂ±rÃÂ±ldÃÂ±)
// app.post('/rehber/ogrenci-ara', ...) - KALDIRILDI

// ��renci Ekleme Talebi GÃÂ¶nder (Rehber -> Veli) - YENÃÂ° SÃÂ°STEM
app.post('/rehber/ogrenci-talep', requireAuth, requireRole('rehber_ogretmen'), async (req, res) => {
  try {
    console.log('\nÃ°ÂÂÂ¨ TALEP GÃÂNDERME ÃÂ°STEÃÂÃÂ°:', {
      userId: req.session.userId,
      ogrenci_id: req.body.ogrenci_id
    });
    
    // Profil kontrolÃÂ¼
    const kullanici = await dbGet('SELECT ad_soyad, kurum, telefon, brans FROM users WHERE id = ?', [req.session.userId]);
    console.log('Ã°ÂÂÂ¤ Kullan�c� Profili:', kullanici);
    
    if (!kullanici.ad_soyad || !kullanici.kurum || !kullanici.telefon || !kullanici.brans) {
      console.log('Ã¢ÂÂ Profil eksik!');
      return res.json({ success: false, message: 'ÃÂnce profil bilgilerinizi eksiksiz doldurmalÃÂ±sÃÂ±nÃÂ±z!' });
    }
    
    const { ogrenci_id } = req.body;
    
    if (!ogrenci_id) {
      console.log('Ã¢ÂÂ ��renci ID eksik!');
      return res.json({ success: false, message: '��renci ID eksik' });
    }
    
    // ��renciyi bul
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ?', [ogrenci_id]);
    console.log('Ã°ÂÂÂ¨Ã¢ÂÂÃ°ÂÂÂ ��renci:', ogrenci);
    
    if (!ogrenci) {
      console.log('Ã¢ÂÂ ��renci bulunamad�!');
      return res.json({ success: false, message: '��renci bulunamad�' });
    }
    
    // Zaten onaylanmÃÂ±ÃÂ mÃÂ±?
    const onayliTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'onaylandi']
    );
    console.log('Ã¢ÂÂ OnaylÃÂ± talep kontrolÃÂ¼:', onayliTalep);
    
    if (onayliTalep) {
      console.log('Ã¢ÂÂ Zaten kay�tlÃÂ±!');
      return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci zaten size kay�tlÃÂ±' });
    }
    
    // Bekleyen talep var mÃÂ± kontrol et
    const bekleyenTalep = await dbGet(
      'SELECT id FROM ogrenci_talepleri WHERE ogrenci_id = ? AND rehber_ogretmen_id = ? AND durum = ?',
      [ogrenci_id, req.session.userId, 'beklemede']
    );
    console.log('Ã¢ÂÂ³ Bekleyen talep kontrolÃÂ¼:', bekleyenTalep);
    
    if (bekleyenTalep) {
      console.log('Ã¢ÂÂ Zaten bekleyen talep var!');
      return res.json({ success: false, message: 'Bu ÃÂ¶ÃÂrenci iÃÂ§in zaten bekleyen bir talebiniz var' });
    }
    
    // Talep olu�tur (Veli onaylayacak) - BaÃÂka branÃÂta atanmÃÂ±ÃÂ olsa bile talep gÃÂ¶nderilebilir
    console.log('Ã°ÂÂÂ¾ Talep olu�turuluyor:', {
      ogrenci_id,
      ogrenci_no: ogrenci.ogrenci_no,
      ad_soyad: ogrenci.ad_soyad,
      veli_id: ogrenci.veli_id,
      rehber_ogretmen_id: req.session.userId
    });
    
    await dbRun(
      'INSERT INTO ogrenci_talepleri (ogrenci_id, ogrenci_no, ad_soyad, sinif, okul, veli_id, rehber_id, rehber_ogretmen_id, durum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ogrenci_id, ogrenci.ogrenci_no, ogrenci.ad_soyad, ogrenci.sinif, ogrenci.okul, ogrenci.veli_id, req.session.userId, req.session.userId, 'beklemede']
    );
    
    console.log('Ã¢ÂÂ Talep ba�ar�yla olu�turuldu!\n');
    
    res.json({ 
      success: true, 
      message: `${ogrenci.ad_soyad} iÃÂ§in talep veliye gÃÂ¶nderildi! Veli onaylad�ÃÂÃÂ±nda bu ÃÂ¶ÃÂrenciyi gÃÂ¶rebilirsiniz.`
    });
  } catch (error) {
    console.error('Ã¢ÂÂ Talep gÃÂ¶nderme hatasÃÂ±:', error);
    res.json({ success: false, message: `Talep hatasÃÂ±: ${error.message}` });
  }
});

// ��renci Ekleme POST - KALDIRILDI (Rehber ÃÂ¶ÃÂretmen artÃÂ±k direkt ÃÂ¶ÃÂrenci ekleyemez, sadece talep gÃÂ¶nderebilir)
// app.post('/rehber/ogrenci-ekle', ...) - KALDIRILDI

// S�nav Sonu�lar� (Excel/CSV)
app.get('/veli/sinav-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // ��renci kontrolÃÂ¼
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ÃÂ¶ÃÂrencinin sonu�lar�na eri�im yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // S�nav sonu�lar�nÃÂ± ÃÂ§ek
    const sonuclar = await dbAll(`
      SELECT ss.*, s.ad as sinav_adi, s.tarih as sinav_tarihi
      FROM sinav_sonuclari ss
      JOIN sinavlar s ON ss.sinav_id = s.id
      WHERE ss.ogrenci_id = ?
      ORDER BY ss.created_at DESC
    `, [ogrenciId]);
    
    // Sonu�lar� s�nav bazÃÂ±nda grupla ve JSON parse et
    const sinavSonuclari = {};
    sonuclar.forEach(sonuc => {
      if (!sinavSonuclari[sonuc.sinav_id]) {
        sinavSonuclari[sonuc.sinav_id] = {
          sinav: {
            id: sonuc.sinav_id,
            ad: sonuc.sinav_adi,
            tarih: sonuc.sinav_tarihi
          },
          sonuclar: []
        };
      }
      // JSON parse - backend'de yap
      let sonucVerisiParsed = {};
      if (sonuc.sonuc_verisi) {
        try {
          sonucVerisiParsed = JSON.parse(sonuc.sonuc_verisi);
        } catch(e) {
          sonucVerisiParsed = {};
        }
      }
      sinavSonuclari[sonuc.sinav_id].sonuclar.push({
        ...sonuc,
        sonuc_verisi_parsed: sonucVerisiParsed
      });
    });
    
    res.render('sinav_sonuclari', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      sinav_sonuclari: sinavSonuclari
    });
  } catch (error) {
    console.error('SonuÃÂ§ gÃÂ¶rÃÂ¼ntÃÂ¼leme hatasÃÂ±:', error);
    req.session.error = 'Bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// PDF S�nav Sonu�lar�
app.get('/veli/pdf-sonuclari/:ogrenci_id', requireAuth, requireRole('veli'), async (req, res) => {
  const ogrenciId = parseInt(req.params.ogrenci_id);
  
  try {
    // ��renci kontrolÃÂ¼
    const ogrenci = await dbGet('SELECT * FROM ogrenciler WHERE id = ? AND veli_id = ?', [ogrenciId, req.session.userId]);
    if (!ogrenci) {
      req.session.error = 'Bu ÃÂ¶ÃÂrencinin sonu�lar�na eri�im yetkiniz yok!';
      return res.redirect('/veli/dashboard');
    }
    
    // PDF s�nav sonu�lar�nÃÂ± ÃÂ§ek
    const pdfSonuclari = await dbAll(`
      SELECT * FROM sinav_sonuclari_pdf
      WHERE ogrenci_id = ?
      ORDER BY sinav_tarihi DESC, created_at DESC
    `, [ogrenciId]);
    
    res.render('pdf-sonuclari', {
      user: { username: req.session.username },
      ogrenci: ogrenci,
      pdf_sonuclari: pdfSonuclari
    });
  } catch (error) {
    console.error('PDF sonuÃÂ§ gÃÂ¶rÃÂ¼ntÃÂ¼leme hatasÃÂ±:', error);
    req.session.error = 'Bir hata olu�tu!';
    res.redirect('/veli/dashboard');
  }
});

// S�nav Takvimi SayfasÃÂ±
app.get('/sinav-takvimi', async (req, res) => {
  try {
    // TÃÂ¼m s�navlarÃÂ± getir (hem tekil hem paket s�navlarÃÂ±)
    const sinavlar = await dbAll(
      `SELECT 
        s.*,
        sp.ad as paket_adi,
        ps.paket_id
       FROM sinavlar s
       LEFT JOIN paket_sinavlari ps ON s.id = ps.sinav_id
       LEFT JOIN sinav_paketleri sp ON ps.paket_id = sp.id AND sp.aktif = 1
       ORDER BY s.tarih ASC`,
      []
    );
    
    console.log(`\nÃ°ÂÂÂ SINAV TAKVÃÂ°MÃÂ° YÃÂKLEME`);
    console.log(`   Toplam S�nav: ${sinavlar.length}`);
    console.log(`   Paket S�navlarÃÂ±: ${sinavlar.filter(s => s.paket_id).length}`);
    console.log(`   Tekil S�navlar: ${sinavlar.filter(s => !s.paket_id).length}`);
    
    res.render('sinav-takvimi', {
      title: 'S�nav Takvimi',
      user: req.session.userId ? { 
        username: req.session.username,
        type: req.session.userType 
      } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('S�nav takvimi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu: ' + error.message);
  }
});

// ESKÃÂ° S�nav Paketleri Route - KALDIRILDI (Yeni route satÃÂ±r 729'da)

// ============ DUYURU YÃÂNETÃÂ°MÃÂ° (KURUM) ============

// Kurum - Duyuru YÃÂ¶netimi SayfasÃÂ±
app.get('/kurum/duyurular', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    const duyurular = await dbAll('SELECT * FROM duyurular ORDER BY sira ASC, tarih DESC');
    
    res.render('kurum/duyurular', {
      duyurular: duyurular,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Duyuru yÃÂ¶netimi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - Duyuru Ekle (POST)
app.post('/kurum/duyuru-ekle', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz eri�im!' });
  }
  
  try {
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'BaÃÂlÃÂ±k zorunludur!' });
    }
    
    await dbRun(
      'INSERT INTO duyurular (baslik, icerik, tarih, sira, aktif) VALUES (?, ?, ?, ?, ?)',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0]
    );
    
    console.log(`\nÃ¢ÂÂ YENÃÂ° DUYURU EKLENDÃÂ°`);
    console.log(`   BaÃÂlÃÂ±k: ${baslik}`);
    
    req.session.success = 'Duyuru ba�ar�yla eklendi!';
    res.json({ success: true, message: 'Duyuru ba�ar�yla eklendi!' });
  } catch (error) {
    console.error('Duyuru ekleme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Kurum - Duyuru GÃÂ¼ncelle (POST)
app.post('/kurum/duyuru-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz eri�im!' });
  }
  
  try {
    const duyuruId = req.params.id;
    const { baslik, icerik, tarih, sira, aktif } = req.body;
    
    if (!baslik) {
      return res.json({ success: false, message: 'BaÃÂlÃÂ±k zorunludur!' });
    }
    
    await dbRun(
      'UPDATE duyurular SET baslik = ?, icerik = ?, tarih = ?, sira = ?, aktif = ? WHERE id = ?',
      [baslik, icerik || '', tarih || new Date().toISOString().split('T')[0], sira || 0, aktif ? 1 : 0, duyuruId]
    );
    
    console.log(`\nÃ¢ÂÂ DUYURU GÃÂNCELLENDÃÂ°`);
    console.log(`   ID: ${duyuruId}`);
    console.log(`   BaÃÂlÃÂ±k: ${baslik}`);
    
    req.session.success = 'Duyuru ba�ar�yla g�ncellendi!';
    res.json({ success: true, message: 'Duyuru ba�ar�yla g�ncellendi!' });
  } catch (error) {
    console.error('Duyuru gÃÂ¼ncelleme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Kurum - Duyuru Sil (POST)
app.post('/kurum/duyuru-sil/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz eri�im!' });
  }
  
  try {
    const duyuruId = req.params.id;
    
    await dbRun('DELETE FROM duyurular WHERE id = ?', [duyuruId]);
    
    console.log(`\nÃ¢ÂÂ DUYURU SÃÂ°LÃÂ°NDÃÂ°`);
    console.log(`   ID: ${duyuruId}`);
    
    req.session.success = 'Duyuru ba�ar�yla silindi!';
    res.json({ success: true, message: 'Duyuru ba�ar�yla silindi!' });
  } catch (error) {
    console.error('Duyuru silme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Duyurular Route (Genel - Herkes gÃÂ¶rebilir)
app.get('/duyurular', async (req, res) => {
  try {
    const duyurular = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM duyurular WHERE aktif = 1 ORDER BY sira ASC, tarih DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
    
    res.render('duyurular', {
      title: 'Duyurular',
      user: req.session.userId ? { type: req.session.userType } : null,
      duyurular: duyurular
    });
  } catch (error) {
    console.error('Duyurular hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// ============ KURUMSAL SAYFALAR YÃÂNETÃÂ°MÃÂ° ============

// API - Kurumsal Sayfalar Listesi (Auth gerektirmiyor - dashboard zaten korumalÃÂ±)
app.get('/api/kurumsal-sayfalar', async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    res.json({ success: true, sayfalar: sayfalar });
  } catch (error) {
    console.error('API kurumsal sayfalar hatasÃÂ±:', error);
    res.status(500).json({ success: false, message: 'Sayfalar yÃÂ¼klenemedi!', error: error.message });
  }
});

// Kurum - Kurumsal Sayfalar YÃÂ¶netimi
app.get('/kurum/kurumsal-sayfalar', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Bu sayfaya eri�im yetkiniz yok!');
  }
  
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    
    res.render('kurum/kurumsal-sayfalar', {
      sayfalar: sayfalar,
      user: { username: req.session.username, type: req.session.userType },
      error: req.session.error,
      success: req.session.success
    });
    
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('Kurumsal sayfalar yÃÂ¶netimi hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - Kurumsal Sayfa GÃÂ¼ncelle
app.post('/kurum/kurumsal-sayfa-guncelle/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, message: 'Yetkisiz eri�im!' });
  }
  
  try {
    const sayfaId = req.params.id;
    const { sayfa_adi, baslik, icerik, seo_baslik, seo_aciklama, sira, aktif } = req.body;
    
    if (!sayfa_adi || !baslik) {
      return res.json({ success: false, message: 'Sayfa ad� ve baÃÂlÃÂ±k zorunludur!' });
    }
    
    console.log('\nÃ°ÂÂÂ KURUMSAL SAYFA GÃÂNCELLEME:');
    console.log(`   ID: ${sayfaId}`);
    console.log(`   Sayfa Ad�: ${sayfa_adi}`);
    console.log(`   BaÃÂlÃÂ±k: ${baslik}`);
    console.log(`   ÃÂ°ÃÂ§erik: ${icerik ? icerik.substring(0, 100) + '...' : 'BOÃÂ'}`);
    console.log(`   ÃÂ°ÃÂ§erik UzunluÃÂu: ${icerik ? icerik.length : 0} karakter`);
    console.log(`   Aktif: ${aktif}`);
    
    await dbRun(
      `UPDATE kurumsal_sayfalar 
       SET sayfa_adi = ?, baslik = ?, icerik = ?, seo_baslik = ?, seo_aciklama = ?, 
           sira = ?, aktif = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [sayfa_adi, baslik, icerik || '', seo_baslik || '', seo_aciklama || '', sira || 0, aktif ? 1 : 0, sayfaId]
    );
    
    console.log('   Ã¢ÂÂ VERÃÂ°TABANINA KAYDEDÃÂ°LDÃÂ°!');
    
    res.json({ success: true, message: 'Sayfa ba�ar�yla g�ncellendi!' });
  } catch (error) {
    console.error('Kurumsal sayfa gÃÂ¼ncelleme hatasÃÂ±:', error);
    res.json({ success: false, message: 'Bir hata olu�tu: ' + error.message });
  }
});

// Genel - Kurumsal Sayfalar (Frontend - Dinamik)
app.get('/hakkimizda', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['hakkimizda']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamad�!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('HakkÃÂ±mÃÂ±zda hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

app.get('/iletisim', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['iletisim']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamad�!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('ÃÂ°letiÃÂim hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

app.get('/sinav-merkezleri', async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE sayfa_slug = ? AND aktif = 1', ['sinav-merkezleri']);
    
    if (!sayfa) {
      return res.status(404).send('Sayfa bulunamad�!');
    }
    
    res.render('kurumsal-sayfa', {
      title: sayfa.seo_baslik || sayfa.baslik,
      sayfa: sayfa,
      user: req.session.userId ? { type: req.session.userType } : null
    });
  } catch (error) {
    console.error('S�nav merkezleri hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// PDF Test Route (GeliÃÂtirme/Test iÃÂ§in)
app.get('/test-pdf', (req, res) => {
  res.render('test-pdf', {
    title: 'PDF Test - S�nav Sonucu Parse',
    user: req.session.userId ? { type: req.session.userType } : null
  });
});

// Test PDF Upload Route
app.post('/test-pdf-upload', pdfUpload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'LÃÂ¼tfen bir PDF dosyasÃÂ± yÃÂ¼kleyin!' });
    }

    // PDF'i oku
    const dataBuffer = fs.readFileSync(req.file.path);
    
    // PDF'i parse et
    const pdfData = await pdfParse(dataBuffer);
    
    // Text iÃÂ§eriÃÂini al
    const text = pdfData.text;
    
    // ��renci bilgilerini ÃÂ§ÃÂ±kar (regex ile)
    const ogrenciMatch = text.match(/��renci\s+Numara\s+SÃÂ±nÃÂ±f\s+([^\n]+)\s+(\d+)\s+(\w+)/);
    const puanMatch = text.match(/Ã¢ÂÂ¼\s*([\d,]+)/);
    
    // Ders detaylarÃÂ±nÃÂ± ÃÂ§ÃÂ±kar
    const dersler = [];
    const dersRegex = /(TÃÂ¼rkÃÂ§e|Tarih-1|CoÃÂrafya-1|Felsefe|Din KÃÂ¼l\. ve Ahl\. Bil\.|Fizik|Kimya|Biyoloji|TYT Fen)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d,]+)/g;
    let dersMatch;
    
    while ((dersMatch = dersRegex.exec(text)) !== null) {
      dersler.push({
        ders: dersMatch[1],
        soru: dersMatch[2],
        dogru: dersMatch[3],
        yanlis: dersMatch[4],
        net: dersMatch[5]
      });
    }
    
    const result = {
      filename: req.file.originalname,
      filepath: req.file.path,
      pageCount: pdfData.numpages,
      ogrenciBilgi: ogrenciMatch ? {
        ad: ogrenciMatch[1].trim(),
        numara: ogrenciMatch[2],
        sinif: ogrenciMatch[3]
      } : null,
      puan: puanMatch ? puanMatch[1] : null,
      dersler: dersler,
      rawText: text.substring(0, 2000) // ÃÂ°lk 2000 karakter
    };
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('PDF parse hatasÃÂ±:', error);
    res.status(500).json({ 
      success: false, 
      error: 'PDF parse edilirken hata olu�tu: ' + error.message 
    });
  }
});

// Cevap AnahtarlarÃÂ± Route
app.get('/cevap-anahtarlari', async (req, res) => {
  try {
    // Cevap anahtarÃÂ± yÃÂ¼klenmiÃÂ TÃÂM s�navlarÃÂ± al
    const sinavlar = await dbAll(
      `SELECT * FROM sinavlar 
       WHERE cevap_anahtari_pdf IS NOT NULL 
       AND cevap_anahtari_pdf != '' 
       ORDER BY tarih DESC`,
      []
    );
    
    res.render('cevap-anahtarlari', {
      title: 'Cevap AnahtarlarÃÂ±',
      user: req.session.userId ? { type: req.session.userType, username: req.session.username } : null,
      sinavlar: sinavlar
    });
  } catch (error) {
    console.error('Cevap anahtarlarÃÂ± hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Rehber - Toplu S�nav YÃÂ¼kleme KALDIRILDI (Sadece kurum yapabilir)

// GeliÃÂmiÃÂ ÃÂ¶ÃÂrenci isim eÃÂleÃÂtirme fonksiyonu
function eslesmeSkoru(isim1, isim2) {
  if (!isim1 || !isim2) return 0;
  
  // ÃÂ°simleri normalize et
  const normalize = (str) => {
    return str
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/ÃÂ±/g, 'i')
      .replace(/ÃÂ/g, 'g')
      .replace(/ÃÂ¼/g, 'u')
      .replace(/ÃÂ/g, 's')
      .replace(/ÃÂ¶/g, 'o')
      .replace(/ÃÂ§/g, 'c');
  };
  
  const n1 = normalize(isim1);
  const n2 = normalize(isim2);
  
  // Tam eÃÂleÃÂme
  if (n1 === n2) return 100;
  
  // Kelime kelime karÃÂÃÂ±laÃÂtÃÂ±r
  const kelimeler1 = n1.split(' ');
  const kelimeler2 = n2.split(' ');
  
  let eslesenKelimeSayisi = 0;
  kelimeler1.forEach(k1 => {
    if (kelimeler2.some(k2 => k2 === k1)) {
      eslesenKelimeSayisi++;
    }
  });
  
  // Skor hesapla
  const maxKelimeSayisi = Math.max(kelimeler1.length, kelimeler2.length);
  const skor = (eslesenKelimeSayisi / maxKelimeSayisi) * 100;
  
  // Levenshtein mesafesi ile ince ayar (basit yaklaÃÂÃÂ±m)
  if (skor > 50) {
    const uzunlukFarki = Math.abs(n1.length - n2.length);
    return Math.max(0, skor - uzunlukFarki * 2);
  }
  
  return skor;
}

// S�nav katÃÂ±lÃÂ±mcÃÂ±larÃÂ± iÃÂ§in ÃÂ¶zel eÃÂleÃÂtirme fonksiyonu
async function sinavKatilimciEslestir(pdfOgrenciAdi, sinavId) {
  if (!pdfOgrenciAdi || !sinavId) return null;
  
  // Sadece bu s�nava katÃÂ±lan ÃÂ¶ÃÂrencileri ÃÂ§ek
  const katilimcilar = await dbAll(`
    SELECT ok.* 
    FROM ogrenci_kayitlari ok
    INNER JOIN sinav_katilimcilari sk ON ok.id = sk.ogrenci_id
    WHERE sk.sinav_id = ?
  `, [sinavId]);
  
  if (!katilimcilar || katilimcilar.length === 0) return null;
  
  let enIyiEslesme = null;
  let enIyiSkor = 0;
  
  // ÃÂ°sim varyasyonlarÃÂ± olu�tur (Ad Soyad / Soyad Ad)
  const nameVariations = [pdfOgrenciAdi];
  const parts = pdfOgrenciAdi.trim().split(/\s+/);
  
  if (parts.length === 2) {
    // "BEREN ÃÂZCAN" Ã¢ÂÂ ["BEREN ÃÂZCAN", "ÃÂZCAN BEREN"]
    nameVariations.push(`${parts[1]} ${parts[0]}`);
  } else if (parts.length === 3) {
    // "AHMED N AR" Ã¢ÂÂ ["AHMED N AR", "AR AHMED N", "N AR AHMED"]
    nameVariations.push(`${parts[2]} ${parts[0]} ${parts[1]}`);
    nameVariations.push(`${parts[1]} ${parts[2]} ${parts[0]}`);
  }
  
  console.log(`Ã°ÂÂÂ "${pdfOgrenciAdi}" iÃÂ§in eÃÂleÃÂtirme yapÃÂ±lÃÂ±yor...`);
  console.log(`   ÃÂ°sim varyasyonlarÃÂ±:`, nameVariations);
  
  // Her katÃÂ±lÃÂ±mcÃÂ± iÃÂ§in skor hesapla
  for (const katilimci of katilimcilar) {
    const dbName = (katilimci.ogrenci_adi_soyadi || '').trim().toUpperCase();
    
    for (const variation of nameVariations) {
      const variationUpper = variation.toUpperCase();
      let skor = 0;
      
      // 1. Tam eÃÂleÃÂme (100 puan)
      if (dbName === variationUpper) {
        skor = 100;
      }
      // 2. BaÃÂlangÃÂ±ÃÂ§ eÃÂleÃÂmesi (80 puan)
      else if (dbName.startsWith(variationUpper) || variationUpper.startsWith(dbName)) {
        skor = 80;
      }
      // 3. ÃÂ°ÃÂ§erik eÃÂleÃÂmesi (60 puan)
      else if (dbName.includes(variationUpper) || variationUpper.includes(dbName)) {
        skor = 60;
      }
      // 4. Kelime bazlÃÂ± eÃÂleÃÂme (40 puan)
      else {
        const dbWords = dbName.split(/\s+/);
        const pdfWords = variationUpper.split(/\s+/);
        const matchingWords = dbWords.filter(w => pdfWords.includes(w));
        if (matchingWords.length > 0) {
          skor = 40 + (matchingWords.length * 10);
        }
      }
      
      if (skor > enIyiSkor) {
        enIyiSkor = skor;
        enIyiEslesme = katilimci;
        console.log(`   Ã¢ÂÂ Yeni en iyi eÃÂleÃÂme: "${dbName}" (Skor: ${skor})`);
      }
    }
  }
  
  // Minimum %55 eÃÂleÃÂme gerekli
  if (enIyiSkor >= 55) {
    console.log(`Ã¢ÂÂ En iyi eÃÂleÃÂme (${enIyiSkor} puan): "${enIyiEslesme.ogrenci_adi_soyadi}"`);
    return enIyiEslesme;
  } else {
    console.log(`Ã¢ÂÂ Yeterli eÃÂleÃÂme bulunamad� (en yÃÂ¼ksek: ${enIyiSkor})`);
    return null;
  }
}

async function enIyiOgrenciEslestir(pdfOgrenciAdi) {
  if (!pdfOgrenciAdi) return null;
  
  const tumOgrenciler = await dbAll('SELECT * FROM ogrenciler');
  
  let enIyiEslesme = null;
  let enYuksekSkor = 0;
  
  tumOgrenciler.forEach(ogrenci => {
    const skor = eslesmeSkoru(pdfOgrenciAdi, ogrenci.ad_soyad);
    if (skor > enYuksekSkor && skor >= 60) { // Minimum %60 eÃÂleÃÂme gerekli
      enYuksekSkor = skor;
      enIyiEslesme = ogrenci;
    }
  });
  
  return enIyiEslesme;
}

// YENÃÂ°: ÃÂ°lk Sayfa Analizi - Potansiyel ÃÂ°sim AdaylarÃÂ±
// Rehber - Toplu S�nav Analiz KALDIRILDI (Sadece kurum yapabilir)

// Rehber - Toplu S�nav YÃÂ¼kleme KALDIRILDI (Sadece kurum yapabilir)

// ============================================
// KURUMSAL ÃÂ°ÃÂERÃÂ°K YÃÂNETÃÂ°MÃÂ° (ADMIN PANEL)
// ============================================

// Kurumsal iÃÂ§erik listesi (Admin)
// DEPRECATED: Admin paneli yÃÂ¶nlendirmeleri - ArtÃÂ±k /kurum/ panelini kullanÃÂ±n
app.get('/admin/kurumsal-icerik', requireAuth, (req, res) => {
  console.log('Ã¢ÂÂ Ã¯Â¸Â ESKÃÂ° ROUTE: /admin/kurumsal-icerik Ã¢ÂÂ /kurum/kurumsal-sayfalar yÃÂ¶nlendiriliyor');
  res.redirect('/kurum/kurumsal-sayfalar');
});

app.get('/admin/kurumsal-icerik/duzenle/:id', requireAuth, (req, res) => {
  console.log(`Ã¢ÂÂ Ã¯Â¸Â ESKÃÂ° ROUTE: /admin/kurumsal-icerik/duzenle/${req.params.id} Ã¢ÂÂ /kurum/kurumsal-sayfa-duzenle/${req.params.id} yÃÂ¶nlendiriliyor`);
  res.redirect(`/kurum/kurumsal-sayfa-duzenle/${req.params.id}`);
});

// DEPRECATED: Admin paneli POST/DELETE route'larÃÂ± kaldÃÂ±rÃÂ±ldÃÂ±
// ArtÃÂ±k /kurum/kurumsal-sayfa-guncelle/:id kullanÃÂ±lÃÂ±yor

// Ã°ÂÂÂ YENÃÂ° SÃÂ°STEM: Manuel EÃÂleÃÂtirme EkranÃÂ±
app.get('/kurum/sinav-manuel-eslestirme/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    const sadeceEslesmemis = req.query.sadece_eslesmemis === '1';
    
    // S�navÃÂ± al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('S�nav bulunamad�!');
    }
    
    // Sayfa dosyalar�n� bul (yeni sistem: sinav_${sinavId} klas�r�nde)
    const sayfalarDir = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    let sayfalar = [];
    
    if (fs.existsSync(sayfalarDir)) {
      const allFiles = fs.readdirSync(sayfalarDir);
      sayfalar = allFiles
        .filter(f => {
          // Sadece sayfa dosyalar�n� al (ogrenci_ ile ba�layanlar� ve orijinal dosyalar� hari� tut)
          return f.includes('sayfa_') && 
                 f.endsWith('.pdf') && 
                 !f.startsWith('ogrenci_') && 
                 !f.includes('orijinal_');
        })
        .sort((a, b) => {
          // Sayfa numaralar�na g�re s�rala
          const numA = parseInt(a.match(/sayfa_(\d+)_/)?.[1] || '0');
          const numB = parseInt(b.match(/sayfa_(\d+)_/)?.[1] || '0');
          return numA - numB;
        })
        .map(f => {
          const fullPath = path.join(sayfalarDir, f);
          // View i�in relative path
          return fullPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
        });
    }
    
    // E�er "sadece e�le�memi�" modundaysa, sadece e�le�memi� sayfalar� filtrele
    if (sadeceEslesmemis) {
      // Hangi sayfalar�n e�le�ti�ini kontrol et
      const eslesmisKayitlar = await dbAll(`
        SELECT pdf_path FROM sinav_katilimcilari 
        WHERE sinav_id = ? AND pdf_path IS NOT NULL AND pdf_path != ''
      `, [sinavId]);
      
      // E�le�mi� sayfa numaralar�n� bul
      // pdf_path format�: .../ogrenci_ID_sayfa_NUMARA.pdf
      const eslesmisSayfaNumaralari = new Set();
      eslesmisKayitlar.forEach(kayit => {
        if (kayit.pdf_path) {
          // Sayfa numaras�n� ��kar: ogrenci_3237_sayfa_8.pdf -> 8
          const sayfaMatch = kayit.pdf_path.match(/sayfa_(\d+)\.pdf/);
          if (sayfaMatch) {
            eslesmisSayfaNumaralari.add(parseInt(sayfaMatch[1]));
          }
        }
      });
      
      // Sadece e�le�memi� sayfalar� al
      sayfalar = sayfalar.filter(sayfa => {
        // Sayfa path'inden sayfa numaras�n� ��kar
        // Format: uploads/sinav-sonuclari/sinav_58/sinav_58_sayfa_1_123456.pdf
        const sayfaMatch = sayfa.match(/sayfa_(\d+)_/);
        if (sayfaMatch) {
          const sayfaNo = parseInt(sayfaMatch[1]);
          // E�er bu sayfa numaras� e�le�mi� sayfalar aras�nda yoksa, g�ster
          return !eslesmisSayfaNumaralari.has(sayfaNo);
        }
        // E�er sayfa numaras� bulunamazsa, g�ster (g�venlik i�in)
        return true;
      });
      
      console.log(`?? Sadece e�le�memi� sayfalar: ${sayfalar.length} (E�le�mi�: ${eslesmisSayfaNumaralari.size}, Toplam: ${sayfalar.length + eslesmisSayfaNumaralari.size})`);
    }
    
    // KatÃÂ±lÃÂ±mcÃÂ±larÃÂ± al (pdf_path ile birlikte - eÃÂleÃÂme durumunu kontrol iÃÂ§in)
    const katilimcilar = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
      ORDER BY ad_soyad
    `, [sinavId]);
    
    console.log(`\nÃ°ÂÂÂ MANUEL EÃÂLEÃÂTÃÂ°RME - KATILIMCI LÃÂ°STESÃÂ° (S�nav ID: ${sinavId})`);
    console.log(`   Toplam KatÃÂ±lÃÂ±mcÃÂ±: ${katilimcilar.length}`);
    const eslesmisSayisi = katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').length;
    console.log(`   EÃÂleÃÂmiÃÂ KatÃÂ±lÃÂ±mcÃÂ±: ${eslesmisSayisi}`);
    if (eslesmisSayisi > 0) {
      console.log(`   EÃÂleÃÂmiÃÂ ��renciler:`);
      katilimcilar.filter(k => k.pdf_path && k.pdf_path.trim() !== '').forEach(k => {
        console.log(`     - ${k.ad_soyad} (ID: ${k.ogrenci_id}) -> ${k.pdf_path}`);
      });
    }
    
    res.render('kurum/sinav-manuel-eslestirme', {
      user: req.session,
      sinav: sinav,
      sayfalar: sayfalar,
      katilimcilar: katilimcilar
    });
    
  } catch (error) {
    console.error('Manuel eÃÂleÃÂtirme ekranÃÂ± hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Ã°ÂÂÂ EÃÂleÃÂenleri Kontrol Et SayfasÃÂ±
app.get('/kurum/sinav-eslesen-kontrol/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    // S�navÃÂ± al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('S�nav bulunamad�!');
    }
    
    // EÃÂleÃÂmiÃÂ katÃÂ±lÃÂ±mcÃÂ±larÃÂ± al (pdf_path dolu olanlar)
    const eslesmisler = await dbAll(`
      SELECT 
        sk.ogrenci_id,
        sk.ogrenci_kaynak as kaynak,
        sk.pdf_path,
        sk.sonuc_durumu,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.ogrenci_adi_soyadi
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.ad_soyad
        END as ad_soyad,
        CASE 
          WHEN sk.ogrenci_kaynak = 'kurum' THEN ok.sinif
          WHEN sk.ogrenci_kaynak = 'veli' THEN o.sinif
        END as sinif
      FROM sinav_katilimcilari sk
      LEFT JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      LEFT JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ? AND sk.pdf_path IS NOT NULL AND sk.pdf_path != ''
      ORDER BY ad_soyad
    `, [sinavId]);
    
    console.log(`\nÃ¢ÂÂ EÃÂLEÃÂEN KONTROL SAYFASI`);
    console.log(`   S�nav ID: ${sinavId}`);
    console.log(`   EÃÂleÃÂmiÃÂ SayÃÂ±sÃÂ±: ${eslesmisler.length}`);
    
    res.render('kurum/sinav-eslesen-kontrol', {
      user: req.session,
      sinav: sinav,
      eslesmisler: eslesmisler
    });
    
  } catch (error) {
    console.error('EÃÂleÃÂen kontrol sayfasÃÂ± hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Ã°ÂÂÂ EÃÂleÃÂmeyi KaldÃÂ±r
app.post('/kurum/sinav-eslestirme-kaldir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, ogrenci_id, kaynak } = req.body;
    
    console.log(`\nÃ¢ÂÂ EÃÂLEÃÂMEYÃÂ° KALDIR`);
    console.log(`   S�nav ID: ${sinav_id}`);
    console.log(`   ��renci ID: ${ogrenci_id} (${kaynak})`);
    
    // pdf_path'i NULL yap ve sonuc_durumu'nu beklemede'ye ÃÂ§ek
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE sinav_katilimcilari 
        SET pdf_path = NULL, sonuc_durumu = 'beklemede'
        WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
      `, [sinav_id, ogrenci_id, kaynak], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
    
    console.log(`   Ã¢ÂÂ BaÃÂarÃÂ±lÃÂ±: ${result.changes} satÃÂ±r g�ncellendi`);
    
    if (result.changes === 0) {
      console.log(`   Ã¢ÂÂ Ã¯Â¸Â  UYARI: HiÃÂ§bir satÃÂ±r gÃÂ¼ncellenmedi!`);
      return res.json({ success: false, error: 'EÃÂleÃÂme bulunamad�!' });
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Ã¢ÂÂ EÃÂleÃÂme kaldÃÂ±rma hatasÃÂ±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ã°ÂÂÂ TOPLU VELÃÂ° HESABI OLUÃÂTURMA
app.post('/kurum/toplu-veli-hesap-olustur', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    console.log('\nÃ°ÂÂÂ¥ TOPLU VELÃÂ° HESABI OLUÃÂTURMA BAÃÂLADI');
    
    // TÃÂ¼m ÃÂ¶ÃÂrencileri al (sadece kurum ÃÂ¶ÃÂrencileri - tc_no olanlar)
    const ogrenciler = await dbAll(`
      SELECT id, ogrenci_adi_soyadi, tc_kimlik_no, sinif, telefon, veli_adi, veli_telefon
      FROM ogrenci_kayitlari
      WHERE tc_kimlik_no IS NOT NULL AND tc_kimlik_no != ''
      ORDER BY sinif, ogrenci_adi_soyadi
    `);
    
    console.log(`   Ã°ÂÂÂ ${ogrenciler.length} ÃÂ¶ÃÂrenci bulundu`);
    
    let olusturulan = 0;
    let mevcutOlanlar = 0;
    let hatalar = 0;
    
    for (const ogrenci of ogrenciler) {
      try {
        // Kontrol et: Bu TC ile kullan�c� var mÃÂ±?
        const mevcutUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        if (mevcutUser) {
          mevcutOlanlar++;
          continue;
        }
        
        // ÃÂifreyi hashle (ilk �ifre = TC)
        const hashedPassword = await bcrypt.hash(ogrenci.tc_kimlik_no, 10);
        
        // Veli hesabÃÂ± olu�tur
        await dbRun(`
          INSERT INTO users (username, email, password_hash, user_type, ad_soyad, telefon, password_changed)
          VALUES (?, ?, ?, 'veli', ?, ?, 0)
        `, [
          ogrenci.tc_kimlik_no, // username = TC
          `veli_${ogrenci.id}_${Date.now()}@temp.com`, // benzersiz email
          hashedPassword,
          ogrenci.veli_adi || `${ogrenci.ogrenci_adi_soyadi} Velisi`,
          ogrenci.veli_telefon || ogrenci.telefon
        ]);
        
        // Veli ID'sini al
        const veliUser = await dbGet('SELECT id FROM users WHERE username = ?', [ogrenci.tc_kimlik_no]);
        
        // ogrenciler tablosuna ekle (veli-ÃÂ¶ÃÂrenci iliÃÂkisi)
        await dbRun(`
          INSERT OR IGNORE INTO ogrenciler (veli_id, ad_soyad, sinif, telefon, tc_no)
          VALUES (?, ?, ?, ?, ?)
        `, [
          veliUser.id,
          ogrenci.ogrenci_adi_soyadi,
          ogrenci.sinif,
          ogrenci.telefon,
          ogrenci.tc_kimlik_no
        ]);
        
        olusturulan++;
        
      } catch (error) {
        console.error(`   Ã¢ÂÂ Hata (${ogrenci.ogrenci_adi_soyadi}):`, error.message);
        hatalar++;
      }
    }
    
    console.log(`\nÃ¢ÂÂ TOPLU VELÃÂ° HESABI OLUÃÂTURMA TAMAMLANDI`);
    console.log(`   Ã¢ÂÂ OluÃÂturulan: ${olusturulan}`);
    console.log(`   Ã¢ÂÂ Ã¯Â¸Â  Mevcut olanlar: ${mevcutOlanlar}`);
    console.log(`   Ã¢ÂÂ Hatalar: ${hatalar}`);
    
    res.json({ 
      success: true, 
      olusturulan, 
      mevcutOlanlar, 
      hatalar,
      toplam: ogrenciler.length
    });
    
  } catch (error) {
    console.error('Ã¢ÂÂ Toplu veli hesabÃÂ± olu�turma hatasÃÂ±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ã°ÂÂÂ YENÃÂ° SÃÂ°STEM: Sayfa EÃÂleÃÂtirme Kaydet
app.post('/kurum/sinav-sayfa-eslestir', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id, sayfa_yolu, ogrenci_id, kaynak } = req.body;
    
    console.log(`\nÃ°ÂÂÂ TEK SAYFA EÃÂLEÃÂTÃÂ°RME`);
    console.log(`   S�nav ID: ${sinav_id}`);
    console.log(`   ��renci ID: ${ogrenci_id} (${kaynak})`);
    console.log(`   Sayfa Yolu: ${sayfa_yolu}`);
    
    // sinav_katilimcilari tablosunu gÃÂ¼ncelle
    const result = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE sinav_katilimcilari 
        SET pdf_path = ?, sonuc_durumu = 'yuklendi'
        WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
      `, [sayfa_yolu, sinav_id, ogrenci_id, kaynak], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
    
    console.log(`   Ã¢ÂÂ BaÃÂarÃÂ±lÃÂ±: ${result.changes} satÃÂ±r g�ncellendi`);
    
    if (result.changes === 0) {
      console.log(`   Ã¢ÂÂ Ã¯Â¸Â  UYARI: HiÃÂ§bir satÃÂ±r gÃÂ¼ncellenmedi! WHERE koÃÂulu tutmad�.`);
    }
    
    res.json({ success: true, changes: result.changes });
    
  } catch (error) {
    console.error('Ã¢ÂÂ Sayfa eÃÂleÃÂtirme hatasÃÂ±:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ã°ÂÂÂ YENÃÂ° SÃÂ°STEM: Yeni SonuÃÂ§ YÃÂ¼kleme SayfasÃÂ±
app.get('/kurum/sinav-sonuc-yukle-yeni/:id', requireAuth, async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).send('Yetkiniz yok!');
  }
  
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('S�nav bulunamad�!');
    }
    
    const katilimciSayisi = await dbGet(
      'SELECT COUNT(*) as count FROM sinav_katilimcilari WHERE sinav_id = ?',
      [sinavId]
    );
    
    res.render('kurum/sinav-sonuc-yukle-yeni', {
      user: req.session,
      sinav: sinav,
      katilimciSayisi: katilimciSayisi.count,
      error: req.query.error || null
    });
    
  } catch (error) {
    console.error('SonuÃÂ§ yÃÂ¼kleme sayfasÃÂ± hatasÃÂ±:', error);
    res.status(500).send('Bir hata olu�tu!');
  }
});

// Kurum - PDF Sayfalara Ay�r (Yeni Sistem)
app.post('/kurum/sinav-sonuc-yukle-sayfalara-ayir', requireAuth, uploadLimiter, pdfUpload.single('pdfFile'), async (req, res) => {
  if (!['kurum_yonetici', 'kurum_admin'].includes(req.session.userType)) {
    return res.status(403).json({ success: false, error: 'Yetkiniz yok!' });
  }
  
  try {
    const { sinav_id } = req.body;
    
    if (!sinav_id) {
      return res.status(400).json({ success: false, error: 'S�nav ID eksik!' });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF dosyas� y�klenmedi!' });
    }
    
    console.log('?? PDF sayfalara ayr�l�yor:', req.file.originalname);
    console.log('?? S�nav ID:', sinav_id);
    
    // PDF'i y�kle
    const pdfBytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    console.log(`?? Toplam sayfa: ${totalPages}`);
    
    // Sonu� klas�r�n� olu�tur
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      fs.mkdirSync(sonucKlasoru, { recursive: true });
    }
    
    // ESK� SAYFALARI TEM�ZLE (yeni PDF y�klenirken)
    // Sadece sayfa dosyalar�n� sil (ogrenci_ ile ba�layanlar� ve orijinal dosyalar� koru)
    try {
      const existingFiles = fs.readdirSync(sonucKlasoru);
      const oldSayfaFiles = existingFiles.filter(f => 
        f.includes('sayfa_') && f.endsWith('.pdf') && !f.startsWith('ogrenci_')
      );
      
      if (oldSayfaFiles.length > 0) {
        console.log(`???  ${oldSayfaFiles.length} eski sayfa dosyas� temizleniyor...`);
        oldSayfaFiles.forEach(file => {
          try {
            fs.unlinkSync(path.join(sonucKlasoru, file));
          } catch (err) {
            console.warn(`   ??  ${file} silinemedi:`, err.message);
          }
        });
      }
    } catch (cleanupError) {
      console.warn('Eski dosya temizleme hatas� (devam ediliyor):', cleanupError);
    }
    
    // Her sayfay� ayr� PDF olarak kaydet
    const sayfaYollari = [];
    
    for (let i = 0; i < totalPages; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();
      
      // Dosya ad�: sinav_ID_sayfa_NUMARA_timestamp.pdf
      const sayfaFileName = `sinav_${sinav_id}_sayfa_${i + 1}_${Date.now()}.pdf`;
      const sayfaYolu = path.join(sonucKlasoru, sayfaFileName);
      
      fs.writeFileSync(sayfaYolu, singlePageBytes);
      sayfaYollari.push(sayfaYolu);
      
      console.log(`   ? Sayfa ${i + 1}/${totalPages} kaydedildi`);
    }
    
    // Orijinal PDF'i de kaydet
    const orijinalFileName = `sinav_${sinav_id}_orijinal_${Date.now()}.pdf`;
    const orijinalYol = path.join(sonucKlasoru, orijinalFileName);
    fs.copyFileSync(req.file.path, orijinalYol);
    
    // Veritaban�na kaydet - sinavlar tablosuna orijinal PDF yolunu ekle
    await dbRun(
      'UPDATE sinavlar SET dosya_yolu = ?, sonuc_yuklendi = 1 WHERE id = ?',
      [orijinalYol, sinav_id]
    );
    
    // Ge�ici dosyay� sil
    try {
      fs.unlinkSync(req.file.path);
    } catch (unlinkError) {
      console.warn('Ge�ici dosya silinemedi:', unlinkError);
    }
    
    console.log(`? PDF ba�ar�yla ${totalPages} sayfaya ayr�ld�!`);
    
    res.json({
      success: true,
      data: {
        sayfaSayisi: totalPages,
        sayfaYollari: sayfaYollari,
        orijinalYol: orijinalYol,
        // Ak�ll� e�le�tirme (analiz/pattern se�imi) ekran�na y�nlendir
        redirectTo: `/kurum/sinav-isim-pattern-secimi/${sinav_id}`
      }
    });
    
  } catch (error) {
    console.error('? PDF ay�rma hatas�:', error);
    
    // Ge�ici dosyay� temizle
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Ge�ici dosya silinemedi:', unlinkError);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'PDF sayfalara ayr�l�rken bir hata olu�tu!' 
    });
  }
});

// Kurum - �sim Pattern Se�imi
app.get('/kurum/sinav-isim-pattern-secimi/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).send('S�nav bulunamad�!');
    }
    
    // �lk PDF sayfas�n� bul (sayfalara ayr�lm�� PDF'lerden)
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinavId}`);
    
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(404).send('PDF sayfalar� bulunamad�! L�tfen �nce PDF y�kleyin.');
    }
    
    // �lk sayfa PDF'ini bul
    const files = fs.readdirSync(sonucKlasoru);
    const ilkSayfa = files.find(f => f.includes('sayfa_1_') && f.endsWith('.pdf'));
    
    if (!ilkSayfa) {
      return res.status(404).send('�lk PDF sayfas� bulunamad�!');
    }
    
    const ilkPdfPath = path.join(sonucKlasoru, ilkSayfa);
    
    // View i�in relative path (uploads/ ile ba�layan k�sm� al)
    const ilkPdfPathRelative = ilkPdfPath.replace(/\\/g, '/').replace(/^.*?(uploads\/)/, '$1');
    
    // �sim adaylar�n� ��kar
    const isimAdaylari = await extractNameCandidates(ilkPdfPath);
    
    res.render('kurum/sinav-isim-pattern-secimi', {
      user: req.session,
      sinavId: sinavId,
      sinav: sinav,
      ilkPdfPath: ilkPdfPathRelative,
      isimAdaylari: isimAdaylari || []
    });
    
  } catch (error) {
    console.error('�sim pattern se�imi sayfas� hatas�:', error);
    res.status(500).send('Bir hata olu�tu: ' + error.message);
  }
});

// Kurum - Otomatik E�le�tirme (Pattern Se�iminden Sonra)
app.post('/kurum/sinav-otomatik-eslestir-pattern', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { sinav_id, pattern_index, selected_text } = req.body;
    
    if (!sinav_id || pattern_index === null || !selected_text) {
      return res.status(400).json({ success: false, error: 'Eksik parametreler!' });
    }
    
    console.log('\n?? Otomatik E�le�tirme Ba�lat�l�yor...');
    console.log('?? S�nav ID:', sinav_id);
    console.log('?? Se�ilen Pattern:', selected_text);
    
    // S�nav bilgilerini al
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinav_id]);
    if (!sinav) {
      return res.status(400).json({ success: false, error: 'S�nav bulunamad�!' });
    }
    
    // Kat�l�mc�lar� al
    const kurumKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak,
             ok.ogrenci_adi_soyadi as ad_soyad
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
    `, [sinav_id]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak,
             o.ad_soyad
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
    `, [sinav_id]);
    
    const katilimcilar = [
      ...kurumKatilimcilari.map(k => ({ ...k, ogrenci_id: k.ogrenci_id })),
      ...veliKatilimcilari.map(k => ({ ...k, ogrenci_id: k.ogrenci_id }))
    ];
    
    // PDF sayfalar�n� bul
    const sonucKlasoru = path.join('uploads', 'sinav-sonuclari', `sinav_${sinav_id}`);
    if (!fs.existsSync(sonucKlasoru)) {
      return res.status(400).json({ success: false, error: 'PDF sayfalar� bulunamad�!' });
    }
    
    const files = fs.readdirSync(sonucKlasoru)
      .filter(f => f.includes('sayfa_') && f.endsWith('.pdf'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/sayfa_(\d+)_/)?.[1] || '0');
        const numB = parseInt(b.match(/sayfa_(\d+)_/)?.[1] || '0');
        return numA - numB;
      });
    
    console.log(`?? ${files.length} sayfa bulundu`);
    
    let eslesen = 0;
    let eslesmeyen = 0;
    const eslesmeler = [];
    
    // Pattern bilgilerini al (isimAdaylari'dan pattern_index ile)
    // �lk sayfadan pattern bilgisini al
    const ilkSayfaYolu = path.join(sonucKlasoru, files[0]);
    const ilkSayfaText = (await extractTextHybrid(ilkSayfaYolu)).text;
    const ilkSayfaLines = ilkSayfaText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Pattern'deki sat�r numaras�n� bul (selected_text'i i�eren sat�r)
    let patternLineNumber = -1;
    for (let i = 0; i < ilkSayfaLines.length; i++) {
      if (ilkSayfaLines[i].includes(selected_text) || selected_text.includes(ilkSayfaLines[i])) {
        patternLineNumber = i;
        break;
      }
    }
    
    // E�er bulunamazsa, pattern_index'i kullan
    if (patternLineNumber === -1 && pattern_index !== null) {
      patternLineNumber = parseInt(pattern_index);
    }
    
    console.log(`?? Pattern sat�r numaras�: ${patternLineNumber} (${patternLineNumber >= 0 ? ilkSayfaLines[patternLineNumber] : 'bulunamad�'})`);
    
    // Her sayfay� i�le
    for (let i = 0; i < files.length; i++) {
      const sayfaDosyasi = files[i];
      const sayfaYolu = path.join(sonucKlasoru, sayfaDosyasi);
      const sayfaNo = i + 1;
      
      try {
        // PDF'den text ��kar
        const extractionResult = await extractTextHybrid(sayfaYolu);
        const text = extractionResult.text;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // �oklu strateji ile isim ��kar
        let extractedName = '';
        let extractionMethod = '';
        
        // STRATEJ� 1: Pattern sat�r numaras�ndan direkt al
        if (patternLineNumber >= 0 && lines[patternLineNumber]) {
          extractedName = lines[patternLineNumber].trim();
          extractionMethod = 'pattern_line';
        }
        
        // STRATEJ� 2: selected_text'i i�eren sat�r� bul
        if (!extractedName || extractedName.length < 5) {
          for (const line of lines) {
            const normalizedLine = line.toUpperCase().trim();
            const normalizedSelected = selected_text.toUpperCase().trim();
            
            // Tam e�le�me veya k�smi e�le�me
            if (normalizedLine.includes(normalizedSelected) || 
                normalizedSelected.includes(normalizedLine) ||
                normalizedLine.replace(/\s+/g, '') === normalizedSelected.replace(/\s+/g, '')) {
              extractedName = line.trim();
              extractionMethod = 'text_match';
              break;
            }
          }
        }
        
        // STRATEJ� 3: Pattern sat�r�n�n yak�n�ndaki sat�rlar� kontrol et (�2 sat�r)
        if (!extractedName || extractedName.length < 5) {
          if (patternLineNumber >= 0) {
            for (let offset = -2; offset <= 2; offset++) {
              const checkLine = patternLineNumber + offset;
              if (checkLine >= 0 && checkLine < lines.length && lines[checkLine]) {
                const candidate = lines[checkLine].trim();
                // �sim gibi g�r�n�yor mu? (2-4 kelime, b�y�k harf ba�lang��)
                if (candidate.length >= 8 && candidate.length <= 50) {
                  const words = candidate.split(/\s+/);
                  if (words.length >= 2 && words.length <= 4) {
                    // �lk kelime b�y�k harfle ba�l�yor mu?
                    if (/^[A-Z������]/.test(words[0])) {
                      extractedName = candidate;
                      extractionMethod = `pattern_nearby_${offset}`;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
        
        // STRATEJ� 4: �lk 15 sat�rda isim benzeri pattern ara
        if (!extractedName || extractedName.length < 5) {
          for (let j = 0; j < Math.min(15, lines.length); j++) {
            const candidate = lines[j].trim();
            // �sim pattern'i: 2-4 kelime, her kelime b�y�k harfle ba�l�yor
            const namePattern = /^([A-Z������][a-z������]+(?:\s+[A-Z������][a-z������]+){1,3})$/;
            const upperPattern = /^([A-Z������]{2,}(?:\s+[A-Z������]{2,}){1,3})$/;
            
            if ((namePattern.test(candidate) || upperPattern.test(candidate)) && 
                candidate.length >= 8 && candidate.length <= 50) {
              // Gereksiz kelimeleri kontrol et
              const lower = candidate.toLowerCase();
              if (!lower.includes('��renci') && !lower.includes('numara') && 
                  !lower.includes('s�n�f') && !lower.includes('sonu�')) {
                extractedName = candidate;
                extractionMethod = `early_line_${j}`;
                break;
              }
            }
          }
        }
        
        // Hala bulunamazsa, selected_text'i direkt kullan
        if (!extractedName || extractedName.length < 5) {
          extractedName = selected_text;
          extractionMethod = 'fallback';
        }
        
        if (!extractedName || extractedName.length < 5) {
          console.log(`   ?? Sayfa ${sayfaNo}: �sim ��kar�lamad�`);
          eslesmeyen++;
          continue;
        }
        
        // �smi temizle
        const cleanName = cleanExtractedName(extractedName);
        
        if (!cleanName || cleanName.length < 5) {
          console.log(`   ?? Sayfa ${sayfaNo}: Temizlenmi� isim �ok k�sa: "${cleanName}"`);
          eslesmeyen++;
          continue;
        }
        
        // En iyi e�le�meyi bul (threshold'u d���rd�k)
        const match = findBestMatch(cleanName, katilimcilar);
        
        // Threshold'u 0.60'a d���rd�k (daha fazla e�le�me i�in)
        if (match && match.similarity >= 0.60) {
          // E�le�me bulundu - kaydet
          const finalPath = path.join(sonucKlasoru, `ogrenci_${match.ogrenci.ogrenci_id}_sayfa_${sayfaNo}.pdf`);
          fs.copyFileSync(sayfaYolu, finalPath);
          
          await dbRun(`
            UPDATE sinav_katilimcilari 
            SET pdf_path = ?, sonuc_durumu = 'yuklendi'
            WHERE sinav_id = ? AND ogrenci_id = ? AND ogrenci_kaynak = ?
          `, [finalPath, sinav_id, match.ogrenci.ogrenci_id, match.ogrenci.kaynak]);
          
          eslesen++;
          eslesmeler.push({
            sayfa: sayfaNo,
            ogrenci: match.ogrenci.ad_soyad,
            extracted: cleanName,
            original: extractedName,
            method: extractionMethod,
            confidence: match.similarity
          });
          console.log(`   ? Sayfa ${sayfaNo}: "${cleanName}" � "${match.ogrenci.ad_soyad}" (${(match.similarity * 100).toFixed(0)}%, ${extractionMethod})`);
        } else {
          console.log(`   ? Sayfa ${sayfaNo}: "${cleanName}" e�le�medi (en iyi: ${match ? (match.similarity * 100).toFixed(0) + '%' : 'yok'})`);
          eslesmeyen++;
        }
        
      } catch (error) {
        console.error(`Sayfa ${sayfaNo} i�lenirken hata:`, error);
        eslesmeyen++;
      }
    }
    
    // S�nav durumunu g�ncelle
    await dbRun('UPDATE sinavlar SET sonuc_yuklendi = 1 WHERE id = ?', [sinav_id]);
    
    console.log(`? E�le�tirme tamamland�: ${eslesen} ba�ar�l�, ${eslesmeyen} ba�ar�s�z`);
    
    res.json({
      success: true,
      data: {
        eslesen,
        eslesmeyen,
        toplam: files.length,
        eslesmeler: eslesmeler.slice(0, 10) // �lk 10'unu g�ster
      }
    });
    
  } catch (error) {
    console.error('Otomatik e�le�tirme hatas�:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Otomatik e�le�tirme s�ras�nda bir hata olu�tu!' 
    });
  }
});

// �sim adaylar�n� ��karan fonksiyon (autoMatcher.js'den uyarlanm��)
async function extractNameCandidates(pdfPath) {
  try {
    console.log(`\n?? �sim adaylar� ��kar�l�yor: ${path.basename(pdfPath)}`);
    
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;
    
    const candidates = [];
    const seen = new Set();
    const lines = text.split('\n');
    
    // T�m sat�rlarda isim ara
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      
      // Pattern 1: Ba�� b�y�k harfli isimler (Ahmet Mehmet Y�lmaz)
      const matches1 = line.match(/\b([A-Z������][a-z������]+(?:\s+[A-Z������][a-z������]+){1,2})\b/g);
      if (matches1) {
        matches1.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('��renci') && !lower.includes('s�nav') && !lower.includes('sonu�') && !lower.includes('numara')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Ba�� B�y�k Harf',
                lineNumber: lineIndex + 1,
                confidence: 80
              });
            }
          }
        });
      }
      
      // Pattern 2: Tam b�y�k harfli isimler (AL� VEL� �EL�K)
      const matches2 = line.match(/\b([A-Z������]{2,}(?:\s+[A-Z������]{2,}){1,2})\b/g);
      if (matches2) {
        matches2.forEach(match => {
          const normalized = match.trim().toLowerCase();
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('sonu�') && !lower.includes('s�nav') && !lower.includes('belge') && !lower.includes('deneme')) {
              seen.add(normalized);
              candidates.push({
                text: match.trim(),
                pattern: 'Tam B�y�k Harf',
                lineNumber: lineIndex + 1,
                confidence: 90
              });
            }
          }
        });
      }
    }
    
    // G�vene g�re s�rala ve ilk 10'u al
    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidates = candidates.slice(0, 10);
    
    console.log(`   ? ${topCandidates.length} adet isim aday� bulundu`);
    
    return topCandidates;
    
  } catch (error) {
    console.error('? �sim adaylar� ��karma hatas�:', error);
    return [];
  }
}

// Kurum - S�nav listesi (koleksiyon sayfasÃ½)
app.get('/kurum/sinavlar', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavlar = await dbAll('SELECT * FROM sinavlar ORDER BY created_at DESC');
    
    res.render('kurum/sinavlar', {
      user: { username: req.session.username, type: req.session.userType },
      sinavlar: sinavlar,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('S�nav listesi hatasÃ½:', error);
    req.session.error = 'S�nav listesi yuklenirken bir hata olu�tu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurum - S�nav detay
app.get('/kurum/sinav-detay/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const sinav = await dbGet('SELECT * FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      req.session.error = 'S�nav bulunamad�!';
      return res.redirect('/kurum/sinavlar');
    }
    
    // KatÃ½lÃ½mcÃ½lar (kurum ve veli)
    const kurumKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak, sk.pdf_path, sk.sonuc_durumu, sk.pdf_goruldu, sk.pdf_gorunme_tarihi, sk.pdf_indirilme_sayisi,
             ok.ogrenci_adi_soyadi as ad_soyad, ok.sinif, ok.telefon, ok.veli_adi
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenci_kayitlari ok ON sk.ogrenci_id = ok.id AND sk.ogrenci_kaynak = 'kurum'
      WHERE sk.sinav_id = ?
    `, [sinavId]);
    
    const veliKatilimcilari = await dbAll(`
      SELECT sk.id, sk.ogrenci_id, sk.ogrenci_kaynak as kaynak, sk.pdf_path, sk.sonuc_durumu, sk.pdf_goruldu, sk.pdf_gorunme_tarihi, sk.pdf_indirilme_sayisi,
             o.ad_soyad, o.sinif, o.telefon, NULL as veli_adi
      FROM sinav_katilimcilari sk
      INNER JOIN ogrenciler o ON sk.ogrenci_id = o.id AND sk.ogrenci_kaynak = 'veli'
      WHERE sk.sinav_id = ?
    `, [sinavId]);
    
    const katilimcilar = [...kurumKatilimcilari, ...veliKatilimcilari];
    
    // SÃ½nÃ½f listesi (oÃ°renci ekleme filtresi)
    const siniflar = ['1','2','3','4','5','6','7','8','9','10','11','12','Mezun'];
    
    // ÃÃ°renci havuzu (kurum + veli) secim listesi icin
    // Zaten eklenmi� ��rencileri filtrele
    const mevcutKatilimciKeys = new Set(
      katilimcilar.map(k => `${k.kaynak}_${k.ogrenci_id}`)
    );
    
    const kurumOgrencileri = await dbAll(`SELECT id, ogrenci_adi_soyadi as ad_soyad, sinif FROM ogrenci_kayitlari ORDER BY ad_soyad ASC`);
    const veliOgrencileri = await dbAll(`SELECT id, ad_soyad, sinif FROM ogrenciler ORDER BY ad_soyad ASC`);
    
    // Duplicate kontrol� i�in: ayn� isim ve s�n�fa sahip ��rencileri birle�tir
    const ogrenciMap = new Map();
    
    // �nce kurum ��rencilerini ekle
    kurumOgrencileri
      .filter(o => !mevcutKatilimciKeys.has(`kurum_${o.id}`))
      .forEach(o => {
        const key = `${(o.ad_soyad || '').toLowerCase().trim()}_${(o.sinif || '').trim()}`;
        if (!ogrenciMap.has(key)) {
          ogrenciMap.set(key, { unique_id: `kurum_${o.id}`, ad_soyad: o.ad_soyad, sinif: o.sinif || '', kaynak: 'kurum' });
        }
      });
    
    // Sonra veli ��rencilerini ekle (e�er ayn� isim ve s�n�f yoksa)
    veliOgrencileri
      .filter(o => !mevcutKatilimciKeys.has(`veli_${o.id}`))
      .forEach(o => {
        const key = `${(o.ad_soyad || '').toLowerCase().trim()}_${(o.sinif || '').trim()}`;
        if (!ogrenciMap.has(key)) {
          ogrenciMap.set(key, { unique_id: `veli_${o.id}`, ad_soyad: o.ad_soyad, sinif: o.sinif || '', kaynak: 'veli' });
        }
      });
    
    const tumOgrenciler = Array.from(ogrenciMap.values()).sort((a, b) => 
      (a.ad_soyad || '').localeCompare(b.ad_soyad || '')
    );
    
    // �statistikleri hesapla
    const toplam = katilimcilar.length;
    const eslesmis = katilimcilar.filter(k => k.pdf_path && k.sonuc_durumu !== 'beklemede').length;
    const eslesmemis = toplam - eslesmis;
    const oran = toplam > 0 ? Math.round((eslesmis / toplam) * 100) : 0;
    
    const istatistikler = {
      toplam,
      eslesmis,
      eslesmemis,
      oran
    };
    
    res.render('kurum/sinav-detay', {
      user: { username: req.session.username, type: req.session.userType },
      sinav,
      katilimcilar,
      siniflar,
      tumOgrenciler,
      istatistikler,
      error: req.session.error,
      success: req.session.success
    });
    req.session.error = null;
    req.session.success = null;
  } catch (error) {
    console.error('S�nav detay hatasÃ½:', error);
    req.session.error = 'S�nav detaylarÃ½ yuklenirken bir hata olu�tu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - S�nav durumu g�ncelle
app.post('/kurum/sinav-durumu-guncelle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), async (req, res) => {
  try {
    const sinavId = req.params.id;
    const { sinav_durumu } = req.body || {};

    if (!sinav_durumu) {
      return res.status(400).json({ success: false, message: 'S�nav durumu gerekli!' });
    }

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'S�nav bulunamad�!' });
    }

    await dbRun('UPDATE sinavlar SET sinav_durumu = ? WHERE id = ?', [sinav_durumu, sinavId]);
    return res.json({ success: true, message: 'S�nav durumu g�ncellendi!' });
  } catch (error) {
    console.error('S�nav durumu g�ncelleme hatas�:', error);
    return res.status(500).json({ success: false, message: 'S�nav durumu g�ncellenirken hata olu�tu!' });
  }
});

// Kurum - Cevap anahtar� y�kle
app.post('/kurum/cevap-anahtari-yukle/:id', requireAuth, requireRole(['kurum_yonetici','kurum_admin']), answerKeyUpload.single('cevapAnahtari'), async (req, res) => {
  try {
    const sinavId = req.params.id;

    const sinav = await dbGet('SELECT id FROM sinavlar WHERE id = ?', [sinavId]);
    if (!sinav) {
      return res.status(404).json({ success: false, message: 'S�nav bulunamad�!' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'PDF dosyas� gerekli!' });
    }

    const relativePath = req.file.path.replace(/^\.?\/?/, '');
    await dbRun('UPDATE sinavlar SET cevap_anahtari_pdf = ? WHERE id = ?', [relativePath, sinavId]);

    return res.json({ success: true, message: 'Cevap anahtar� y�klendi!' });
  } catch (error) {
    console.error('Cevap anahtar� y�kleme hatas�:', error);
    return res.status(500).json({ success: false, message: 'Cevap anahtar� y�klenirken hata olu�tu!' });
  }
});

// Kurum - S�nav ekle
app.post('/kurum/sinav-ekle', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { ad, tarih, sinif, aciklama } = req.body;
    if (!ad || !tarih) {
      req.session.error = 'S�nav adÃ½ ve tarih zorunludur!';
      return res.redirect('/kurum/sinavlar');
    }
    
    await dbRun(
      `INSERT INTO sinavlar (ad, tarih, sinif, aciklama, durum, katilimci_sayisi, sonuc_yuklendi, sonuclar_aciklandi) 
       VALUES (?, ?, ?, ?, 'taslak', 0, 0, 0)`,
      [ad.trim(), tarih, sinif || null, aciklama || null]
    );
    
    req.session.success = 'S�nav eklendi!';
    res.redirect('/kurum/sinavlar');
  } catch (error) {
    console.error('S�nav ekleme hatas�:', error);
    req.session.error = 'S�nav eklenirken bir hata olu�tu!';
    res.redirect('/kurum/sinavlar');
  }
});

// Kurum - S�nav katÃ½lÃ½mcÃ½sÃ½ ekle (coklu)
app.post('/kurum/sinav-katilimci-ekle', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { sinav_id, ogrenci_ids } = req.body;
    if (!sinav_id || !Array.isArray(ogrenci_ids) || ogrenci_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Sinav veya ogrenci bilgisi eksik!' });
    }
    // Mevcut katilimcilari onbellege al (cift kaydi engelle)
    const mevcut = await dbAll("SELECT ogrenci_id, ogrenci_kaynak FROM sinav_katilimcilari WHERE sinav_id = ?", [sinav_id]);
    const mevcutSet = new Set(mevcut.map(m => `${m.ogrenci_kaynak}_${m.ogrenci_id}`));
    
    // Duplicate kontrol�: ayn� ��renci birden fazla kez se�ilmi�se sadece birini al
    const uniqueOgrenciIds = [...new Set(ogrenci_ids)];
    
    let added = 0;
    let skipped = 0;
    for (const raw of uniqueOgrenciIds) {
      if (!raw || typeof raw !== 'string' || !raw.includes('_')) continue;
      const [kaynak, idStr] = raw.split('_');
      const ogrenciId = parseInt(idStr, 10);
      if (!ogrenciId || (kaynak !== 'kurum' && kaynak !== 'veli')) continue;
      const key = `${kaynak}_${ogrenciId}`;
      if (mevcutSet.has(key)) { skipped++; continue; }
      await dbRun("INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak, sonuc_durumu) VALUES (?, ?, ?, ?)", [sinav_id, ogrenciId, kaynak, 'beklemede']);
      mevcutSet.add(key);
      added++;
    }
    
    // Mevcut duplicate kay�tlar� temizle (ayn� sinav_id, ogrenci_id, ogrenci_kaynak kombinasyonundan sadece birini tut)
    try {
      // �nce t�m kay�tlar� al
      const allRecords = await dbAll(`
        SELECT rowid, sinav_id, ogrenci_id, ogrenci_kaynak 
        FROM sinav_katilimcilari 
        WHERE sinav_id = ?
        ORDER BY rowid
      `, [sinav_id]);
      
      // Her kombinasyon i�in ilk kayd� tut, di�erlerini sil
      const seen = new Set();
      const toDelete = [];
      
      for (const record of allRecords) {
        const key = `${record.sinav_id}_${record.ogrenci_id}_${record.ogrenci_kaynak}`;
        if (seen.has(key)) {
          toDelete.push(record.rowid);
        } else {
          seen.add(key);
        }
      }
      
      // Duplicate kay�tlar� sil
      if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => '?').join(',');
        await dbRun(`DELETE FROM sinav_katilimcilari WHERE rowid IN (${placeholders})`, toDelete);
      }
    } catch (cleanupError) {
      console.error('Duplicate temizleme hatas� (devam ediliyor):', cleanupError);
      // Hata olsa bile devam et
    }
    
    await dbRun("UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?", [sinav_id, sinav_id]);
    
    const message = added > 0 
      ? `${added} ��renci ba�ar�yla eklendi.${skipped > 0 ? ` ${skipped} ��renci zaten ekliydi.` : ''}`
      : skipped > 0 
        ? `${skipped} ��renci zaten ekliydi.`
        : 'Hi�bir ��renci eklenemedi.';
    
    res.json({ success: true, added, skipped, message });
  } catch (error) {
    console.error('S�nav katÃ½lÃ½mcÃ½ ekleme hatasÃ½:', error);
    res.status(500).json({ success: false, error: 'KatÃ½lÃ½mcÃ½ eklenemedi!', message: error.message });
  }
});

// Kurum - S�nav katÃ½lÃ½mcÃ½ sil
app.post('/kurum/sinav-katilimci-sil/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const katilimciId = req.params.id;
    const kayit = await dbGet('SELECT sinav_id FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    await dbRun('DELETE FROM sinav_katilimcilari WHERE id = ?', [katilimciId]);
    if (kayit && kayit.sinav_id) {
      await dbRun(
        'UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?',
        [kayit.sinav_id, kayit.sinav_id]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('S�nav katÃ½lÃ½mcÃ½ silme hatasÃ½:', error);
    res.status(500).json({ success: false, error: 'KatÃ½lÃ½mcÃ½ silinemedi!' });
  }
});

// Kurum - S�nav sil
app.post('/kurum/sinav-sil/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sinavId = req.params.id;
    await dbRun('DELETE FROM sinavlar WHERE id = ?', [sinavId]);
    res.json({ success: true });
  } catch (error) {
    console.error('S�nav silme hatasÃ½:', error);
    res.status(500).json({ success: false, error: 'S�nav silinemedi!' });
  }
});

// ============================================
// KURUM - SITE AYARLARI
// ============================================

// Kurumsal Sayfalar Listesi
app.get('/kurum/kurumsal-sayfalar', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sayfalar = await dbAll('SELECT * FROM kurumsal_sayfalar ORDER BY sira ASC');
    
    res.render('kurum/kurumsal-sayfalar', {
      user: { username: req.session.username, type: req.session.userType },
      sayfalar: sayfalar,
      success: req.session.success,
      error: req.session.error
    });
    req.session.success = null;
    req.session.error = null;
  } catch (error) {
    console.error('Kurumsal sayfalar listesi hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/kurum/dashboard');
  }
});

// Kurumsal Sayfa DÃÂ¼zenle (GET)
app.get('/kurum/kurumsal-sayfa-duzenle/:id', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const sayfa = await dbGet('SELECT * FROM kurumsal_sayfalar WHERE id = ?', [req.params.id]);
    
    if (!sayfa) {
      req.session.error = 'Sayfa bulunamad�!';
      return res.redirect('/kurum/kurumsal-sayfalar');
    }
    
    res.render('kurum/kurumsal-sayfa-duzenle', {
      user: { username: req.session.username, type: req.session.userType },
      sayfa: sayfa
    });
  } catch (error) {
    console.error('Sayfa dÃÂ¼zenle hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/kurum/kurumsal-sayfalar');
  }
});

// Site Ayarlar� SayfasÃÂ± (GET)
app.get('/kurum/site-ayarlari', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const ayarlar = await dbAll('SELECT * FROM site_ayarlari ORDER BY anahtar ASC');
    
    const ayarlarObj = {};
    ayarlar.forEach(a => {
      ayarlarObj[a.anahtar] = a.deger;
    });
    
    res.render('kurum/site-ayarlari', {
      user: { username: req.session.username, type: req.session.userType },
      ayarlar: ayarlarObj,
      success: req.session.success,
      error: req.session.error
    });
    req.session.success = null;
    req.session.error = null;
  } catch (error) {
    console.error('Site ayarlar� sayfa hatasÃÂ±:', error);
    req.session.error = 'Sayfa y�klenirken bir hata olu�tu!';
    res.redirect('/kurum/dashboard');
  }
});

// Site Ayarlar� GÃÂ¼ncelle (POST)
app.post('/kurum/site-ayarlari', requireAuth, requireRole('kurum_yonetici'), async (req, res) => {
  try {
    const { site_adi, site_adres, site_telefon, site_email, site_aciklama } = req.body;
    
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adi', site_adi]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_adres', site_adres]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_telefon', site_telefon]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_email', site_email]);
    await dbRun('INSERT OR REPLACE INTO site_ayarlari (anahtar, deger, updated_at) VALUES (?, ?, datetime("now"))', ['site_aciklama', site_aciklama]);
    
    console.log('Ã¢ÂÂ Site ayarlar� g�ncellendi');
    req.session.success = 'Site ayarlar� ba�ar�yla g�ncellendi!';
    res.redirect('/kurum/site-ayarlari');
  } catch (error) {
    console.error('Site ayarlar� gÃÂ¼ncelleme hatasÃÂ±:', error);
    req.session.error = 'Ayarlar g�ncellenirken bir hata olu�tu!';
    res.redirect('/kurum/site-ayarlari');
  }
});

// Sunucuyu baÃÂlat
// Railway i�in 0.0.0.0 kullan (t�m network interface'lerde dinle)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('? Sunucu ba�ar�yla ba�lat�ld�!');
  console.log(`?? Port: ${PORT}`);
  console.log(`?? URL: http://0.0.0.0:${PORT}`);
  console.log(`?? Veritaban�: ${DB_PATH}`);
  console.log(`?? Environment: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log('='.repeat(50));
});

// Error handler for server
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`? Port ${PORT} zaten kullan�mda!`);
  } else {
    console.error('? Sunucu ba�latma hatas�:', err);
  }
  process.exit(1);
});

// Graceful shutdown
// Rehber - Manuel EÃÂleÃÂtirme KALDIRILDI (Sadece kurum yapabilir)

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('VeritabanÃÂ± kapatma hatasÃÂ±:', err);
    } else {
      console.log('Database connected:', DB_PATH);
    }
    process.exit(0);
  });
});

















