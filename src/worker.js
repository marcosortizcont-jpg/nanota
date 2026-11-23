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
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, isMaster: !!u.is_master,
  planId: u.plan_id || 'gratuito', mustChangePassword: !!u.must_change_password });
const isStaff = u => u.role === 'admin' || !!u.is_master;
function planOut(p) {
  let features = []; try { features = JSON.parse(p.features); } catch {}
  return { id: p.id, name: p.name, description: p.description, priceCents: p.price_cents, currency: p.currency, interval: p.billing_interval,
    maxSongs: p.max_songs, maxSetlists: p.max_setlists, features, active: !!p.active, isDefault: !!p.is_default, sort: p.sort };
}
async function planOf(env, u) {
  return await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(u.plan_id || 'gratuito').first();
}

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
function songOut(r, me) {
  let tags = []; try { tags = JSON.parse(r.tags); } catch {}
  return { id: r.id, type: 'song', title: r.title, artist: r.artist, key: r.song_key, bpm: r.bpm, tags, notes: r.notes, link: r.link, content: r.content, transpose: r.transpose, catalog: !!r.is_public, mine: !!me && r.user_id === me.id, updated: r.updated_at * 1000 };
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

  if (path === '/api/me' && m === 'GET') {
    const p = await planOf(env, me);
    return json({ user: publicUser(me), plan: p ? planOut(p) : null });
  }

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
  const staff = isStaff(me);

  if (path === '/api/data' && m === 'GET') {
    const [songs, sets] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM songs WHERE (user_id = ? OR is_public = 1) AND deleted = 0').bind(me.id),
      env.DB.prepare('SELECT * FROM setlists WHERE user_id = ? AND deleted = 0').bind(me.id),
    ]);
    return json({ songs: songs.results.map(r => songOut(r, me)), sets: sets.results.map(setOut) });
  }

  let mm = path.match(/^\/api\/songs\/([^/]+)$/);
  if (mm) {
    const id = mm[1];
    if (!validId(id)) return err(400, 'Identificador inválido.');
    const ex = await env.DB.prepare('SELECT user_id, is_public FROM songs WHERE id = ?').bind(id).first();
    const mayEdit = ex && (ex.user_id === me.id || (ex.is_public && staff));
    if (ex && !mayEdit) return err(ex.is_public ? 403 : 404, ex.is_public ? 'Só o administrador pode alterar uma cifra padrão. Personalize-a dentro do seu repertório.' : 'Não encontrada.');
    if (m === 'DELETE') {
      if (ex) await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (m === 'PUT') {
      const s = await body(req);
      if (String(s.content || '').length > 200000) return err(413, 'Cifra muito grande.');
      if (!ex && !staff) {
        const lim = await planOf(env, me);
        if (lim && lim.max_songs != null) {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM songs WHERE user_id = ? AND is_public = 0').bind(me.id).first();
          if (c.n >= lim.max_songs) return err(402, `Seu plano (${lim.name}) permite até ${lim.max_songs} músicas próprias.`);
        }
      }
      const pub = staff ? (s.catalog ? 1 : 0) : (ex ? ex.is_public : 0);
      const tags = JSON.stringify((Array.isArray(s.tags) ? s.tags : []).map(t => str(t, 40)).slice(0, 30));
      const vals = [str(s.title, 200), str(s.artist, 200), str(s.key, 12), str(s.bpm, 10), tags, str(s.notes, 1000),
        str(s.link, 500), String(s.content || ''), Math.max(-11, Math.min(11, parseInt(s.transpose) || 0)), pub, now()];
      if (ex) {
        await env.DB.prepare(`UPDATE songs SET title = ?, artist = ?, song_key = ?, bpm = ?, tags = ?, notes = ?, link = ?, content = ?,
          transpose = ?, is_public = ?, updated_at = ?, deleted = 0 WHERE id = ?`).bind(...vals, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO songs (title, artist, song_key, bpm, tags, notes, link, content, transpose, is_public, updated_at, id, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...vals, id, me.id).run();
      }
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
      if (!owner && !staff) {
        const lim = await planOf(env, me);
        if (lim && lim.max_setlists != null) {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM setlists WHERE user_id = ?').bind(me.id).first();
          if (c.n >= lim.max_setlists) return err(402, `Seu plano (${lim.name}) permite até ${lim.max_setlists} repertórios.`);
        }
      }
      const items = (Array.isArray(s.items) ? s.items : []).slice(0, 300)
        .filter(it => it && validId(String(it.songId)))
        .map(it => {
          const o = { songId: String(it.songId), transpose: Math.max(-11, Math.min(11, parseInt(it.transpose) || 0)) };
          if (typeof it.content === 'string') o.content = it.content.slice(0, 100000);
          if (typeof it.notes === 'string') o.notes = it.notes.slice(0, 1000);
          return o;
        });
      const itemsJson = JSON.stringify(items);
      if (itemsJson.length > 1500000) return err(413, 'Repertório muito grande.');
      await env.DB.prepare(
        `INSERT INTO setlists (id, user_id, name, set_date, items, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, set_date = excluded.set_date, items = excluded.items,
           updated_at = excluded.updated_at, deleted = 0
         WHERE setlists.user_id = excluded.user_id`
      ).bind(id, me.id, str(s.name, 200), str(s.date, 10), itemsJson, now()).run();
      return json({ ok: true });
    }
  }

  if (path === '/api/plans' && m === 'GET') {
    const r = await env.DB.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort, price_cents').all();
    return json({ plans: r.results.map(planOut) });
  }

  /* ----- administração (admin e master) ----- */
  if (path.startsWith('/api/admin/')) {
    if (!staff) return err(403, 'Apenas administradores.');
    const master = !!me.is_master;
    const needMaster = () => err(403, 'Apenas o usuário master pode fazer isso.');

    if (path === '/api/admin/users' && m === 'GET') {
      const r = await env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.is_master, u.plan_id, u.plan_expires_at, u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM songs s WHERE s.user_id = u.id AND s.is_public = 0) AS songs,
           (SELECT COUNT(*) FROM setlists t WHERE t.user_id = u.id) AS sets
         FROM users u ORDER BY u.is_master DESC, u.role = 'admin' DESC, u.name COLLATE NOCASE`
      ).all();
      return json({ users: r.results });
    }

    if (path === '/api/admin/users' && m === 'POST') {
      const { email, name, role, plan_id } = await body(req);
      const e = cleanEmail(email);
      if (!validEmail(e)) return err(400, 'E-mail inválido.');
      if (role === 'admin' && !master) return needMaster();
      const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(e).first();
      if (exists) return err(409, 'Já existe um usuário com esse e-mail.');
      let plan = null;
      if (plan_id && master) plan = await env.DB.prepare('SELECT id FROM plans WHERE id = ?').bind(String(plan_id)).first();
      if (!plan) plan = await env.DB.prepare('SELECT id FROM plans WHERE is_default = 1 ORDER BY sort LIMIT 1').first();
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO users (id, email, name, role, status, plan_id) VALUES (?, ?, ?, ?, 'invited', ?)`)
        .bind(id, e, str(name, 80).trim(), role === 'admin' ? 'admin' : 'member', plan ? plan.id : 'gratuito').run();
      const tok = await createLinkToken(env, id, 'invite');
      return json({ id, link: `${url.origin}/?convite=${tok}`, expiresDays: INVITE_DAYS });
    }

    mm = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/(link|disable|enable))?$/);
    if (mm) {
      const [, id, action] = mm;
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      if (!u) return err(404, 'Usuário não encontrado.');
      const targetStaff = u.role === 'admin' || u.is_master;
      if (u.is_master && (action === 'disable' || m === 'DELETE' || m === 'PATCH' && id !== me.id)) return err(400, 'O usuário master não pode ser bloqueado, excluído ou alterado por outra conta.');
      if (id === me.id && (action === 'disable' || m === 'DELETE')) return err(400, 'Você não pode bloquear ou excluir a própria conta.');
      if (targetStaff && !master && id !== me.id) return needMaster();

      if (!action && m === 'PATCH') {
        if (!master) return needMaster();
        const b = await body(req);
        const sets = [], vals = [];
        if (b.role !== undefined && !u.is_master) { sets.push('role = ?'); vals.push(b.role === 'admin' ? 'admin' : 'member'); }
        if (b.plan_id !== undefined) {
          const p = await env.DB.prepare('SELECT id FROM plans WHERE id = ?').bind(String(b.plan_id)).first();
          if (!p) return err(400, 'Plano não encontrado.');
          sets.push('plan_id = ?'); vals.push(p.id);
        }
        if (b.plan_expires_at !== undefined) { sets.push('plan_expires_at = ?'); vals.push(b.plan_expires_at ? parseInt(b.plan_expires_at) : null); }
        if (b.name !== undefined) { sets.push('name = ?'); vals.push(str(b.name, 80).trim()); }
        if (!sets.length) return err(400, 'Nada para alterar.');
        await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
        return json({ ok: true });
      }
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
          env.DB.prepare('DELETE FROM songs WHERE user_id = ? AND is_public = 0').bind(id),
          env.DB.prepare('UPDATE songs SET user_id = ? WHERE user_id = ? AND is_public = 1').bind(me.id, id),
          env.DB.prepare('DELETE FROM setlists WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
    }

    /* ----- planos ----- */
    if (path === '/api/admin/plans' && m === 'GET') {
      const r = await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.plan_id = p.id) AS users FROM plans p ORDER BY sort, price_cents`).all();
      return json({ plans: r.results.map(p => ({ ...planOut(p), users: p.users })) });
    }
    mm = path.match(/^\/api\/admin\/plans\/([a-z0-9-]{2,40})$/);
    if (mm) {
      if (!master) return needMaster();
      const id = mm[1];
      const ex = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first();
      if (m === 'DELETE') {
        if (!ex) return json({ ok: true });
        if (ex.is_default) return err(400, 'O plano padrão não pode ser excluído.');
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE plan_id = ?').bind(id).first();
        if (c.n) return err(400, `Há ${c.n} usuário(s) neste plano. Mude-os de plano antes de excluir.`);
        await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
      if (m === 'PUT') {
        const b = await body(req);
        const name = str(b.name, 60).trim();
        if (!name) return err(400, 'Dê um nome ao plano.');
        const lim = v => (v === null || v === '' || v === undefined) ? null : Math.max(0, parseInt(v) || 0);
        const interval = ['none', 'month', 'year'].includes(b.billing_interval) ? b.billing_interval : 'none';
        const isDefault = b.is_default ? 1 : 0;
        const feats = JSON.stringify((Array.isArray(b.features) ? b.features : []).map(f => str(f, 80)).filter(Boolean).slice(0, 20));
        const vals = [name, str(b.description, 300), Math.max(0, Math.round(Number(b.price_cents) || 0)), interval,
          lim(b.max_songs), lim(b.max_setlists), feats, b.active === false ? 0 : 1, isDefault, parseInt(b.sort) || 0];
        const stmts = [];
        if (isDefault) stmts.push(env.DB.prepare('UPDATE plans SET is_default = 0 WHERE id != ?').bind(id));
        if (ex) stmts.push(env.DB.prepare(`UPDATE plans SET name = ?, description = ?, price_cents = ?, billing_interval = ?, max_songs = ?,
            max_setlists = ?, features = ?, active = ?, is_default = ?, sort = ? WHERE id = ?`).bind(...vals, id));
        else stmts.push(env.DB.prepare(`INSERT INTO plans (name, description, price_cents, billing_interval, max_songs, max_setlists, features, active, is_default, sort, id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...vals, id));
        await env.DB.batch(stmts);
        const still = await env.DB.prepare('SELECT COUNT(*) AS n FROM plans WHERE is_default = 1').first();
        if (!still.n) await env.DB.prepare(`UPDATE plans SET is_default = 1 WHERE id = 'gratuito'`).run();
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
