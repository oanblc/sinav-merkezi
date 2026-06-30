import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiPost } from '../api';

function gucSeviyesi(s) {
  if (!s) return { yuzde: 0, renk: colors.border, etiket: '' };
  let p = 0;
  if (s.length >= 6) p += 40;
  if (s.length >= 10) p += 20;
  if (/[A-Z]/.test(s) || /[a-z]/.test(s)) p += 20;
  if (/\d/.test(s)) p += 10;
  if (/[^A-Za-z0-9]/.test(s)) p += 10;
  p = Math.min(p, 100);
  const renk = p < 40 ? colors.danger : p < 70 ? colors.warning : colors.success;
  const etiket = p < 40 ? 'Zayıf' : p < 70 ? 'Orta' : 'Güçlü';
  return { yuzde: p, renk, etiket };
}

export default function SifreDegistirScreen({ veli, onDone }) {
  const [yeni, setYeni] = useState('');
  const [tekrar, setTekrar] = useState('');
  const [goster, setGoster] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  const guc = gucSeviyesi(yeni);

  async function kaydet() {
    setHata('');
    if (yeni.length < 6) { setHata('Şifre en az 6 karakter olmalıdır.'); return; }
    if (yeni !== tekrar) { setHata('Şifreler uyuşmuyor.'); return; }

    setYukleniyor(true);
    try {
      const { data } = await apiPost('/api/veli/sifre-degistir', { yeni_sifre: yeni, yeni_sifre_tekrar: tekrar }, true);
      if (data.success) {
        onDone && onDone();
      } else {
        setHata(data.message || 'İşlem başarısız.');
      }
    } catch (e) {
      setHata('Sunucuya ulaşılamadı.');
    } finally {
      setYukleniyor(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.primary }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.logoCircle}>
            <Ionicons name="shield-checkmark" size={40} color={colors.white} />
          </View>
          <Text style={styles.brand}>Yeni Şifre Belirle</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.info}>
            <Ionicons name="information-circle" size={15} color={colors.blue} />{'  '}
            İlk girişiniz için lütfen yeni bir şifre belirleyin.
          </Text>

          {hata ? (
            <View style={styles.hataBox}>
              <Ionicons name="alert-circle" size={18} color={colors.danger} />
              <Text style={styles.hataText}>{hata}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Yeni Şifre</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} />
            <TextInput style={styles.input} value={yeni} onChangeText={setYeni}
              placeholder="En az 6 karakter" placeholderTextColor="#94a3b8" secureTextEntry={!goster} />
            <TouchableOpacity onPress={() => setGoster(!goster)} hitSlop={10}>
              <Ionicons name={goster ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {yeni ? (
            <View style={styles.gucRow}>
              <View style={styles.gucBarBg}>
                <View style={[styles.gucBar, { width: `${guc.yuzde}%`, backgroundColor: guc.renk }]} />
              </View>
              <Text style={[styles.gucEtiket, { color: guc.renk }]}>{guc.etiket}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Yeni Şifre (Tekrar)</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} />
            <TextInput style={styles.input} value={tekrar} onChangeText={setTekrar}
              placeholder="Şifreyi tekrar girin" placeholderTextColor="#94a3b8" secureTextEntry={!goster} />
          </View>

          <TouchableOpacity style={styles.button} onPress={kaydet} disabled={yukleniyor} activeOpacity={0.85}>
            {yukleniyor ? <ActivityIndicator color={colors.white} /> : <Text style={styles.buttonText}>Kaydet</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 24 },
  logoCircle: { width: 84, height: 84, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  brand: { color: colors.white, fontSize: fs.xl, fontWeight: '800' },

  card: { backgroundColor: colors.card, borderRadius: 20, padding: 24, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  info: { fontSize: fs.sm, color: colors.textMuted, marginBottom: 16, lineHeight: 20 },

  hataBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef2f2', borderRadius: 10, padding: 10, marginBottom: 14 },
  hataText: { color: colors.danger, fontSize: fs.sm, flex: 1 },

  label: { fontSize: fs.sm, fontWeight: '600', color: colors.textMuted, marginBottom: 6, marginTop: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 2, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: 14, height: 52, backgroundColor: colors.bg },
  input: { flex: 1, fontSize: fs.base, color: colors.text },

  gucRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  gucBarBg: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  gucBar: { height: 6, borderRadius: 3 },
  gucEtiket: { fontSize: fs.xs, fontWeight: '700', width: 44, textAlign: 'right' },

  button: { backgroundColor: colors.blue, borderRadius: radius.button, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  buttonText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },
});
