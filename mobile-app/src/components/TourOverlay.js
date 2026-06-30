import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';

const { width } = Dimensions.get('window');

// Uygulamaya ilk girişte gösterilen mini tur.
// Alt sekmeleri ve üstteki bildirim zilini tanıtır.
export default function TourOverlay({ onDone }) {
  const insets = useSafeAreaInsets();
  const [adim, setAdim] = useState(0);

  const tabBarYukseklik = 58 + insets.bottom; // App.js ile aynı

  // 4 eşit sekme — her sekmenin yatay merkezi
  const tabMerkez = (i) => (width * (i + 0.5)) / 4;

  const ADIMLAR = [
    {
      tip: 'ust',
      x: width - 34,
      ikon: 'notifications-outline',
      baslik: 'Bildirimler',
      metin: 'Sınav sonucu açıklandığında ve duyurularda bildirimleri buradan görürsün.',
    },
    {
      tip: 'alt', x: tabMerkez(0), ikon: 'home',
      baslik: 'Ana Sayfa',
      metin: 'Öğrencilerin ve hızlı erişim kartları. Yeni öğrenci de buradan eklenir.',
    },
    {
      tip: 'alt', x: tabMerkez(1), ikon: 'calendar',
      baslik: 'Takvim',
      metin: 'Yaklaşan sınavları ve bu haftanın sınavlarını burada görürsün.',
    },
    {
      tip: 'alt', x: tabMerkez(2), ikon: 'document-text',
      baslik: 'Sonuçlar',
      metin: 'Açıklanan sınav sonuç karnelerini PDF olarak görüntüleyip indirirsin.',
    },
    {
      tip: 'alt', x: tabMerkez(3), ikon: 'person',
      baslik: 'Profil',
      metin: 'Bilgilerin, bildirim izni ve şifre değiştirme bu sekmede.',
    },
  ];

  const a = ADIMLAR[adim];
  const son = adim === ADIMLAR.length - 1;
  const caretSol = Math.max(16, Math.min(a.x - 9, width - 25));

  function ileri() {
    if (son) onDone();
    else setAdim(adim + 1);
  }

  // Kart konumu: üst adımda header altı, alt adımlarda tab barın üstü
  const kartUstStil = a.tip === 'ust'
    ? { top: insets.top + 70 }
    : { bottom: tabBarYukseklik + 18 };

  return (
    <Pressable style={styles.kapla} onPress={ileri}>
      {/* İşaret (caret) */}
      {a.tip === 'ust' ? (
        <View style={[styles.caretUp, { left: caretSol, top: insets.top + 58 }]} />
      ) : (
        <View style={[styles.caretDown, { left: caretSol, bottom: tabBarYukseklik + 10 }]} />
      )}

      {/* Bilgi kartı */}
      <View style={[styles.kart, kartUstStil]}>
        <View style={styles.kartHead}>
          <View style={styles.ikonKutu}>
            <Ionicons name={a.ikon} size={22} color={colors.blue} />
          </View>
          <Text style={styles.kartBaslik}>{a.baslik}</Text>
          <Text style={styles.sayac}>{adim + 1}/{ADIMLAR.length}</Text>
        </View>
        <Text style={styles.kartMetin}>{a.metin}</Text>

        <View style={styles.kartAlt}>
          <TouchableOpacity onPress={onDone} hitSlop={8}>
            <Text style={styles.gec}>Turu geç</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ileriBtn} onPress={ileri} activeOpacity={0.9}>
            <Text style={styles.ileriText}>{son ? 'Bitir' : 'İleri'}</Text>
            <Ionicons name={son ? 'checkmark' : 'arrow-forward'} size={16} color={colors.white} />
          </TouchableOpacity>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  kapla: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,23,42,0.72)', zIndex: 999 },

  caretDown: { position: 'absolute', width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: colors.white },
  caretUp: { position: 'absolute', width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: colors.white },

  kart: { position: 'absolute', left: 18, right: 18, backgroundColor: colors.white, borderRadius: radius.card, padding: 18, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  kartHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  ikonKutu: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#eff6ff', alignItems: 'center', justifyContent: 'center' },
  kartBaslik: { flex: 1, fontSize: fs.md, fontWeight: '800', color: colors.text },
  sayac: { fontSize: fs.xs, color: colors.textMuted, fontWeight: '700' },
  kartMetin: { fontSize: fs.sm, color: colors.textMuted, lineHeight: 21 },

  kartAlt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  gec: { color: colors.textMuted, fontSize: fs.sm, fontWeight: '600' },
  ileriBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.blue, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 9 },
  ileriText: { color: colors.white, fontSize: fs.sm, fontWeight: '700' },
});
