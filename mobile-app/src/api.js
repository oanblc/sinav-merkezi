import { API_BASE_URL } from './config';
import { getToken } from './auth';

// Oturum düştüğünde (401) çağrılacak global handler — App.js kaydeder.
let _onUnauthorized = null;
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn; }
function _kontrolOturum(status, withAuth) {
  if (withAuth && status === 401 && typeof _onUnauthorized === 'function') {
    _onUnauthorized();
  }
}

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
  _kontrolOturum(res.status, withAuth);
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
  _kontrolOturum(res.status, withAuth);
  return { ok: res.ok, status: res.status, data };
}
