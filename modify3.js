const fs=require('fs');
let s=fs.readFileSync('server.js','utf8');
if(!s.includes('idx_sinav_katilimci_unique')){
  const marker = "  db.run(`ALTER TABLE sinav_katilimcilari ADD COLUMN pdf_indirilme_sayisi INTEGER DEFAULT 0`, (err) => {\n    if (err && !err.message.includes(\"duplicate column\")) console.log(\"pdf_indirilme_sayisi kolonu zaten var veya hata:\", err.message);\n  });\n\n";
  if(!s.includes(marker)) { console.error('marker not found'); process.exit(1); }
  const insert = "  db.run(\"CREATE UNIQUE INDEX IF NOT EXISTS idx_sinav_katilimci_unique ON sinav_katilimcilari (sinav_id, ogrenci_id, ogrenci_kaynak)\", (err) => {\n    if (err && !err.message.includes(\"already exists\")) console.log(\"idx_sinav_katilimci_unique olusturulamadi:\", err.message);\n  });\n\n";
  s = s.replace(marker, marker + insert);
  fs.writeFileSync('server.js', s, 'utf8');
  console.log('index creation snippet inserted');
} else {
  console.log('index snippet already present');
}
