# Railway Deploy için hazırlık

# 1. .gitignore oluştur
node_modules/
.env
*.log
.DS_Store

# 2. package.json'da start script kontrol et
{
  "scripts": {
    "start": "node server.js"
  }
}

# 3. Railway'e push
git add .
git commit -m "Ready for Railway deploy"
git push

