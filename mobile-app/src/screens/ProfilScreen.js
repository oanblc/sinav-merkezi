import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, Linking, Alert, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { colors, fs, radius } from '../theme';
import { apiGet, apiPost } from '../api';
import { pushTokenKaydet } from '../push';
import AppHeader from '../components/AppHeader';

const SITE_URL = 'https://www.adanasinavkulubu.com';

export default function ProfilScreen({ onLogout }) {
  const [profil, setProfil] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [sifreModal, setSifreModal] = useState(false);
  const [bildirimIzin, setBildirimIzin] = useState(null); // 'granted' | 'denied' | 'undetermined'

  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiGet('/api/veli/profil');
        if (data.success) setProfil(data.profil);
        const izin = await Notifications.getPermissionsAsync();
        setBildirimIzin(izin.status);
        // İzin zaten verilmişse token'ı backend'de güncel tut
        if (izin.status === 'granted') pushTokenKaydet();
      } finally { setYukleniyor(false); }
    })();
  }, []);

  async function bildirimToggle(acilsin) {
    if (acilsin) {
      // Açmak istiyor
      const mevcut = await Notifications.getPermissionsAsync();
      if (mevcut.status === 'granted') { setBildirimIzin('granted'); pushTokenKaydet(); return; }
      if (mevcut.status === 'undetermined' || mevcut.canAskAgain) {
        const r = await Notifications.requestPermissionsAsync();
        setBildirimIzin(r.status);
        if (r.status === 'granted') {
          pushTokenKaydet();
        } else {
          Alert.alert('Bildirim İzni', 'İzin verilmedi. Bildirimleri açmak için cihaz ayarlarından izin verebilirsiniz.');
        }
      } else {
        Alert.alert('Bildirim İzni', 'Bildirimleri açmak için cihaz ayarlarından izin vermeniz gerekir.', [
          { text: 'İptal', style: 'cancel' },
          { text: 'Ayarlara Git', onPress: () => Linking.openSettings() },
        ]);
      }
    } else {
      // Kapatmak istiyor — sistem izni uygulamadan kapatılamaz, ayarlara yönlendir
      Alert.alert('Bildirim İzni', 'Bildirimleri kapatmak için cihaz ayarlarını kullanmanız gerekir.', [
        { text: 'İptal', style: 'cancel' },
        { text: 'Ayarlara Git', onPress: () => Linking.openSettings() },
      ]);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader ikon="person" baslik="Profil" altyazi="Hesap bilgileri ve uygulama ayarları" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 20, paddingBottom: 32 }}>
        {yukleniyor ? (
          <ActivityIndicator size="large" color={colors.blue} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Veli bilgi kartı */}
            <View style={styles.infoCard}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(profil?.ad_soyad || 'V').charAt(0).toUpperCase()}</Text>
              </View>
              <Text style={styles.ad}>{profil?.ad_soyad}</Text>
              <View style={styles.infoRow}>
                <Ionicons name="card-outline" size={16} color={colors.textMuted} />
                <Text style={styles.infoText}>TC: {profil?.username}</Text>
              </View>
              {profil?.telefon ? (
                <View style={styles.infoRow}>
                  <Ionicons name="call-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.infoText}>{profil.telefon}</Text>
                </View>
              ) : null}
            </View>

            {/* Gerekli İzinler */}
            <Text style={styles.sectionLabel}>GEREKLİ İZİNLER</Text>
            <View style={styles.menu}>
              <MenuItem ikon="notifications-outline" etiket="Bildirim İzni"
                sag={
                  <Switch
                    value={bildirimIzin === 'granted'}
                    onValueChange={bildirimToggle}
                    trackColor={{ false: '#cbd5e1', true: colors.success }}
                    thumbColor={colors.white}
                    ios_backgroundColor="#cbd5e1"
                  />
                }
                onPress={() => bildirimToggle(bildirimIzin !== 'granted')} />
            </View>

            {/* Hesap */}
            <Text style={styles.sectionLabel}>HESAP</Text>
            <View style={styles.menu}>
              <MenuItem ikon="lock-closed-outline" etiket="Şifre Değiştir" onPress={() => setSifreModal(true)} />
            </View>

            {/* Yasal */}
            <Text style={styles.sectionLabel}>YASAL</Text>
            <View style={styles.menu}>
              <MenuItem ikon="shield-checkmark-outline" etiket="Gizlilik Politikası"
                onPress={() => Linking.openURL(SITE_URL + '/gizlilik-politikasi')} />
              <Ayrac />
              <MenuItem ikon="document-text-outline" etiket="Kullanım Koşulları"
                onPress={() => Linking.openURL(SITE_URL + '/kullanim-kosullari')} />
              <Ayrac />
              <MenuItem ikon="globe-outline" etiket="Web Sitesine Git"
                onPress={() => Linking.openURL(SITE_URL)} />
            </View>

            <TouchableOpacity style={styles.cikis} onPress={onLogout} activeOpacity={0.85}>
              <Ionicons name="log-out-outline" size={20} color={colors.white} />
              <Text style={styles.cikisText}>Çıkış Yap</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      <SifreModal gorunur={sifreModal} onKapat={() => setSifreModal(false)} />
    </View>
  );
}

function MenuItem({ ikon, etiket, onPress, sag }) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={ikon} size={20} color={colors.blue} />
      <Text style={styles.menuText}>{etiket}</Text>
      {sag || <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />}
    </TouchableOpacity>
  );
}
function Ayrac() { return <View style={styles.ayrac} />; }

function SifreModal({ gorunur, onKapat }) {
  const [yeni, setYeni] = useState('');
  const [tekrar, setTekrar] = useState('');
  const [goster, setGoster] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  async function kaydet() {
    setHata('');
    if (yeni.length < 6) { setHata('Şifre en az 6 karakter olmalıdır.'); return; }
    if (yeni !== tekrar) { setHata('Şifreler uyuşmuyor.'); return; }
    setYukleniyor(true);
    try {
      const { data } = await apiPost('/api/veli/sifre-degistir', { yeni_sifre: yeni, yeni_sifre_tekrar: tekrar }, true);
      if (data.success) {
        setYeni(''); setTekrar('');
        onKapat();
        Alert.alert('Başarılı', 'Şifreniz başarıyla değiştirildi.');
      } else setHata(data.message || 'İşlem başarısız.');
    } catch (e) { setHata('Sunucuya ulaşılamadı.'); }
    finally { setYukleniyor(false); }
  }

  return (
    <Modal visible={gorunur} animationType="slide" transparent onRequestClose={onKapat}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Şifre Değiştir</Text>
            <TouchableOpacity onPress={onKapat} hitSlop={10}><Ionicons name="close" size={24} color={colors.textMuted} /></TouchableOpacity>
          </View>
          {hata ? (
            <View style={styles.hataBox}><Ionicons name="alert-circle" size={18} color={colors.danger} /><Text style={styles.hataText}>{hata}</Text></View>
          ) : null}
          <Text style={styles.label}>Yeni Şifre</Text>
          <View style={styles.inputWrap}>
            <TextInput style={styles.input} value={yeni} onChangeText={setYeni} placeholder="En az 6 karakter" placeholderTextColor="#94a3b8" secureTextEntry={!goster} />
            <TouchableOpacity onPress={() => setGoster(!goster)} hitSlop={10}><Ionicons name={goster ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} /></TouchableOpacity>
          </View>
          <Text style={styles.label}>Yeni Şifre (Tekrar)</Text>
          <View style={styles.inputWrap}>
            <TextInput style={styles.input} value={tekrar} onChangeText={setTekrar} placeholder="Tekrar girin" placeholderTextColor="#94a3b8" secureTextEntry={!goster} />
          </View>
          <TouchableOpacity style={styles.kaydet} onPress={kaydet} disabled={yukleniyor}>
            {yukleniyor ? <ActivityIndicator color={colors.white} /> : <Text style={styles.kaydetText}>Kaydet</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  infoCard: { backgroundColor: colors.card, borderRadius: radius.card, padding: 24, alignItems: 'center', marginBottom: 16, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  avatar: { width: 72, height: 72, borderRadius: 20, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarText: { color: colors.white, fontSize: fs.xxl, fontWeight: '800' },
  ad: { fontSize: fs.lg, fontWeight: '800', color: colors.text, marginBottom: 10 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  infoText: { fontSize: fs.sm, color: colors.textMuted },

  sectionLabel: { fontSize: fs.xs, fontWeight: '700', color: colors.textMuted, marginBottom: 8, marginLeft: 4, letterSpacing: 0.5 },
  menu: { backgroundColor: colors.card, borderRadius: radius.card, paddingHorizontal: 16, marginBottom: 20 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
  menuText: { flex: 1, fontSize: fs.base, color: colors.text, fontWeight: '600' },
  ayrac: { height: 1, backgroundColor: colors.border },

  cikis: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.danger, borderRadius: radius.button, height: 52 },
  cikisText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sheetTitle: { fontSize: fs.lg, fontWeight: '800', color: colors.text },
  hataBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef2f2', borderRadius: 10, padding: 10, marginBottom: 14 },
  hataText: { color: colors.danger, fontSize: fs.sm, flex: 1 },
  label: { fontSize: fs.sm, fontWeight: '600', color: colors.textMuted, marginBottom: 6, marginTop: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 2, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: 14, height: 52, backgroundColor: colors.bg },
  input: { flex: 1, fontSize: fs.base, color: colors.text },
  kaydet: { backgroundColor: colors.blue, borderRadius: radius.button, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  kaydetText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },
});
