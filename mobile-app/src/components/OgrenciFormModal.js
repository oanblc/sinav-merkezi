import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiPost } from '../api';

export default function OgrenciFormModal({ gorunur, ogrenci, onKapat, onKaydedildi }) {
  const duzenleme = !!(ogrenci && ogrenci.id);
  const [adSoyad, setAdSoyad] = useState('');
  const [tcNo, setTcNo] = useState('');
  const [telefon, setTelefon] = useState('');
  const [okul, setOkul] = useState('');
  const [sinif, setSinif] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  useEffect(() => {
    if (gorunur) {
      setAdSoyad(ogrenci?.ad_soyad || '');
      setTcNo(ogrenci?.tc_no || '');
      setTelefon(ogrenci?.telefon || '');
      setOkul(ogrenci?.okul || '');
      setSinif(ogrenci?.sinif ? String(ogrenci.sinif) : '');
      setHata('');
    }
  }, [gorunur, ogrenci]);

  async function kaydet() {
    setHata('');
    if (!adSoyad.trim() || !okul.trim() || !sinif.trim()) {
      setHata('Ad soyad, okul ve sınıf zorunludur.');
      return;
    }
    setYukleniyor(true);
    try {
      const govde = { ad_soyad: adSoyad.trim(), tc_no: tcNo.trim(), telefon: telefon.trim(), okul: okul.trim(), sinif: sinif.trim() };
      const yol = duzenleme ? `/api/veli/ogrenci-duzenle/${ogrenci.id}` : '/api/veli/ogrenci-ekle';
      const { data } = await apiPost(yol, govde, true);
      if (data.success) { onKaydedildi && onKaydedildi(); }
      else setHata(data.message || 'İşlem başarısız.');
    } catch (e) { setHata('Sunucuya ulaşılamadı.'); }
    finally { setYukleniyor(false); }
  }

  return (
    <Modal visible={gorunur} animationType="slide" transparent onRequestClose={onKapat}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>{duzenleme ? 'Öğrenci Düzenle' : 'Öğrenci Ekle'}</Text>
            <TouchableOpacity onPress={onKapat} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            {hata ? (
              <View style={styles.hataBox}>
                <Ionicons name="alert-circle" size={18} color={colors.danger} />
                <Text style={styles.hataText}>{hata}</Text>
              </View>
            ) : null}

            <Alan etiket="Ad Soyad *" deger={adSoyad} setir={setAdSoyad} placeholder="Öğrencinin adı soyadı" />
            <Alan etiket="Okul *" deger={okul} setir={setOkul} placeholder="Okul adı" />
            <Alan etiket="Sınıf *" deger={sinif} setir={setSinif} placeholder="Örn: 5" keyboard="default" />
            <Alan etiket="TC Kimlik No" deger={tcNo} setir={(v) => setTcNo(v.replace(/\D/g, '').slice(0, 11))} placeholder="(İsteğe bağlı)" keyboard="number-pad" />
            <Alan etiket="Telefon" deger={telefon} setir={setTelefon} placeholder="(İsteğe bağlı)" keyboard="phone-pad" />

            <TouchableOpacity style={styles.kaydet} onPress={kaydet} disabled={yukleniyor} activeOpacity={0.85}>
              {yukleniyor ? <ActivityIndicator color={colors.white} /> : (
                <>
                  <Ionicons name="checkmark-circle" size={18} color={colors.white} />
                  <Text style={styles.kaydetText}>{duzenleme ? 'Güncelle' : 'Kaydet'}</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Alan({ etiket, deger, setir, placeholder, keyboard = 'default' }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{etiket}</Text>
      <TextInput style={styles.input} value={deger} onChangeText={setir}
        placeholder={placeholder} placeholderTextColor="#94a3b8" keyboardType={keyboard} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '88%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { fontSize: fs.lg, fontWeight: '800', color: colors.text },

  hataBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef2f2', borderRadius: 10, padding: 10, marginBottom: 14 },
  hataText: { color: colors.danger, fontSize: fs.sm, flex: 1 },

  label: { fontSize: fs.sm, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  input: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: 14, height: 50, fontSize: fs.base, color: colors.text, backgroundColor: colors.bg },

  kaydet: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.blue, borderRadius: radius.button, height: 52, marginTop: 8, marginBottom: 20 },
  kaydetText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },
});
