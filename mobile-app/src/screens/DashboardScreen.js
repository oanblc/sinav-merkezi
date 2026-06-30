import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiGet, apiPost } from '../api';
import AppHeader from '../components/AppHeader';
import OgrenciFormModal from '../components/OgrenciFormModal';

export default function DashboardScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [yenileniyor, setYenileniyor] = useState(false);
  const [hata, setHata] = useState('');
  const [formGorunur, setFormGorunur] = useState(false);
  const [duzenlenen, setDuzenlenen] = useState(null);

  const yukle = useCallback(async () => {
    setHata('');
    try {
      const { data } = await apiGet('/api/veli/panel');
      if (data.success) setVeri(data);
      else setHata(data.message || 'Veriler alınamadı.');
    } catch (e) {
      setHata('Sunucuya ulaşılamadı.');
    } finally {
      setYukleniyor(false);
      setYenileniyor(false);
    }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  function silOnay(o) {
    Alert.alert('Öğrenci Sil', `"${o.ad_soyad}" kaydını silmek istiyor musunuz?`, [
      { text: 'İptal', style: 'cancel' },
      {
        text: 'Sil', style: 'destructive', onPress: async () => {
          const { data } = await apiPost(`/api/veli/ogrenci-sil/${o.id}`, {}, true);
          if (data.success) yukle();
          else Alert.alert('Hata', data.message || 'Silinemedi.');
        },
      },
    ]);
  }

  if (yukleniyor) {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /></View>;
  }

  const ogrenciler = veri?.ogrenciler || [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader
        ikon="school"
        baslik="Adana Sınav Kulübü"
        altyazi={`Veli Paneli · ${veri?.ogrenci_sayisi || 0} Öğrenci`}
        sag={
          <TouchableOpacity hitSlop={10} onPress={() => navigation.navigate('Bildirimler')}>
            <Ionicons name="notifications-outline" size={24} color={colors.white} />
          </TouchableOpacity>
        }
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingTop: 20, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={yenileniyor} onRefresh={() => { setYenileniyor(true); yukle(); }} />}
      >
        {hata ? (
          <View style={styles.hataBox}><Text style={styles.hataText}>{hata}</Text></View>
        ) : null}

        {/* İki aksiyon kartı */}
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.actionCard, { backgroundColor: colors.brightBlue }]} activeOpacity={0.85}
            onPress={() => navigation.navigate('Takvim')}>
            <Ionicons name="calendar" size={30} color={colors.white} />
            <Text style={styles.actionText}>Sınav Takvimi</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionCard, { backgroundColor: colors.success }]} activeOpacity={0.85}
            onPress={() => navigation.navigate('Sonuclar')}>
            <Ionicons name="document-text" size={30} color={colors.white} />
            <Text style={styles.actionText}>Sınav Sonuçları</Text>
          </TouchableOpacity>
        </View>

        {/* Öğrencilerim */}
        <View style={styles.sectionHead}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="people" size={20} color={colors.text} />
            <Text style={styles.sectionTitle}>Öğrencilerim</Text>
          </View>
          <TouchableOpacity style={styles.ekleBtn} onPress={() => { setDuzenlenen(null); setFormGorunur(true); }} activeOpacity={0.85}>
            <Ionicons name="add" size={18} color={colors.white} />
            <Text style={styles.ekleBtnText}>Ekle</Text>
          </TouchableOpacity>
        </View>

        {ogrenciler.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>Henüz öğrenci kaydınız bulunmuyor.</Text>
          </View>
        ) : (
          ogrenciler.map((o) => (
            <View key={`${o.kaynak}-${o.id}`} style={styles.ogrenciCard}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(o.ad_soyad || '?').charAt(0).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.ogrenciAd}>{o.ad_soyad}</Text>
                <View style={styles.ogrenciMeta}>
                  {o.sinif ? (
                    <View style={styles.metaChip}>
                      <Ionicons name="book-outline" size={13} color={colors.blue} />
                      <Text style={styles.metaText}>{o.sinif}</Text>
                    </View>
                  ) : null}
                  {o.tc_maskeli ? (
                    <View style={styles.metaChip}>
                      <Ionicons name="card-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.metaText}>TC: {o.tc_maskeli}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              {o.duzenlenebilir ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <TouchableOpacity hitSlop={8} onPress={() => { setDuzenlenen(o); setFormGorunur(true); }}>
                    <Ionicons name="create-outline" size={22} color={colors.blue} />
                  </TouchableOpacity>
                  <TouchableOpacity hitSlop={8} onPress={() => silOnay(o)}>
                    <Ionicons name="trash-outline" size={22} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.kurumRozet}>
                  <Text style={styles.kurumRozetText}>Kurum</Text>
                </View>
              )}
            </View>
          ))
        )}
      </ScrollView>

      <OgrenciFormModal
        gorunur={formGorunur}
        ogrenci={duzenlenen}
        onKapat={() => setFormGorunur(false)}
        onKaydedildi={() => { setFormGorunur(false); yukle(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },

  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brand: { fontSize: fs.md, fontWeight: '800', color: colors.primary },
  bellWrap: { padding: 4 },

  hataBox: { backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, marginBottom: 12 },
  hataText: { color: colors.danger, fontSize: fs.sm },

  veliCard: { borderRadius: radius.card, padding: 22, marginBottom: 16 },
  veliRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  veliTitle: { color: colors.white, fontSize: fs.lg, fontWeight: '800' },
  veliSub: { color: 'rgba(255,255,255,0.85)', fontSize: fs.base, marginTop: 6 },

  actionRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  actionCard: { flex: 1, borderRadius: radius.card, paddingVertical: 26, alignItems: 'center', justifyContent: 'center', gap: 10 },
  actionText: { color: colors.white, fontSize: fs.base, fontWeight: '700' },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: fs.lg, fontWeight: '800', color: colors.text },
  ekleBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.blue, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  ekleBtnText: { color: colors.white, fontSize: fs.sm, fontWeight: '700' },
  kurumRozet: { backgroundColor: '#eef2f7', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  kurumRozetText: { color: colors.textMuted, fontSize: fs.xs, fontWeight: '600' },

  empty: { alignItems: 'center', paddingVertical: 40, backgroundColor: colors.white, borderRadius: radius.card },
  emptyText: { color: colors.textMuted, fontSize: fs.sm, marginTop: 12 },

  ogrenciCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderRadius: radius.card, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  avatar: { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontSize: fs.lg, fontWeight: '800' },
  ogrenciAd: { fontSize: fs.base, fontWeight: '700', color: colors.text },
  ogrenciMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#eff6ff', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  metaText: { fontSize: fs.xs, color: colors.textMuted, fontWeight: '600' },
});
