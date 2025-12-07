// ============================================
// OTOMATİK SINAV SONUCU EŞLEŞTİRME SİSTEMİ v3
// ============================================
// SÜRÜM 3: TEMİZ, BASİT VE %100 ÇALIŞIR
// - PDF'den text extraction (pdf-parse)
// - Türkçe karakter normalizasyonu
// - FuzzySet.js ile akıllı eşleştirme
// - Session bağımsız (dosya sistemi tabanlı)

const FuzzySet = require('fuzzyset.js');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// ============================================
// YARDIMCI FONKSİYONLAR
// ============================================

/**
 * Türkçe karakterleri düzeltir ve normalize eder
 * @param {string} text - Normalize edilecek metin
 * @returns {string} - Normalize edilmiş metin
 */
function normalizeText(text) {
  if (!text) return '';
  
  return text
    .toString()
    .toUpperCase()
    .replace(/Ç/g, 'C')
    .replace(/Ğ/g, 'G')
    .replace(/İ/g, 'I')
    .replace(/Ö/g, 'O')
    .replace(/Ş/g, 'S')
    .replace(/Ü/g, 'U')
    .replace(/ç/g, 'C')
    .replace(/ğ/g, 'G')
    .replace(/ı/g, 'I')
    .replace(/i/g, 'I')
    .replace(/ö/g, 'O')
    .replace(/ş/g, 'S')
    .replace(/ü/g, 'U')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================
// PDF İSİM ÇIKARMA
// ============================================

/**
 * PDF'den öğrenci ismini çıkarır
 * @param {string} pdfPath - PDF dosya yolu
 * @returns {Promise<string|null>} - Bulunan isim veya null
 */
async function extractStudentName(pdfPath) {
  try {
    console.log(`\n🔍 PDF İşleniyor: ${path.basename(pdfPath)}`);
    
    // PDF'den text çıkar
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const fullText = pdfData.text;
    
    console.log(`   📄 Text uzunluğu: ${fullText.length} karakter`);
    
    // Satır satır işle
    const lines = fullText.split('\n');
    
    // YÖNTEM 1: "ÖğrenciNumaraSınıf" pattern'i
    for (const line of lines) {
      // "ÖğrenciNumaraSınıf" kelimesinden sonra isim ara
      const pattern1Match = line.match(/ÖğrenciNumaraSınıf\s+([A-ZÇĞİÖŞÜa-zçğıöşü\s]{5,}?)(?:\d|$)/);
      
      if (pattern1Match) {
        const rawName = pattern1Match[1].trim();
        
        // İlk 2-3 kelimeyi al (gereksiz sayıları/kodları at)
        const words = rawName.split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w));
        if (words.length >= 2 && words.length <= 4) {
          const candidate = words.slice(0, 3).join(' ');
          
          if (candidate.length >= 5) {
            console.log(`   ✅ Pattern 1 → "${candidate}"`);
            return candidate;
          }
        }
      }
    }
    
    // YÖNTEM 2: Başı büyük harfli isimler (Ahmet Mehmet Yılmaz)
    for (const line of lines) {
      const mixedMatch = line.match(/\b([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,2})\b/);
      
      if (mixedMatch) {
        const candidate = mixedMatch[1].trim();
        const lower = candidate.toLowerCase();
        
        if (candidate.length >= 8 && 
            !lower.includes('öğrenci') && 
            !lower.includes('numara') && 
            !lower.includes('sınıf') &&
            !lower.includes('sonuç') &&
            !lower.includes('belge') &&
            !lower.includes('sınav')) {
          
          console.log(`   ✅ Pattern 2 → "${candidate}"`);
          return candidate;
        }
      }
    }
    
    // YÖNTEM 3: Tam büyük harfli isimler (ALİ VELI ÇELİK)
    for (const line of lines) {
      const upperMatch = line.match(/\b([A-ZÇĞİÖŞÜ]{2,}(?:\s+[A-ZÇĞİÖŞÜ]{2,}){1,2})\b/);
      
      if (upperMatch) {
        const candidate = upperMatch[1].trim();
        const lower = candidate.toLowerCase();
        
        if (candidate.length >= 8 && 
            !lower.includes('sonuç') && 
            !lower.includes('belge') && 
            !lower.includes('sınav') &&
            !lower.includes('deneme') &&
            !lower.includes('derslere') &&
            !lower.includes('analiz')) {
          
          console.log(`   ✅ Pattern 3 → "${candidate}"`);
          return candidate;
        }
      }
    }
    
    console.log(`   ❌ İsim bulunamadı`);
    return null;
    
  } catch (error) {
    console.error(`   ❌ Hata: ${error.message}`);
    return null;
  }
}

/**
 * İlk PDF'den isim adaylarını çıkarır (kullanıcı seçsin diye)
 * @param {string} pdfPath - İlk PDF yolu
 * @returns {Promise<Array>} - İsim adayları
 */
async function extractNameCandidates(pdfPath) {
  try {
    console.log(`\n🔍 İsim adayları çıkarılıyor: ${path.basename(pdfPath)}`);
    
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text;
    
    const candidates = [];
    const seen = new Set();
    const lines = text.split('\n');
    
    // Tüm satırlarda isim ara
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      
      // Pattern 1: Başı büyük harfli isimler
      const matches1 = line.match(/\b([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,2})\b/g);
      if (matches1) {
        matches1.forEach(match => {
          const normalized = normalizeText(match);
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('öğrenci') && !lower.includes('sınav') && !lower.includes('sonuç')) {
              seen.add(normalized);
              candidates.push({
                text: match,
                pattern: 'Başı Büyük Harf',
                lineNumber: lineIndex + 1,
                confidence: 80
              });
            }
          }
        });
      }
      
      // Pattern 2: Tam büyük harfli isimler
      const matches2 = line.match(/\b([A-ZÇĞİÖŞÜ]{2,}(?:\s+[A-ZÇĞİÖŞÜ]{2,}){1,2})\b/g);
      if (matches2) {
        matches2.forEach(match => {
          const normalized = normalizeText(match);
          if (match.length >= 8 && !seen.has(normalized)) {
            const lower = match.toLowerCase();
            if (!lower.includes('sonuç') && !lower.includes('sınav') && !lower.includes('belge')) {
              seen.add(normalized);
              candidates.push({
                text: match,
                pattern: 'Tam Büyük Harf',
                lineNumber: lineIndex + 1,
                confidence: 90
              });
            }
          }
        });
      }
    }
    
    // Güvene göre sırala ve ilk 10'u al
    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidates = candidates.slice(0, 10);
    
    console.log(`   ✅ ${topCandidates.length} adet isim adayı bulundu`);
    
    return topCandidates;
    
  } catch (error) {
    console.error('❌ İsim adayları çıkarma hatası:', error);
    return [];
  }
}

// ============================================
// FUZZY MATCHİNG
// ============================================

/**
 * Fuzzy matching ile öğrenciyi bul
 * @param {string} extractedName - PDF'den çıkarılan isim
 * @param {Array} ogrenciler - Öğrenci listesi [{ad_soyad, ...}]
 * @returns {Object} - Eşleşme sonucu
 */
function fuzzyMatchStudent(extractedName, ogrenciler) {
  if (!extractedName || !ogrenciler || ogrenciler.length === 0) {
    return {
      success: false,
      confidence: 0,
      ogrenci: null,
      message: 'Öğrenci listesi boş veya isim bulunamadı'
    };
  }
  
  console.log(`\n🔗 Fuzzy Matching: "${extractedName}"`);
  console.log(`   Veritabanında ${ogrenciler.length} öğrenci var`);
  
  try {
    // Öğrenci isimlerini normalize et
    const normalizedNames = ogrenciler
      .filter(o => o.ad_soyad && o.ad_soyad.trim().length > 0)
      .map(o => normalizeText(o.ad_soyad));
    
    if (normalizedNames.length === 0) {
      console.log('   ❌ Normalize edilmiş isim bulunamadı');
      return {
        success: false,
        confidence: 0,
        ogrenci: null,
        message: 'Öğrenci isimleri boş'
      };
    }
    
    console.log(`   📋 ${normalizedNames.length} normalize isim hazır`);
    
    // FuzzySet oluştur (DÜZGÜN PARAMETRELER)
    const fuzzy = FuzzySet(normalizedNames, false);
    const normalizedSearch = normalizeText(extractedName);
    
    console.log(`   🔍 Arama terimi: "${normalizedSearch}"`);
    
    // Eşleşmeleri bul (%40+ benzerlik)
    const results = fuzzy.get(normalizedSearch, null, 0.4);
    
    if (!results || results.length === 0) {
      console.log('   ❌ 0 eşleşme (threshold: %40)');
      return {
        success: false,
        confidence: 0,
        ogrenci: null,
        message: 'Hiç eşleşme bulunamadı'
      };
    }
    
    // En iyi eşleşme
    const bestMatch = results[0];
    const confidence = bestMatch[0];
    const matchedNormalizedName = bestMatch[1];
    
    console.log(`   🎯 En iyi: "${matchedNormalizedName}" (${Math.round(confidence * 100)}%)`);
    
    // Orijinal öğrenciyi bul
    const matchedStudent = ogrenciler.find(o => 
      normalizeText(o.ad_soyad) === matchedNormalizedName
    );
    
    if (!matchedStudent) {
      console.log('   ❌ Öğrenci kaydı bulunamadı (normalize hatası)');
      return {
        success: false,
        confidence: confidence,
        ogrenci: null,
        message: 'Eşleşen öğrenci kaydı bulunamadı'
      };
    }
    
    // Başarı kriteri: %60+ eşleşme
    const isSuccess = confidence >= 0.60;
    
    if (isSuccess) {
      console.log(`   ✅ EŞLEŞME → "${matchedStudent.ad_soyad}" (${Math.round(confidence * 100)}%)`);
    } else {
      console.log(`   ⚠️  Düşük güven: ${Math.round(confidence * 100)}%`);
    }
    
    return {
      success: isSuccess,
      confidence: confidence,
      ogrenci: matchedStudent,
      message: isSuccess ? 'Eşleşti' : 'Düşük güven',
      autoMatch: confidence >= 0.85 // %85+ otomatik kaydet
    };
    
  } catch (error) {
    console.error(`   ❌ Fuzzy matching hatası: ${error.message}`);
    return {
      success: false,
      confidence: 0,
      ogrenci: null,
      message: `Hata: ${error.message}`
    };
  }
}

// ============================================
// OTOMATİK EŞLEŞTİRME (TÜM SAYFALAR)
// ============================================

/**
 * Tüm PDF sayfalarını öğrencilerle eşleştir
 * @param {Array} pages - PDF sayfa yolları [{path, index}]
 * @param {Array} ogrenciler - Öğrenci listesi
 * @returns {Promise<Object>} - Eşleştirme sonuçları
 */
async function matchAllPages(pages, ogrenciler) {
  console.log('\n🤖 ============================================');
  console.log('🤖 OTOMATİK EŞLEŞTİRME BAŞLIYOR');
  console.log('🤖 ============================================');
  console.log(`📄 Toplam PDF: ${pages.length}`);
  console.log(`👥 Toplam Öğrenci: ${ogrenciler.length}\n`);
  
  const results = {
    total: pages.length,
    autoMatched: [],
    failed: [],
    statistics: {
      success: 0,
      failed: 0
    }
  };
  
  // Her sayfayı işle
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    console.log(`\n📄 Sayfa ${i + 1}/${pages.length}: ${path.basename(page.path)}`);
    
    try {
      // İsim çıkar
      const extractedName = await extractStudentName(page.path);
      
      if (!extractedName) {
        console.log('   ❌ İsim okunamadı');
        results.failed.push({
          page: page,
          reason: 'İsim okunamadı',
          extractedName: null
        });
        results.statistics.failed++;
        continue;
      }
      
      // Fuzzy matching
      const matchResult = fuzzyMatchStudent(extractedName, ogrenciler);
      
      if (matchResult.success && matchResult.confidence >= 0.60) {
        console.log(`   ✅ Eşleşti: ${matchResult.ogrenci.ad_soyad} (%${Math.round(matchResult.confidence * 100)})`);
        
        results.autoMatched.push({
          page: page,
          ogrenci: matchResult.ogrenci,
          confidence: matchResult.confidence,
          extractedName: extractedName
        });
        results.statistics.success++;
      } else {
        console.log(`   ❌ Eşleşmedi (%${Math.round(matchResult.confidence * 100)})`);
        
        results.failed.push({
          page: page,
          reason: matchResult.message,
          extractedName: extractedName,
          confidence: matchResult.confidence
        });
        results.statistics.failed++;
      }
      
    } catch (error) {
      console.error(`   ❌ Hata: ${error.message}`);
      results.failed.push({
        page: page,
        reason: error.message
      });
      results.statistics.failed++;
    }
  }
  
  // Özet
  console.log('\n🎯 ============================================');
  console.log('🎯 EŞLEŞTİRME SONUÇLARI');
  console.log('🎯 ============================================');
  console.log(`✅ Başarılı: ${results.statistics.success} / ${results.total} (%${Math.round(results.statistics.success / results.total * 100)})`);
  console.log(`❌ Başarısız: ${results.statistics.failed} / ${results.total} (%${Math.round(results.statistics.failed / results.total * 100)})`);
  console.log('============================================\n');
  
  return results;
}

// ============================================
// EXPORT
// ============================================

module.exports = {
  extractStudentName,
  extractNameCandidates,
  fuzzyMatchStudent,
  matchAllPages,
  normalizeText
};
