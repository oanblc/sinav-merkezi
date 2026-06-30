import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs } from '../theme';

// Tüm sayfalarda ortak gradient başlık (düz alt — radius yok).
export default function AppHeader({ ikon, baslik, altyazi, sag, onGeri }) {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient
      colors={[colors.primary, colors.blue]}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={[styles.header, { paddingTop: insets.top + 14 }]}
    >
      <View style={styles.row}>
        <View style={styles.left}>
          {onGeri ? (
            <TouchableOpacity onPress={onGeri} hitSlop={10} style={{ marginRight: 2 }}>
              <Ionicons name="chevron-back" size={24} color={colors.white} />
            </TouchableOpacity>
          ) : null}
          {ikon ? <Ionicons name={ikon} size={22} color={colors.white} /> : null}
          <Text style={styles.baslik}>{baslik}</Text>
        </View>
        {sag ? <View>{sag}</View> : null}
      </View>
      {altyazi ? <Text style={styles.altyazi}>{altyazi}</Text> : null}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 18, paddingBottom: 18 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  baslik: { color: colors.white, fontSize: fs.xl, fontWeight: '800' },
  altyazi: { color: 'rgba(255,255,255,0.85)', fontSize: fs.sm, marginTop: 4 },
});
