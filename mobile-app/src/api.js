import { API_BASE_URL } from './config';
import { getToken } from './auth';

// JSON POST yardımcısı (gerekirse JWT ekler)
export async function apiPost(path, body, withAuth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const token = await getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(API_BASE_URL + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function apiGet(path, withAuth = true) {
  const headers = {};
  if (withAuth) {
    const token = await getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(API_BASE_URL + path, { headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
