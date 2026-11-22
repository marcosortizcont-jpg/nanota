// NaNota — servidor (Cloudflare Worker + D1)
// Login com sessão em cookie, convites, troca de senha, administração de usuários
// e armazenamento das músicas e repertórios de cada usuário.

const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const PBKDF2_ITER = 100000; // limite do Web Crypto nos Workers
const MIN_PASSWORD = 6;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'nn_s';

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(str) { const d = await crypto.subtle.digest('SHA-256', enc.encode(str)); return b64(new Uint8Array(d)); }
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function hashPassword(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter }, key, 256);
  return b64(new Uint8Array(bits));
}
async function newPasswordFields(password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { hash: await hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
const err = (status, message) => json({ error: message }, status);
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
async function body(req) { try { return await req.json(); } catch { return {}; } }
const cleanEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mustChangePassword: !!u.must_change_password });

async function currentUser(req, env) {
  const tok = readCookie(req, COOKIE);
  if (!tok) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`
  ).bind(await sha256(tok), now()).first();
  return row || null;
}
async function startSession(env, req, userId) {
  const tok = randomToken();
  const exp = now() + SESSION_DAYS * 86400;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .bind(await sha256(tok), userId, exp, (req.headers.get('user-agent') || '').slice(0, 200)).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now()).run();
  return sessionCookie(tok, SESSION_DAYS * 86400);
}
async function createLinkToken(env, userId, purpose) {
  const tok = randomToken();
  await env.DB.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').bind(userId).run();
  await env.DB.prepare('INSERT INTO invites (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(tok), userId, purpose, now() + INVITE_DAYS * 86400).run();
  return tok;
}

/* ---------- conversão entre o banco e o formato do app ---------- */
function songOut(r) {
  let tags = []; try { tags = JSON.parse(r.tags); } catch {}
  return { id: r.id, type: 'song', title: r.title, artist: r.artist, key: r.song_key, bpm: r.bpm, tags, notes: r.notes, link: r.link, content: r.content, transpose: r.transpose, updated: r.updated_at * 1000 };
}
function setOut(r) {
  let items = []; try { items = JSON.parse(r.items); } catch {}
  return { id: r.id, type: 'set', name: r.name, date: r.set_date, items, updated: r.updated_at * 1000 };
}
const str = (v, max) => String(v ?? '').slice(0, max);
const validId = id => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/* ---------- rotas ---------- */
async function api(req, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // Proteção contra envio de formulários de outros sites
  if (m !== 'GET' && req.headers.get('x-nanota') !== '1') return err(403, 'Requisição recusada.');

  if (path === '/api/login' && m === 'POST') {
    const { email, password } = await body(req);
    const e = cleanEmail(email);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(e).first();
    const fail = () => err(401, 'E-mail ou senha incorretos.');
    if (!u || u.status === 'disabled' || !u.password_hash) { await hashPassword(String(password || ''), 'AAAAAAAAAAAAAAAAAAAAAA==', PBKDF2_ITER); return fail(); }
    if (u.locked_until && u.locked_until > now()) return err(429, `Muitas tentativas. Tente de novo em ${Math.ceil((u.locked_until - now()) / 60)} min.`);
    const h = await hashPassword(String(password || ''), u.password_salt, u.password_iter || PBKDF2_ITER);
    if (!safeEqual(h, u.password_hash)) {
      const fails = (u.failed_logins || 0) + 1;
      const lock = fails >= MAX_FAILS ? now() + LOCK_MINUTES * 60 : null;
      await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : fails, lock, u.id).run();
      return fail();
    }
    await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').bind(now(), u.id).run();
    const cookie = await startSession(env, req, u.id);
    return json({ user: publicUser(u) }, 200, { 'set-cookie': cookie });
  }

  if (path === '/api/invite' && m === 'GET') {
    const tok = url.searchParams.get('token') || '';
    const inv = await env.DB.prepare(
      `SELECT i.purpose, u.email, u.name FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND u.status != 'disabled'`
    ).bind(await sha256(tok), now()).first();
    if (!inv) return err(404, 'Link inválido ou expirado. Peça um novo ao administrador.');
    return json(inv);
  }

  if (path === '/api/invite' && m === 'POST') {
    const { token, password, name } = await body(req);
    if (String(password || '').length < MIN_PASSWORD) return err(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    const th = await sha256(String(token || ''));
    const inv = await env.DB.prepare(
      `SELECT i.*, u.status FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND u.status != 'disabled'`
    ).bind(th, now()).first();
    if (!inv) return err(404, 'Link inválido ou expirado. Peça um novo ao administrador.');
    const p = await newPasswordFields(String(password));
    const nm = str(name, 80).trim();
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ?, status = 'active',
        must_change_password = 0, failed_logins = 0, locked_until = NULL ${nm ? ', name = ?' : ''} WHERE id = ?`)
        .bind(...[p.hash, p.salt, p.iter, ...(nm ? [nm] : []), inv.user_id]),
      env.DB.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').bind(now(), th),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(inv.user_id),
    ]);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(inv.user_id).first();
    const cookie = await startSession(env, req, u.id);
    return json({ user: publicUser(u) }, 200, { 'set-cookie': cookie });
  }

  // ----- daqui para baixo, precisa estar logado -----
  const me = await currentUser(req, env);
  if (!me) return err(401, 'Faça login.');

  if (path === '/api/me' && m === 'GET') return json({ user: publicUser(me) });

  if (path === '/api/logout' && m === 'POST') {
    const tok = readCookie(req, COOKIE);
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(tok)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/api/password' && m === 'POST') {
    const { current, password } = await body(req);
    if (String(password || '').length < MIN_PASSWORD) return err(400, `A nova senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    const h = await hashPassword(String(current || ''), me.password_salt, me.password_iter || PBKDF2_ITER);
    if (!safeEqual(h, me.password_hash)) return err(400, 'A senha atual está incorreta.');
    if (current === password) return err(400, 'A nova senha precisa ser diferente da atual.');
    const p = await newPasswordFields(String(password));
    const tok = readCookie(req, COOKIE);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ?, must_change_password = 0 WHERE id = ?').bind(p.hash, p.salt, p.iter, me.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(me.id, await sha256(tok)),
    ]);
    return json({ ok: true });
  }

  // Enquanto a senha temporária não for trocada, só o básico funciona
  if (me.must_change_password) return err(403, 'Troque sua senha temporária para continuar.');

  /* ----- dados do usuário ----- */
  if (path === '/api/data' && m === 'GET') {
    const [songs, sets] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM songs WHERE user_id = ? AND deleted = 0').bind(me.id),
      env.DB.prepare('SELECT * FROM setlists WHERE user_id = ? AND deleted = 0').bind(me.id),
    ]);
    return json({ songs: songs.results.map(songOut), sets: sets.results.map(setOut) });
  }

  let mm = path.match(/^\/api\/songs\/([^/]+)$/);
  if (mm) {
    const id = mm[1];
    if (!validId(id)) return err(400, 'Identificador inválido.');
    const owner = await env.DB.prepare('SELECT user_id FROM songs WHERE id = ?').bind(id).first();
    if (owner && owner.user_id !== me.id) return err(404, 'Não encontrada.');
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM songs WHERE id = ? AND user_id = ?').bind(id, me.id).run(); return json({ ok: true }); }
    if (m === 'PUT') {
      const s = await body(req);
      if (String(s.content || '').length > 200000) return err(413, 'Cifra muito grande.');
      const tags = JSON.stringify((Array.isArray(s.tags) ? s.tags : []).map(t => str(t, 40)).slice(0, 30));
      await env.DB.prepare(
        `INSERT INTO songs (id, user_id, title, artist, song_key, bpm, tags, notes, link, content, transpose, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, artist = excluded.artist, song_key = excluded.song_key,
           bpm = excluded.bpm, tags = excluded.tags, notes = excluded.notes, link = excluded.link, content = excluded.content,
           transpose = excluded.transpose, updated_at = excluded.updated_at, deleted = 0
         WHERE songs.user_id = excluded.user_id`
      ).bind(id, me.id, str(s.title, 200), str(s.artist, 200), str(s.key, 12), str(s.bpm, 10), tags, str(s.notes, 1000),
        str(s.link, 500), String(s.content || ''), Math.max(-11, Math.min(11, parseInt(s.transpose) || 0)), now()).run();
      return json({ ok: true });
    }
  }

  mm = path.match(/^\/api\/sets\/([^/]+)$/);
  if (mm) {
    const id = mm[1];
    if (!validId(id)) return err(400, 'Identificador inválido.');
    const owner = await env.DB.prepare('SELECT user_id FROM setlists WHERE id = ?').bind(id).first();
    if (owner && owner.user_id !== me.id) return err(404, 'Não encontrado.');
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM setlists WHERE id = ? AND user_id = ?').bind(id, me.id).run(); return json({ ok: true }); }
    if (m === 'PUT') {
      const s = await body(req);
      const items = (Array.isArray(s.items) ? s.items : []).slice(0, 300)
        .filter(it => it && validId(String(it.songId)))
        .map(it => ({ songId: String(it.songId), transpose: Math.max(-11, Math.min(11, parseInt(it.transpose) || 0)) }));
      await env.DB.prepare(
        `INSERT INTO setlists (id, user_id, name, set_date, items, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, set_date = excluded.set_date, items = excluded.items,
           updated_at = excluded.updated_at, deleted = 0
         WHERE setlists.user_id = excluded.user_id`
      ).bind(id, me.id, str(s.name, 200), str(s.date, 10), JSON.stringify(items), now()).run();
      return json({ ok: true });
    }
  }

  /* ----- administração de usuários ----- */
  if (path.startsWith('/api/admin/')) {
    if (me.role !== 'admin') return err(403, 'Apenas administradores.');

    if (path === '/api/admin/users' && m === 'GET') {
      const r = await env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM songs s WHERE s.user_id = u.id) AS songs
         FROM users u ORDER BY u.role = 'admin' DESC, u.name COLLATE NOCASE`
      ).all();
      return json({ users: r.results });
    }

    if (path === '/api/admin/users' && m === 'POST') {
      const { email, name, role } = await body(req);
      const e = cleanEmail(email);
      if (!validEmail(e)) return err(400, 'E-mail inválido.');
      const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(e).first();
      if (exists) return err(409, 'Já existe um usuário com esse e-mail.');
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'invited')`)
        .bind(id, e, str(name, 80).trim(), role === 'admin' ? 'admin' : 'member').run();
      const tok = await createLinkToken(env, id, 'invite');
      return json({ id, link: `${url.origin}/?convite=${tok}`, expiresDays: INVITE_DAYS });
    }

    mm = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/(link|disable|enable))?$/);
    if (mm) {
      const [, id, action] = mm;
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!u) return err(404, 'Usuário não encontrado.');
      if (id === me.id && (action === 'disable' || m === 'DELETE')) return err(400, 'Você não pode bloquear ou excluir a própria conta.');
      if (action === 'link' && m === 'POST') {
        const purpose = u.status === 'invited' ? 'invite' : 'reset';
        const tok = await createLinkToken(env, id, purpose);
        return json({ link: `${url.origin}/?convite=${tok}`, purpose, expiresDays: INVITE_DAYS });
      }
      if (action === 'disable' && m === 'POST') {
        await env.DB.batch([
          env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).bind(id),
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
      if (action === 'enable' && m === 'POST') {
        await env.DB.prepare(`UPDATE users SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END WHERE id = ?`).bind(id).run();
        return json({ ok: true });
      }
      if (!action && m === 'DELETE') {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM songs WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM setlists WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
    }
  }

  return err(404, 'Rota não encontrada.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { console.error(e); return err(500, 'Erro no servidor. Tente de novo.'); }
    }
    return env.ASSETS.fetch(req);
  },
};
