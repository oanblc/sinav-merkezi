const https = require('https');

console.log('\n🔍 ═══════════════════════════════════');
console.log('🔍 WHATSAPP API DEBUG');
console.log('🔍 ═══════════════════════════════════\n');

// Test 1: API durumunu kontrol et
console.log('📡 Test 1: API Bağlantı Testi...\n');

const options = {
  hostname: 'gate.whapi.cloud',
  path: '/settings',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer FlgFVATCKHmTbjRUC0umHJ8yTDuffHFZ',
    'Content-Type': 'application/json'
  }
};

const req1 = https.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('✅ API Status Code:', res.statusCode);
    console.log('📦 Response:', data);
    console.log('\n─────────────────────────────────\n');
    
    // Test 2: Mesaj gönderme testi
    console.log('📡 Test 2: Mesaj Gönderme Testi...\n');
    
    const testMessage = {
      typing_time: 0,
      to: '905413902425@s.whatsapp.net',
      body: '🧪 Test mesajı - Sınav Merkezi'
    };
    
    const postData = JSON.stringify(testMessage);
    
    const options2 = {
      hostname: 'gate.whapi.cloud',
      path: '/messages/text',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer FlgFVATCKHmTbjRUC0umHJ8yTDuffHFZ',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    console.log('📤 Gönderilen Data:', postData);
    
    const req2 = https.request(options2, (res2) => {
      let data2 = '';
      
      res2.on('data', (chunk) => {
        data2 += chunk;
      });
      
      res2.on('end', () => {
        console.log('\n✅ Mesaj API Status Code:', res2.statusCode);
        console.log('📦 Mesaj Response:', data2);
        
        try {
          const result = JSON.parse(data2);
          console.log('\n📋 Detaylı Response:');
          console.log(JSON.stringify(result, null, 2));
          
          if (result.error) {
            console.log('\n❌ HATA DETAYI:', result.error);
          }
        } catch (e) {
          console.log('\n⚠️  JSON Parse Hatası:', e.message);
        }
        
        console.log('\n🔍 ═══════════════════════════════════');
      });
    });
    
    req2.on('error', (error) => {
      console.error('\n❌ Mesaj gönderme hatası:', error.message);
      console.log('🔍 ═══════════════════════════════════');
    });
    
    req2.write(postData);
    req2.end();
  });
});

req1.on('error', (error) => {
  console.error('\n❌ API bağlantı hatası:', error.message);
  console.log('🔍 ═══════════════════════════════════');
});

req1.end();



