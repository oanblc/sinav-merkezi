import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiGet } from '../api';
import AppHeader from '../components/AppHeader';

const AYLAR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

function tarihFormat(t) {
  const d = new Date(t);
  if (isNaN(d)) return t;
  return `${d.getDate()} ${AYLAR[d.getMonth()]} ${d.getFullYear()}`;
}
function geriSayim(t) {
  const d = new Date(t); const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
  const fark = Math.round((d - bugun) / 86400000);
  if (fark === 0) return 'Bugün';
  if (fark === 1) return 'Yarın';
  return `${fark} gün`;
}

export default function TakvimScreen() {
  const insets = useSafeAreaInsets();
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [yenileniyor, setYenileniyor] = useState(false);
  const [hata, setHata] = useState('');

  const yukle = useCallback(async () => {
    setHata('');
    try {
      const { data } = await apiGet('/api/veli/takvim');
      if (data.success) setVeri(data); else setHata(data.message || 'Takvim alınamadı.');
    } catch (e) { setHata('Sunucuya ulaşılamadı.'); }
    finally { setYukleniyor(false); setYenileniyor(false); }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  if (yukleniyor) {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /></View>;
  }

  const yaklasan = veri?.yaklasan || [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader ikon="calendar" baslik="Sınav Takvimi" altyazi="Tüm öğrencilerinizin yaklaşan sınavları" />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={yenileniyor} onRefresh={() => { setYenileniyor(true); yukle(); }} />}>

        {hata ? <View style={styles.hataBox}><Text style={styles.hataText}>{hata}</Text></View> : null}

        {/* 3 istatistik */}
        <View style={styles.statRow}>
          <Stat sayi={veri?.ogrenci_sayisi || 0} etiket="Öğrenci" />
          <Stat sayi={veri?.sinav_sayisi || 0} etiket="Sınav" />
          <Stat sayi={veri?.bu_hafta || 0} etiket="Bu Hafta" />
        </View>

        <View style={styles.sectionHead}>
          <Ionicons name="calendar-clear" size={18} color={colors.text} />
          <Text style={styles.sectionTitle}>Yaklaşan Sınavlar</Text>
        </View>

        {yaklasan.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="calendar-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>Henüz Sınav Yok</Text>
            <Text style={styles.emptyText}>Öğrencileriniz için henüz planlanmış bir sınav bulunmamaktadır.</Text>
          </View>
        ) : (
          yaklasan.map((s, i) => (
            <View key={i} style={styles.examCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.examAd}>{s.sinav_adi}</Text>
                <View style={styles.examMeta}>
                  <Meta ikon="calendar-outline" text={tarihFormat(s.tarih)} />
                  {s.sinif ? <Meta ikon="book-outline" text={`${s.sinif}. Sınıf`} /> : null}
                  {s.ders ? <Meta ikon="library-outline" text={s.ders} /> : null}
                  {s.ogrenci_ad_soyad ? <Meta ikon="person-outline" text={s.ogrenci_ad_soyad} /> : null}
                </View>
              </View>
              <View style={styles.geriSayim}>
                <Text style={styles.geriSayimText}>{geriSayim(s.tarih)}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ sayi, etiket }) {
  return (
    <LinearGradient colors={[colors.blue, colors.brightBlue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.statCard}>
      <Text style={styles.statSayi}>{sayi}</Text>
      <Text style={styles.statEtiket}>{etiket}</Text>
    </LinearGradient>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  header: { paddingHorizontal: 18, paddingBottom: 18, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { color: colors.white, fontSize: fs.xl, fontWeight: '800' },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: fs.sm, marginTop: 4 },

  hataBox: { backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, marginBottom: 12 },
  hataText: { color: colors.danger, fontSize: fs.sm },

  statRow: { flexDirection: 'row', gap: 10, marginTop: 4, marginBottom: 24 },
  statCard: { flex: 1, borderRadius: radius.card, paddingVertical: 18, alignItems: 'center' },
  statSayi: { color: colors.white, fontSize: fs.xxl, fontWeight: '800' },
  statEtiket: { color: 'rgba(255,255,255,0.9)', fontSize: fs.xs, marginTop: 2, fontWeight: '600' },

  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { fontSize: fs.lg, fontWeight: '800', color: colors.text },

  empty: { alignItems: 'center', paddingVertical: 44, backgroundColor: colors.white, borderRadius: radius.card },
  emptyTitle: { fontSize: fs.md, fontWeight: '700', color: colors.textMuted, marginTop: 14 },
  emptyText: { color: '#94a3b8', fontSize: fs.sm, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },

  examCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderRadius: radius.card, padding: 16, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: colors.blue },
  examAd: { fontSize: fs.base, fontWeight: '700', color: colors.text },
  examMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: fs.xs, color: colors.textMuted },
  geriSayim: { backgroundColor: '#eff6ff', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  geriSayimText: { color: colors.blue, fontSize: fs.xs, fontWeight: '700' },
});
