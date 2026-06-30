import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs, radius } from '../theme';

const { width } = Dimensions.get('window');

const SLAYTLAR = [
  {
    ikon: 'school',
    baslik: 'Adana Sınav Kulübü',
    metin: 'Öğrencilerinizin sınav takvimi, sonuçları ve duyuruları tek bir uygulamada. Hoş geldiniz!',
  },
  {
    ikon: 'calendar',
    baslik: 'Takvim & Sonuçlar',
    metin: 'Yaklaşan sınavları takip edin, açıklanan sonuç karnelerini PDF olarak görüntüleyip indirin.',
  },
  {
    ikon: 'notifications',
    baslik: 'Anında Haberdar Olun',
    metin: 'Sınav sonucu açıklandığında ve önemli duyurularda bildirim alın. Hiçbir gelişmeyi kaçırmayın.',
  },
];

export default function OnboardingScreen({ onDone }) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef(null);
  const [index, setIndex] = useState(0);

  const sonSlayt = index === SLAYTLAR.length - 1;

  function kaydir(yeni) {
    scrollRef.current?.scrollTo({ x: yeni * width, animated: true });
    setIndex(yeni);
  }

  function ileri() {
    if (sonSlayt) onDone();
    else kaydir(index + 1);
  }

  return (
    <LinearGradient colors={[colors.primary, colors.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }}>
      {/* Atla */}
      <View style={[styles.ust, { paddingTop: insets.top + 10 }]}>
        {!sonSlayt ? (
          <TouchableOpacity onPress={onDone} hitSlop={10}>
            <Text style={styles.atla}>Atla</Text>
          </TouchableOpacity>
        ) : <View />}
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {SLAYTLAR.map((s, i) => (
          <View key={i} style={[styles.slayt, { width }]}>
            <View style={styles.ikonCember}>
              <Ionicons name={s.ikon} size={64} color={colors.white} />
            </View>
            <Text style={styles.baslik}>{s.baslik}</Text>
            <Text style={styles.metin}>{s.metin}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Noktalar */}
      <View style={styles.noktalar}>
        {SLAYTLAR.map((_, i) => (
          <View key={i} style={[styles.nokta, i === index && styles.noktaAktif]} />
        ))}
      </View>

      {/* Buton */}
      <View style={[styles.alt, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity style={styles.buton} onPress={ileri} activeOpacity={0.9}>
          <Text style={styles.butonText}>{sonSlayt ? 'Başla' : 'Devam'}</Text>
          <Ionicons name={sonSlayt ? 'checkmark' : 'arrow-forward'} size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  ust: { paddingHorizontal: 22, alignItems: 'flex-end', minHeight: 44 },
  atla: { color: 'rgba(255,255,255,0.85)', fontSize: fs.base, fontWeight: '600' },

  slayt: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, flex: 1 },
  ikonCember: { width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 40 },
  baslik: { color: colors.white, fontSize: fs.xxl, fontWeight: '800', textAlign: 'center', marginBottom: 16 },
  metin: { color: 'rgba(255,255,255,0.85)', fontSize: fs.md, lineHeight: 26, textAlign: 'center' },

  noktalar: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12 },
  nokta: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.35)' },
  noktaAktif: { width: 22, backgroundColor: colors.white },

  alt: { paddingHorizontal: 24, paddingTop: 8 },
  buton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.white, borderRadius: radius.button, height: 54 },
  butonText: { color: colors.primary, fontSize: fs.md, fontWeight: '800' },
});
