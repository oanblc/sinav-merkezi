# Git Push "Empty reply from server" Hatası Çözümü

## 🔧 Hızlı Çözümler

### Çözüm 1: Git Credential Helper Kullan
```bash
git config --global credential.helper manager-core
```
Windows'ta bu genellikle çalışır.

### Çözüm 2: HTTPS Yerine SSH Kullan
```bash
# SSH key'iniz varsa
git remote set-url origin git@github.com:oanblc/sinav-merkezi.git
git push origin main
```

### Çözüm 3: GitHub Desktop Kullan
1. GitHub Desktop uygulamasını indirin: https://desktop.github.com/
2. Repository'yi açın
3. Commit yapın ve Push butonuna tıklayın

### Çözüm 4: İnternet Bağlantısını Kontrol Et
- VPN kullanıyorsanız kapatın
- Farklı bir ağ deneyin
- Firewall ayarlarını kontrol edin

### Çözüm 5: Git Cache'i Temizle
```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
git push origin main
```

### Çözüm 6: Manuel Push (GitHub Web)
1. Değişiklikleri ZIP olarak indirin
2. GitHub.com → Repository → Upload files
3. Dosyaları yükleyin

## 🚀 En Kolay Yöntem: GitHub Desktop

1. **GitHub Desktop İndir**: https://desktop.github.com/
2. **Repository Aç**: File → Add Local Repository → Proje klasörünü seç
3. **Commit & Push**: Değişiklikleri commit edip push edin

Bu yöntem genellikle tüm sorunları çözer!

