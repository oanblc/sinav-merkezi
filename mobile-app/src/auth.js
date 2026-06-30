import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'veli_jwt';
const VELI_KEY = 'veli_bilgi';

export async function saveSession(token, veli) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(VELI_KEY, JSON.stringify(veli || {}));
}

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getVeli() {
  const raw = await SecureStore.getItemAsync(VELI_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function clearSession() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(VELI_KEY);
}

// ---- Tek seferlik tanıtım bayrakları (onboarding + uygulama içi tur) ----
const ONBOARDING_KEY = 'onboarding_done';
const TOUR_KEY = 'tur_done';

export async function getOnboardingDone() {
  return (await SecureStore.getItemAsync(ONBOARDING_KEY)) === '1';
}
export async function setOnboardingDone() {
  await SecureStore.setItemAsync(ONBOARDING_KEY, '1');
}

export async function getTourDone() {
  return (await SecureStore.getItemAsync(TOUR_KEY)) === '1';
}
export async function setTourDone() {
  await SecureStore.setItemAsync(TOUR_KEY, '1');
}
