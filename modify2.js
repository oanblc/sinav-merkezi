const fs=require('fs');
let s=fs.readFileSync('server.js','utf8');
const pattern=/const \{ sinav_id, ogrenci_ids \} = req\.body;[\s\S]*?res\.json\(\{ success: true, added, skipped \}\);/;
const replacement = [
  "const { sinav_id, ogrenci_ids } = req.body;",
  "    if (!sinav_id || !Array.isArray(ogrenci_ids) || ogrenci_ids.length === 0) {",
  "      return res.status(400).json({ success: false, error: 'Sinav veya ogrenci bilgisi eksik!' });",
  "    }",
  "    // Mevcut katilimcilari onbellege al (cift kaydi engelle)",
  "    const mevcut = await dbAll(\"SELECT ogrenci_id, ogrenci_kaynak FROM sinav_katilimcilari WHERE sinav_id = ?\", [sinav_id]);",
  "    const mevcutSet = new Set(mevcut.map(m => `${m.ogrenci_kaynak}_${m.ogrenci_id}`));",
  "    let added = 0;",
  "    let skipped = 0;",
  "    for (const raw of ogrenci_ids) {",
  "      if (!raw || typeof raw !== 'string' || !raw.includes('_')) continue;",
  "      const [kaynak, idStr] = raw.split('_');",
  "      const ogrenciId = parseInt(idStr, 10);",
  "      if (!ogrenciId || (kaynak !== 'kurum' && kaynak !== 'veli')) continue;",
  "      const key = `${kaynak}_${ogrenciId}`;",
  "      if (mevcutSet.has(key)) { skipped++; continue; }",
  "      await dbRun(\"INSERT INTO sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak, sonuc_durumu) VALUES (?, ?, ?, ?)\", [sinav_id, ogrenciId, kaynak, 'beklemede']);",
  "      mevcutSet.add(key);",
  "      added++;",
  "    }",
  "    await dbRun(\"DELETE FROM sinav_katilimcilari WHERE sinav_id = ? AND rowid NOT IN (SELECT MIN(rowid) FROM sinav_katilimcilari WHERE sinav_id = ? GROUP BY sinav_id, ogrenci_id, ogrenci_kaynak)\", [sinav_id, sinav_id]);",
  "    await dbRun(\"UPDATE sinavlar SET katilimci_sayisi = (SELECT COUNT(*) FROM sinav_katilimcilari WHERE sinav_id = ?) WHERE id = ?\", [sinav_id, sinav_id]);",
  "    res.json({ success: true, added, skipped });"
].join('\n');
if(!pattern.test(s)) { console.error('pattern not found'); process.exit(1); }
s = s.replace(pattern, replacement);
fs.writeFileSync('server.js', s, 'utf8');
