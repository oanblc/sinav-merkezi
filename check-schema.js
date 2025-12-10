const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'sinav_merkezi.db'));

db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
  console.log('TABLOLAR:');
  tables.forEach(t => console.log(' -', t.name));

  // ogrenciler tablosu kolonlari
  db.all("PRAGMA table_info(ogrenciler)", [], (err, cols) => {
    console.log('\nOGRENCILER KOLONLARI:');
    cols.forEach(c => console.log('  ', c.name, '-', c.type));
    db.close();
  });
});
