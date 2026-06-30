import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiPost } from '../api';
import { saveSession } from '../auth';

export default function LoginScreen({ onLogin }) {
  const [tc, setTc] = useState('');
  const [sifre, setSifre] = useState('');
  const [sifreGoster, setSifreGoster] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  async function girisYap() {
    setHata('');
    if (tc.length !== 11) { setHata('TC Kimlik No 11 haneli olmalıdır.'); return; }
    if (!sifre) { setHata('Lütfen şifrenizi girin.'); return; }

    setYukleniyor(true);
    try {
      const { data } = await apiPost('/api/veli/giris', { tc, sifre });
      if (data.success) {
        await saveSession(data.token, data.veli);
        onLogin && onLogin(data.veli);
      } else {
        setHata(data.message || 'Giriş başarısız.');
      }
    } catch (e) {
      setHata('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
    } finally {
      setYukleniyor(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.primary }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Logo / başlık */}
        <View style={styles.header}>
          <View style={styles.logoCircle}>
            <Ionicons name="school" size={40} color={colors.white} />
          </View>
          <Text style={styles.brand}>Adana Sınav Kulübü</Text>
        </View>

        {/* Giriş kartı */}
        <View style={styles.card}>
          <Text style={styles.title}>Giriş Yap</Text>

          {hata ? (
            <View style={styles.hataBox}>
              <Ionicons name="alert-circle" size={18} color={colors.danger} />
              <Text style={styles.hataText}>{hata}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>TC Kimlik No</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="person-outline" size={20} color={colors.textMuted} />
            <TextInput
              style={styles.input}
              value={tc}
              onChangeText={(t) => setTc(t.replace(/\D/g, '').slice(0, 11))}
              placeholder="11 haneli TC Kimlik No"
              placeholderTextColor="#94a3b8"
              keyboardType="number-pad"
              maxLength={11}
            />
          </View>

          <Text style={styles.label}>Şifre</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} />
            <TextInput
              style={styles.input}
              value={sifre}
              onChangeText={setSifre}
              placeholder="Şifreniz"
              placeholderTextColor="#94a3b8"
              secureTextEntry={!sifreGoster}
            />
            <TouchableOpacity onPress={() => setSifreGoster(!sifreGoster)} hitSlop={10}>
              <Ionicons name={sifreGoster ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.button} onPress={girisYap} disabled={yukleniyor} activeOpacity={0.85}>
            {yukleniyor
              ? <ActivityIndicator color={colors.white} />
              : <Text style={styles.buttonText}>Giriş Yap</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.forgot} onPress={() => Alert.alert('Şifremi Unuttum', 'Lütfen kurumunuzla iletişime geçin.')}>
            <Text style={styles.forgotText}>Şifremi unuttum</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>İlk şifreniz TC Kimlik Numaranızdır.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 28 },
  logoCircle: {
    width: 84, height: 84, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  brand: { color: colors.white, fontSize: fs.xl, fontWeight: '800' },
  brandSub: { color: 'rgba(255,255,255,0.8)', fontSize: fs.base, marginTop: 4 },

  card: { backgroundColor: colors.card, borderRadius: 20, padding: 24, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  title: { fontSize: fs.lg, fontWeight: '800', color: colors.text, marginBottom: 18 },

  hataBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef2f2', borderRadius: 10, padding: 10, marginBottom: 14 },
  hataText: { color: colors.danger, fontSize: fs.sm, flex: 1 },

  label: { fontSize: fs.sm, fontWeight: '600', color: colors.textMuted, marginBottom: 6, marginTop: 8 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 2, borderColor: colors.border, borderRadius: radius.button,
    paddingHorizontal: 14, height: 52, backgroundColor: colors.bg,
  },
  input: { flex: 1, fontSize: fs.base, color: colors.text },

  button: { backgroundColor: colors.blue, borderRadius: radius.button, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  buttonText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },

  forgot: { alignItems: 'center', marginTop: 16 },
  forgotText: { color: colors.blue, fontSize: fs.sm, fontWeight: '600' },

  footer: { color: 'rgba(255,255,255,0.7)', fontSize: fs.xs, textAlign: 'center', marginTop: 24 },
});
