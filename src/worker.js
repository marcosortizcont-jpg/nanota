// NaNota — servidor (Cloudflare Worker + D1)
// Login com sessão em cookie, convites, troca de senha, administração de usuários
// e armazenamento das músicas e repertórios de cada usuário.

import { SESSION_DAYS, INVITE_DAYS, PBKDF2_ITER, MIN_PASSWORD, MAX_FAILS, LOCK_MINUTES, COOKIE, enc, now, b64, unb64, b64url, randomToken, sha256, safeEqual, hashPassword, newPasswordFields, json, err, sessionCookie, readCookie, body, cleanEmail, validEmail, publicUser, isStaff, planOut, planOf, currentUser, startSession, createLinkToken, songOut, setOut, str, validId } from './lib.js';
import { groupRoutes, setsForUser } from './groups.js';
import { financeRoutes, myBilling } from './finance.js';
import { transcribeRoutes } from './transcribe.js';
import { fetchChartRoute } from './fetchchart.js';

/* ---------- rotas ---------- */
async function api(req, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  // Modelo de separação de faixas (HTDemucs, licença MIT): servido pelo próprio site,
  // para o navegador não esbarrar em bloqueios entre sites. A Cloudflare guarda em cache.
  if (path === '/api/stem-model' && (m === 'GET' || m === 'HEAD')) {
    const src = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
    const r = await fetch(src, { redirect: 'follow', cf: { cacheTtl: 60 * 60 * 24 * 30, cacheEverything: true } });
    if (!r.ok) return err(502, `Não consegui buscar o modelo (${r.status}).`);
    const h = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=2592000, immutable', 'cross-origin-resource-policy': 'same-origin' });
    const len = r.headers.get('content-length'); if (len) h.set('content-length', len);
    return new Response(m === 'HEAD' ? null : r.body, { status: 200, headers: h });
  }

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
    const songs = await env.DB.prepare('SELECT * FROM songs WHERE (user_id = ? OR is_public = 1) AND deleted = 0').bind(me.id).all();
    const visible = new Set(songs.results.map(r => r.id));
    const { sets, extra } = await setsForUser(env, me, visible);
    return json({
      songs: songs.results.map(r => songOut(r, me)).concat(extra.map(r => ({ ...songOut(r, me), shared: true }))),
      sets,
    });
  }

  if (path === '/api/my/billing' && m === 'GET') return myBilling(env, me);

  const tr = await transcribeRoutes(req, env, path, me);
  if (tr) return tr;
  const fc = await fetchChartRoute(req, env, path, me);
  if (fc) return fc;
  const g = await groupRoutes(req, env, url, path, m, me);
  if (g) return g;
  const f = await financeRoutes(req, env, url, path, m, me);
  if (f) return f;

  let mm = path.match(/^\/api\/songs\/([^/]+)$/);
  if (mm) {
    const id = mm[1];
    if (!validId(id)) return err(400, 'Identificador inválido.');
    const ex = await env.DB.prepare('SELECT user_id, is_public FROM songs WHERE id = ?').bind(id).first();
    const mayEdit = ex && (ex.user_id === me.id || (ex.is_public && staff));
    if (ex && !mayEdit) return err(ex.is_public ? 403 : 404, ex.is_public ? 'Só o administrador pode alterar uma cifra padrão. Personalize-a dentro do seu repertório.' : 'Não encontrada.');
    if (m === 'DELETE') {
      // excluir da biblioteca geral: só administrador/master. Tirar de um repertório é outra coisa (editar o repertório).
      if (!staff) return err(403, 'Só o administrador pode excluir músicas da biblioteca. Para tirar a música de um repertório, use o ✕ dentro do repertório.');
      if (ex) {
        await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id).run();
        // tira a música de todos os repertórios que a usavam
        const rs = await env.DB.prepare('SELECT id, items, version FROM setlists WHERE items LIKE ?').bind('%' + id + '%').all();
        for (const r of rs.results || []) {
          let items = []; try { items = JSON.parse(r.items || '[]'); } catch (e) { continue; }
          const next = items.filter(it => it && it.songId !== id);
          if (next.length !== items.length) await env.DB.prepare('UPDATE setlists SET items = ?, version = version + 1, updated_at = ? WHERE id = ?').bind(JSON.stringify(next), now(), r.id).run();
        }
      }
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
      const lk = {};
      if (s.links && typeof s.links === 'object') for (const k of ['youtube', 'spotify', 'deezer', 'outro']) {
        const u = String(s.links[k] || '').trim(); if (/^https?:\/\/\S+$/i.test(u) && u.length <= 500) lk[k] = u;
      }
      const tags = JSON.stringify((Array.isArray(s.tags) ? s.tags : []).map(t => str(t, 40)).slice(0, 30));
      const vals = [str(s.title, 200), str(s.artist, 200), str(s.key, 12), str(s.bpm, 10), tags, str(s.notes, 1000),
        str(s.link, 500), String(s.content || ''), Math.max(-11, Math.min(11, parseInt(s.transpose) || 0)), pub, now(), JSON.stringify(lk)];
      if (ex) {
        await env.DB.prepare(`UPDATE songs SET title = ?, artist = ?, song_key = ?, bpm = ?, tags = ?, notes = ?, link = ?, content = ?,
          transpose = ?, is_public = ?, updated_at = ?, links = ?, deleted = 0 WHERE id = ?`).bind(...vals, id).run();
      } else {
        await env.DB.prepare(`INSERT INTO songs (title, artist, song_key, bpm, tags, notes, link, content, transpose, is_public, updated_at, links, id, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...vals, id, me.id).run();
      }
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
           (SELECT COUNT(*) FROM setlists t WHERE t.user_id = u.id) AS sets,
           (SELECT status FROM subscriptions x WHERE x.user_id = u.id AND x.status != 'cancelada' ORDER BY x.created_at DESC LIMIT 1) AS sub_status,
           (SELECT COUNT(*) FROM charges c WHERE c.user_id = u.id AND c.status = 'pendente' AND c.due_date < date('now', '-4 hours')) AS overdue
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
        const b = await body(req);
        if (!master && (b.role !== undefined || b.plan_id !== undefined || b.plan_expires_at !== undefined)) return needMaster();
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
          env.DB.prepare('DELETE FROM setlist_members WHERE user_id = ? OR setlist_id IN (SELECT id FROM setlists WHERE user_id = ?)').bind(id, id),
          env.DB.prepare('DELETE FROM setlists WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(id),
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
