import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fs } from '../theme';
import AppHeader from '../components/AppHeader';

// Henüz kodlanmamış sekmeler için geçici ekran.
export default function PlaceholderScreen({ baslik, headerIkon, ikon = 'construct-outline', not, onLogout }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader ikon={headerIkon} baslik={baslik} />
      <View style={styles.wrap}>
        <Ionicons name={ikon} size={56} color="#cbd5e1" />
        <Text style={styles.not}>{not || 'Bu ekran sonraki adımda eklenecek.'}</Text>
        {onLogout ? (
          <TouchableOpacity style={styles.cikis} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={18} color={colors.white} />
            <Text style={styles.cikisText}>Çıkış Yap</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  not: { fontSize: fs.sm, color: colors.textMuted, marginTop: 16, textAlign: 'center' },
  cikis: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 28, backgroundColor: colors.danger, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  cikisText: { color: colors.white, fontWeight: '700', fontSize: fs.base },
});
