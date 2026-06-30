import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Linking, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiGet } from '../api';
import { getToken } from '../auth';
import { API_BASE_URL } from '../config';
import AppHeader from '../components/AppHeader';

const AYLAR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
function tarihFormat(t) {
  const d = new Date(t);
  if (isNaN(d)) return t || '';
  return `${d.getDate()} ${AYLAR[d.getMonth()]} ${d.getFullYear()}`;
}

export default function SonuclarScreen() {
  const [sonuclar, setSonuclar] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [yenileniyor, setYenileniyor] = useState(false);
  const [hata, setHata] = useState('');

  const yukle = useCallback(async () => {
    setHata('');
    try {
      const { data } = await apiGet('/api/veli/sonuclar');
      if (data.success) setSonuclar(data.sonuclar || []);
      else setHata(data.message || 'Sonuçlar alınamadı.');
    } catch (e) { setHata('Sunucuya ulaşılamadı.'); }
    finally { setYukleniyor(false); setYenileniyor(false); }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  async function pdfAc(id) {
    try {
      const token = await getToken();
      const url = `${API_BASE_URL}/api/veli/sonuc-pdf/${id}?token=${encodeURIComponent(token || '')}`;
      const ok = await Linking.canOpenURL(url);
      if (ok) Linking.openURL(url);
      else Alert.alert('Hata', 'PDF açılamadı.');
    } catch (e) {
      Alert.alert('Hata', 'PDF açılırken bir sorun oluştu.');
    }
  }

  if (yukleniyor) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppHeader ikon="document-text" baslik="Sınav Sonuçları" altyazi="Öğrencilerinizin sınav sonuçları" />
        <View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /></View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader ikon="document-text" baslik="Sınav Sonuçları" altyazi="Öğrencilerinizin sınav sonuçları" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 20, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={yenileniyor} onRefresh={() => { setYenileniyor(true); yukle(); }} />}>

        {hata ? <View style={styles.hataBox}><Text style={styles.hataText}>{hata}</Text></View> : null}

        {sonuclar.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="document-text-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>Henüz sonuç yok</Text>
            <Text style={styles.emptyText}>Öğrencilerinizin sınav sonuçları açıklandığında buradan görüntüleyebileceksiniz.</Text>
          </View>
        ) : (
          sonuclar.map((r) => (
            <View key={r.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sinavAd}>{r.sinav_adi}</Text>
                  <Text style={styles.ogrenci}>{r.ogrenci_adi_soyadi}</Text>
                </View>
                <View style={styles.durumRozet}>
                  <Text style={styles.durumText}>Yayınlandı</Text>
                </View>
              </View>
              <View style={styles.metaRow}>
                <Meta ikon="calendar-outline" text={tarihFormat(r.sinav_tarihi)} />
                {r.sinif ? <Meta ikon="book-outline" text={`${r.sinif}. Sınıf`} /> : null}
                {r.ders ? <Meta ikon="library-outline" text={r.ders} /> : null}
              </View>
              {r.pdf_var ? (
                <TouchableOpacity style={styles.pdfBtn} onPress={() => pdfAc(r.id)} activeOpacity={0.85}>
                  <Ionicons name="document-text" size={18} color={colors.white} />
                  <Text style={styles.pdfBtnText}>Sonuç Karnesini Aç (PDF)</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function Meta({ ikon, text }) {
  return (
    <View style={styles.metaChip}>
      <Ionicons name={ikon} size={13} color={colors.textMuted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hataBox: { backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, marginBottom: 12 },
  hataText: { color: colors.danger, fontSize: fs.sm },

  empty: { alignItems: 'center', paddingVertical: 48, backgroundColor: colors.white, borderRadius: radius.card, marginTop: 4 },
  emptyTitle: { fontSize: fs.md, fontWeight: '700', color: colors.textMuted, marginTop: 14 },
  emptyText: { color: '#94a3b8', fontSize: fs.sm, marginTop: 6, textAlign: 'center', paddingHorizontal: 24, lineHeight: 20 },

  card: { backgroundColor: colors.white, borderRadius: radius.card, padding: 16, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: colors.success },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  sinavAd: { fontSize: fs.base, fontWeight: '700', color: colors.text },
  ogrenci: { fontSize: fs.sm, color: colors.textMuted, marginTop: 2 },
  durumRozet: { backgroundColor: '#ecfdf5', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  durumText: { color: colors.success, fontSize: fs.xs, fontWeight: '700' },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: fs.xs, color: colors.textMuted },

  pdfBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.blue, borderRadius: radius.button, paddingVertical: 12, marginTop: 14 },
  pdfBtnText: { color: colors.white, fontSize: fs.sm, fontWeight: '700' },
});
