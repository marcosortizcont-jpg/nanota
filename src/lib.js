// NaNota — funções compartilhadas do servidor
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const PBKDF2_ITER = 100000; // limite do Web Crypto nos Workers
export const MIN_PASSWORD = 6;
export const MAX_FAILS = 5;
export const LOCK_MINUTES = 15;
export const COOKIE = 'nn_s';

export const enc = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);

export function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
export function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
export function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
export async function sha256(str) { const d = await crypto.subtle.digest('SHA-256', enc.encode(str)); return b64(new Uint8Array(d)); }
export function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

export async function hashPassword(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter }, key, 256);
  return b64(new Uint8Array(bits));
}
export async function newPasswordFields(password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { hash: await hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER };
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
export const err = (status, message) => json({ error: message }, status);
export function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
export async function body(req) { try { return await req.json(); } catch { return {}; } }
export const cleanEmail = e => String(e || '').trim().toLowerCase();
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
export const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, isMaster: !!u.is_master,
  planId: u.plan_id || 'gratuito', mustChangePassword: !!u.must_change_password });
export const isStaff = u => u.role === 'admin' || !!u.is_master;
export function planOut(p) {
  let features = []; try { features = JSON.parse(p.features); } catch {}
  return { id: p.id, name: p.name, description: p.description, priceCents: p.price_cents, currency: p.currency, interval: p.billing_interval,
    maxSongs: p.max_songs, maxSetlists: p.max_setlists, features, active: !!p.active, isDefault: !!p.is_default, sort: p.sort };
}
export async function planOf(env, u) {
  return await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(u.plan_id || 'gratuito').first();
}

export async function currentUser(req, env) {
  const tok = readCookie(req, COOKIE);
  if (!tok) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(await sha256(tok), now()).first();
  return row || null;
}
export async function startSession(env, req, userId) {
  const tok = randomToken();
  const exp = now() + SESSION_DAYS * 86400;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .bind(await sha256(tok), userId, exp, (req.headers.get('user-agent') || '').slice(0, 200)).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now()).run();
  return sessionCookie(tok, SESSION_DAYS * 86400);
}
export async function createLinkToken(env, userId, purpose) {
  const tok = randomToken();
  await env.DB.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').bind(userId).run();
  await env.DB.prepare('INSERT INTO invites (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(tok), userId, purpose, now() + INVITE_DAYS * 86400).run();
  return tok;
}

/* ---------- conversão entre o banco e o formato do app ---------- */
export function songOut(r, me) {
  let tags = []; try { tags = JSON.parse(r.tags); } catch {}
  return { id: r.id, type: 'song', title: r.title, artist: r.artist, key: r.song_key, bpm: r.bpm, tags, notes: r.notes, link: r.link, content: r.content, transpose: r.transpose, catalog: !!r.is_public, mine: !!me && r.user_id === me.id, updated: r.updated_at * 1000 };
}
export function setOut(r) {
  let items = []; try { items = JSON.parse(r.items); } catch {}
  return { id: r.id, type: 'set', name: r.name, date: r.set_date, items, updated: r.updated_at * 1000 };
}
export const str = (v, max) => String(v ?? '').slice(0, max);
export const validId = id => /^[A-Za-z0-9_-]{1,80}$/.test(id);

