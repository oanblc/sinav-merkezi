import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';
import { apiGet } from '../api';
import AppHeader from '../components/AppHeader';

// bildirim_tipi → ikon + başlık + renk eşlemesi
const TIP_HARITA = {
  sinav_sonuc: { ikon: 'document-text', baslik: 'Sınav Sonucu', renk: colors.success },
  yeni_talep: { ikon: 'mail', baslik: 'Talep', renk: colors.blue },
  paket_talebi: { ikon: 'cube', baslik: 'Paket Talebi', renk: colors.blue },
  rehber_talep_kurum: { ikon: 'person-add', baslik: 'Rehberlik Talebi', renk: colors.blue },
  rehber_talep_onaylandi: { ikon: 'checkmark-circle', baslik: 'Talebiniz Onaylandı', renk: colors.success },
  talep_onaylandi: { ikon: 'checkmark-circle', baslik: 'Talebiniz Onaylandı', renk: colors.success },
  genel: { ikon: 'notifications', baslik: 'Bildirim', renk: colors.blue },
};

function tipBilgi(tip) {
  return TIP_HARITA[tip] || { ikon: 'notifications', baslik: 'Bildirim', renk: colors.blue };
}

// created_at ("YYYY-MM-DD HH:MM:SS", UTC) → "x dk önce" / tarih
function gecenSure(tarih) {
  if (!tarih) return '';
  const t = String(tarih).replace(' ', 'T') + (String(tarih).includes('Z') ? '' : 'Z');
  const ms = Date.parse(t);
  if (isNaN(ms)) return String(tarih);
  const fark = Date.now() - ms;
  const dk = Math.floor(fark / 60000);
  if (dk < 1) return 'şimdi';
  if (dk < 60) return `${dk} dk önce`;
  const sa = Math.floor(dk / 60);
  if (sa < 24) return `${sa} saat önce`;
  const gun = Math.floor(sa / 24);
  if (gun < 7) return `${gun} gün önce`;
  const d = new Date(ms);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export default function BildirimlerScreen({ navigation }) {
  const [bildirimler, setBildirimler] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [yenileniyor, setYenileniyor] = useState(false);
  const [hata, setHata] = useState('');

  const yukle = useCallback(async () => {
    setHata('');
    try {
      const { data } = await apiGet('/api/veli/bildirimler');
      if (data.success) setBildirimler(data.bildirimler || []);
      else setHata(data.message || 'Bildirimler alınamadı.');
    } catch (e) {
      setHata('Sunucuya ulaşılamadı.');
    } finally {
      setYukleniyor(false);
      setYenileniyor(false);
    }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader
        ikon="notifications"
        baslik="Bildirimler"
        altyazi="Size gönderilen bildirimler"
        onGeri={navigation ? () => navigation.goBack() : undefined}
      />

      {yukleniyor ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingTop: 20, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={yenileniyor} onRefresh={() => { setYenileniyor(true); yukle(); }} />}
        >
          {hata ? (
            <View style={styles.hataBox}><Text style={styles.hataText}>{hata}</Text></View>
          ) : null}

          {bildirimler.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="notifications-off-outline" size={48} color="#cbd5e1" />
              <Text style={styles.emptyBaslik}>Bildirim yok</Text>
              <Text style={styles.emptyText}>
                Sınav sonucu açıklandığında ve önemli duyurularda burada bildirim göreceksiniz.
              </Text>
            </View>
          ) : (
            bildirimler.map((b, i) => {
              const bilgi = tipBilgi(b.tip);
              return (
                <View key={i} style={styles.kart}>
                  <View style={[styles.ikonKutu, { backgroundColor: bilgi.renk + '1a' }]}>
                    <Ionicons name={bilgi.ikon} size={20} color={bilgi.renk} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.kartHead}>
                      <Text style={styles.kartBaslik}>{bilgi.baslik}</Text>
                      <Text style={styles.kartZaman}>{gecenSure(b.tarih)}</Text>
                    </View>
                    <Text style={styles.kartMesaj}>{(b.mesaj || '').trim()}</Text>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  hataBox: { backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, marginBottom: 12 },
  hataText: { color: colors.danger, fontSize: fs.sm },

  empty: { alignItems: 'center', paddingVertical: 48, backgroundColor: colors.white, borderRadius: radius.card, paddingHorizontal: 24 },
  emptyBaslik: { fontSize: fs.lg, fontWeight: '800', color: colors.text, marginTop: 14 },
  emptyText: { color: colors.textMuted, fontSize: fs.sm, marginTop: 8, textAlign: 'center', lineHeight: 20 },

  kart: { flexDirection: 'row', gap: 12, backgroundColor: colors.white, borderRadius: radius.card, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  ikonKutu: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  kartHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  kartBaslik: { fontSize: fs.base, fontWeight: '800', color: colors.text },
  kartZaman: { fontSize: fs.xs, color: colors.textMuted },
  kartMesaj: { fontSize: fs.sm, color: colors.textMuted, lineHeight: 20 },
});
