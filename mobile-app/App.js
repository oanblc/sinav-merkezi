import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { colors } from './src/theme';
import {
  getToken, getVeli, clearSession, saveSession,
  getOnboardingDone, setOnboardingDone, getTourDone, setTourDone,
} from './src/auth';
import { pushTokenSil } from './src/push';
import OnboardingScreen from './src/screens/OnboardingScreen';
import LoginScreen from './src/screens/LoginScreen';
import SifreDegistirScreen from './src/screens/SifreDegistirScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import TakvimScreen from './src/screens/TakvimScreen';
import SonuclarScreen from './src/screens/SonuclarScreen';
import ProfilScreen from './src/screens/ProfilScreen';
import BildirimlerScreen from './src/screens/BildirimlerScreen';
import TourOverlay from './src/components/TourOverlay';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function MainTabs({ onLogout }) {
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: { height: 58 + insets.bottom, paddingBottom: insets.bottom + 6, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color, size }) => {
          const map = { 'Ana Sayfa': 'home', Takvim: 'calendar', Sonuclar: 'document-text', Profil: 'person' };
          return <Ionicons name={map[route.name] || 'ellipse'} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Ana Sayfa" component={DashboardScreen} />
      <Tab.Screen name="Takvim" component={TakvimScreen} />
      <Tab.Screen name="Sonuclar" component={SonuclarScreen} options={{ title: 'Sonuçlar' }} />
      <Tab.Screen name="Profil">
        {() => <ProfilScreen onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export default function App() {
  const [hazir, setHazir] = useState(false);
  const [veli, setVeli] = useState(null);
  const [onboardingBitti, setOnboardingBitti] = useState(true);
  const [turBitti, setTurBitti] = useState(true);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (token) setVeli(await getVeli());
      setOnboardingBitti(await getOnboardingDone());
      setTurBitti(await getTourDone());
      setHazir(true);
    })();
  }, []);

  async function onboardingTamamla() {
    await setOnboardingDone();
    setOnboardingBitti(true);
  }

  async function turTamamla() {
    await setTourDone();
    setTurBitti(true);
  }

  async function cikisYap() {
    await pushTokenSil();   // token'ı backend'den kaldır (oturum kapanmadan)
    await clearSession();
    setVeli(null);
  }

  if (!hazir) {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /></View>;
  }

  // İlk açılış → onboarding (giriş öncesi, bir kez)
  if (!onboardingBitti) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <OnboardingScreen onDone={onboardingTamamla} />
      </SafeAreaProvider>
    );
  }

  // Giriş yapılmamış
  if (!veli) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <LoginScreen onLogin={setVeli} />
      </SafeAreaProvider>
    );
  }

  // İlk giriş → şifre değiştirme zorunlu
  if (veli.sifre_degistirilmeli) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SifreDegistirScreen
          veli={veli}
          onDone={async () => {
            const guncel = { ...veli, sifre_degistirilmeli: false };
            const token = await getToken();
            if (token) await saveSession(token, guncel);
            setVeli(guncel);
          }}
        />
      </SafeAreaProvider>
    );
  }

  // Ana uygulama (sekmeler + sekme dışı sayfalar)
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs">
            {() => <MainTabs onLogout={cikisYap} />}
          </Stack.Screen>
          <Stack.Screen name="Bildirimler" component={BildirimlerScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* İlk girişte uygulama içi mini tur */}
      {!turBitti ? <TourOverlay onDone={turTamamla} /> : null}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
