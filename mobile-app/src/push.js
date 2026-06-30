import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { apiPost } from './api';

// app.json → extra.eas.projectId (eas init ile yazıldı)
function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

// Cihazın Expo push token'ını al ve backend'e kaydet.
// Dönüş: true (kaydedildi) | false (alınamadı).
export async function pushTokenKaydet() {
  try {
    // İzin yoksa token alınamaz
    const izin = await Notifications.getPermissionsAsync();
    if (izin.status !== 'granted') return false;

    const projectId = getProjectId();
    if (!projectId) {
      console.warn('Push: projectId bulunamadı (app.json extra.eas.projectId).');
      return false;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return false;

    const { data } = await apiPost('/api/veli/push-token', { token }, true);
    return !!(data && data.success);
  } catch (e) {
    console.warn('Push token kaydı başarısız:', e?.message || e);
    return false;
  }
}

// Token'ı backend'den kaldır (çıkışta).
export async function pushTokenSil() {
  try {
    await apiPost('/api/veli/push-token-sil', {}, true);
  } catch (e) {
    // sessiz geç
  }
}
