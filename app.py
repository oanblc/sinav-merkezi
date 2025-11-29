from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import pandas as pd
import os
from datetime import datetime
import json

app = Flask(__name__)

# Template filter ekle
@app.template_filter('from_json')
def from_json_filter(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except:
            return {}
    return value
app.config['SECRET_KEY'] = 'your-secret-key-change-this-in-production'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///sinav_merkezi.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# Klasörleri oluştur
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs('static', exist_ok=True)
os.makedirs('templates', exist_ok=True)

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'
login_manager.login_message = 'Lütfen giriş yapın.'

# Veritabanı Modelleri
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    user_type = db.Column(db.String(20), nullable=False)  # 'veli' veya 'rehber_ogretmen'
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Ogrenci(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ad_soyad = db.Column(db.String(200), nullable=False)
    tc_no = db.Column(db.String(11), unique=True)
    veli_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Sinav(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ad = db.Column(db.String(200), nullable=False)
    tarih = db.Column(db.Date, nullable=False)
    dosya_yolu = db.Column(db.String(500))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class SinavSonucu(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sinav_id = db.Column(db.Integer, db.ForeignKey('sinav.id'), nullable=False)
    ogrenci_id = db.Column(db.Integer, db.ForeignKey('ogrenci.id'), nullable=False)
    sayfa_no = db.Column(db.Integer, nullable=False)
    sonuc_verisi = db.Column(db.Text)  # JSON formatında
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Yardımcı Fonksiyonlar
def allowed_file(filename):
    ALLOWED_EXTENSIONS = {'xlsx', 'xls', 'csv'}
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def dataframe_sayfalara_ayir(df, sayfa_boyutu=50):
    """DataFrame'i sayfalara ayırır"""
    sayfalar = []
    toplam_satir = len(df)
    sayfa_sayisi = (toplam_satir + sayfa_boyutu - 1) // sayfa_boyutu
    
    for i in range(sayfa_sayisi):
        baslangic = i * sayfa_boyutu
        bitis = min((i + 1) * sayfa_boyutu, toplam_satir)
        sayfa_df = df.iloc[baslangic:bitis]
        sayfalar.append({
            'sayfa_no': i + 1,
            'veri': sayfa_df.to_dict('records')
        })
    
    return sayfalar

def normalize_isim(isim):
    """İsim normalizasyonu - boşlukları düzenle, büyük/küçük harf duyarsız"""
    if not isim:
        return ""
    # String'e çevir, boşlukları normalize et
    isim = str(isim).strip()
    # Çoklu boşlukları tek boşluğa çevir
    while '  ' in isim:
        isim = isim.replace('  ', ' ')
    return isim

def ogrenci_eslestir(df, ogrenci_adi_kolonu='Ad Soyad'):
    """DataFrame'deki öğrenci isimlerini veritabanındaki öğrencilerle eşleştirir"""
    eslesmeler = []
    
    if ogrenci_adi_kolonu not in df.columns:
        # Kolon adını bulmaya çalış
        olası_kolonlar = [col for col in df.columns if any(kelime in col.lower() for kelime in ['ad', 'isim', 'name', 'öğrenci', 'student'])]
        if olası_kolonlar:
            ogrenci_adi_kolonu = olası_kolonlar[0]
        else:
            return eslesmeler
    
    # Tüm öğrencileri çek (performans için)
    tum_ogrenciler = {normalize_isim(ogr.ad_soyad).lower(): ogr for ogr in Ogrenci.query.all()}
    
    for idx, row in df.iterrows():
        ogrenci_adi = normalize_isim(row[ogrenci_adi_kolonu])
        ogrenci_adi_lower = ogrenci_adi.lower()
        
        # Eşleştirme yap
        ogrenci = tum_ogrenciler.get(ogrenci_adi_lower)
        
        if ogrenci:
            eslesmeler.append({
                'satir_no': idx + 1,
                'ogrenci_id': ogrenci.id,
                'ogrenci_adi': ogrenci_adi,
                'eslesme': True
            })
        else:
            eslesmeler.append({
                'satir_no': idx + 1,
                'ogrenci_id': None,
                'ogrenci_adi': ogrenci_adi,
                'eslesme': False
            })
    
    return eslesmeler

# Routes
@app.route('/')
def index():
    if current_user.is_authenticated:
        if current_user.user_type == 'veli':
            return redirect(url_for('veli_dashboard'))
        elif current_user.user_type == 'rehber_ogretmen':
            return redirect(url_for('rehber_dashboard'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        user = User.query.filter_by(username=username).first()
        
        if user and check_password_hash(user.password_hash, password):
            login_user(user)
            if user.user_type == 'veli':
                return redirect(url_for('veli_dashboard'))
            elif user.user_type == 'rehber_ogretmen':
                return redirect(url_for('rehber_dashboard'))
        
        flash('Kullanıcı adı veya şifre hatalı!', 'error')
    
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        user_type = request.form.get('user_type')
        
        if User.query.filter_by(username=username).first():
            flash('Bu kullanıcı adı zaten kullanılıyor!', 'error')
            return render_template('register.html')
        
        if User.query.filter_by(email=email).first():
            flash('Bu e-posta adresi zaten kullanılıyor!', 'error')
            return render_template('register.html')
        
        user = User(
            username=username,
            email=email,
            password_hash=generate_password_hash(password),
            user_type=user_type
        )
        db.session.add(user)
        db.session.commit()
        
        flash('Kayıt başarılı! Giriş yapabilirsiniz.', 'success')
        return redirect(url_for('login'))
    
    return render_template('register.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/veli/dashboard')
@login_required
def veli_dashboard():
    if current_user.user_type != 'veli':
        flash('Bu sayfaya erişim yetkiniz yok!', 'error')
        return redirect(url_for('index'))
    
    ogrenciler = Ogrenci.query.filter_by(veli_id=current_user.id).all()
    return render_template('veli_dashboard.html', ogrenciler=ogrenciler)

@app.route('/rehber/dashboard')
@login_required
def rehber_dashboard():
    if current_user.user_type != 'rehber_ogretmen':
        flash('Bu sayfaya erişim yetkiniz yok!', 'error')
        return redirect(url_for('index'))
    
    sinavlar = Sinav.query.order_by(Sinav.tarih.desc()).all()
    return render_template('rehber_dashboard.html', sinavlar=sinavlar)

@app.route('/rehber/sinav-yukle', methods=['GET', 'POST'])
@login_required
def sinav_yukle():
    if current_user.user_type != 'rehber_ogretmen':
        flash('Bu sayfaya erişim yetkiniz yok!', 'error')
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        if 'file' not in request.files:
            flash('Dosya seçilmedi!', 'error')
            return redirect(request.url)
        
        file = request.files['file']
        sinav_adi = request.form.get('sinav_adi')
        sinav_tarihi = request.form.get('sinav_tarihi')
        
        if file.filename == '':
            flash('Dosya seçilmedi!', 'error')
            return redirect(request.url)
        
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"{timestamp}_{filename}"
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(filepath)
            
            try:
                # Dosyayı oku
                if filename.endswith('.csv'):
                    df = pd.read_csv(filepath, encoding='utf-8')
                else:
                    df = pd.read_excel(filepath)
                
                # Sınav kaydı oluştur
                sinav = Sinav(
                    ad=sinav_adi,
                    tarih=datetime.strptime(sinav_tarihi, '%Y-%m-%d').date(),
                    dosya_yolu=filepath
                )
                db.session.add(sinav)
                db.session.flush()
                
                # DataFrame'i sayfalara ayır
                sayfalar = dataframe_sayfalara_ayir(df)
                
                # Öğrenci eşleştirme
                eslesmeler = ogrenci_eslestir(df)
                # Eşleşmeleri dictionary'ye çevir (satır numarasına göre)
                eslesme_dict = {es['satir_no']: es for es in eslesmeler}
                
                # Öğrenci adı kolonunu bul
                ogrenci_adi_kolonu = None
                for col in df.columns:
                    if any(kelime in str(col).lower() for kelime in ['ad', 'isim', 'name', 'öğrenci', 'student']):
                        ogrenci_adi_kolonu = col
                        break
                
                # Sınav sonuçlarını kaydet
                kaydedilen_sayisi = 0
                for sayfa in sayfalar:
                    for idx, veri in enumerate(sayfa['veri']):
                        # DataFrame'deki gerçek satır numarasını bul
                        sayfa_baslangic = (sayfa['sayfa_no'] - 1) * 50
                        gercek_satir_no = sayfa_baslangic + idx + 1
                        
                        # Eşleşme kontrolü
                        eslesme = eslesme_dict.get(gercek_satir_no)
                        
                        if eslesme and eslesme['eslesme'] and eslesme['ogrenci_id']:
                            sinav_sonucu = SinavSonucu(
                                sinav_id=sinav.id,
                                ogrenci_id=eslesme['ogrenci_id'],
                                sayfa_no=sayfa['sayfa_no'],
                                sonuc_verisi=json.dumps(veri, ensure_ascii=False, default=str)
                            )
                            db.session.add(sinav_sonucu)
                            kaydedilen_sayisi += 1
                
                db.session.commit()
                flash(f'Sınav başarıyla yüklendi! {kaydedilen_sayisi} öğrenci sonucu kaydedildi.', 'success')
                return redirect(url_for('rehber_dashboard'))
            
            except Exception as e:
                db.session.rollback()
                flash(f'Dosya işlenirken hata oluştu: {str(e)}', 'error')
                return redirect(request.url)
    
    return render_template('sinav_yukle.html')

@app.route('/veli/sinav-sonuclari/<int:ogrenci_id>')
@login_required
def sinav_sonuclari(ogrenci_id):
    if current_user.user_type != 'veli':
        flash('Bu sayfaya erişim yetkiniz yok!', 'error')
        return redirect(url_for('index'))
    
    ogrenci = Ogrenci.query.get_or_404(ogrenci_id)
    
    # Veli kontrolü
    if ogrenci.veli_id != current_user.id:
        flash('Bu öğrencinin sonuçlarına erişim yetkiniz yok!', 'error')
        return redirect(url_for('veli_dashboard'))
    
    sonuclar = SinavSonucu.query.filter_by(ogrenci_id=ogrenci_id).order_by(SinavSonucu.created_at.desc()).all()
    
    # Sonuçları grupla (sınav bazında)
    sinav_sonuclari = {}
    for sonuc in sonuclar:
        sinav = Sinav.query.get(sonuc.sinav_id)
        if sinav.id not in sinav_sonuclari:
            sinav_sonuclari[sinav.id] = {
                'sinav': sinav,
                'sonuclar': []
            }
        sinav_sonuclari[sinav.id]['sonuclar'].append(sonuc)
    
    return render_template('sinav_sonuclari.html', ogrenci=ogrenci, sinav_sonuclari=sinav_sonuclari)

@app.route('/rehber/ogrenci-ekle', methods=['GET', 'POST'])
@login_required
def ogrenci_ekle():
    if current_user.user_type != 'rehber_ogretmen':
        flash('Bu sayfaya erişim yetkiniz yok!', 'error')
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        ad_soyad = request.form.get('ad_soyad')
        tc_no = request.form.get('tc_no')
        veli_username = request.form.get('veli_username')
        
        veli = User.query.filter_by(username=veli_username, user_type='veli').first()
        if not veli:
            flash('Veli kullanıcısı bulunamadı!', 'error')
            return render_template('ogrenci_ekle.html')
        
        ogrenci = Ogrenci(
            ad_soyad=ad_soyad,
            tc_no=tc_no,
            veli_id=veli.id
        )
        db.session.add(ogrenci)
        db.session.commit()
        
        flash('Öğrenci başarıyla eklendi!', 'success')
        return redirect(url_for('rehber_dashboard'))
    
    return render_template('ogrenci_ekle.html')

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, host='0.0.0.0', port=5000)

