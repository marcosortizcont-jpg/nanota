// NaNota — repertórios (pessoais e em grupo), permissões por membro e histórico de alterações
import { json, err, body, str, now, validId, isStaff, planOf } from './lib.js';

const NS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NF = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const IDX = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
const FLAT = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
function keyAt(key, s) {
  const m = String(key || '').match(/^([A-G][#b]?)(.*)$/);
  if (!m || IDX[m[1]] === undefined) return '';
  const j = ((IDX[m[1]] + s) % 12 + 12) % 12;
  const minor = /^m(?!aj)/.test(m[2]) ? 'm' : '';
  return (FLAT.has(NF[j] + minor) ? NF[j] : NS[j]) + minor;
}

const PERM_LABEL = { list: 'editar a lista', transpose: 'mudar o tom', songs: 'editar as cifras', manage: 'gerenciar membros' };
const ALL = { list: 1, transpose: 1, songs: 1, manage: 1, owner: 1 };
const permsOf = r => ({ list: r.can_edit_list ? 1 : 0, transpose: r.can_transpose ? 1 : 0, songs: r.can_edit_songs ? 1 : 0, manage: r.can_manage ? 1 : 0, owner: 0 });
const permText = p => Object.keys(PERM_LABEL).filter(k => p[k]).map(k => PERM_LABEL[k]).join(', ') || 'só visualizar';
const fmtDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : 'sem data'; };

function parseItems(t) { try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; } }

function setOutFor(r, me) {
  const owner = r.user_id === me.id;
  return {
    id: r.id, type: 'set', name: r.name, date: r.set_date, items: parseItems(r.items), updated: r.updated_at * 1000, version: r.version,
    group: { isGroup: (r.members || 0) > 0, members: r.members || 0, ownerId: r.user_id, ownerName: r.owner_name || '', isOwner: owner, perms: owner ? ALL : permsOf(r) },
  };
}

/** Repertórios do usuário (próprios e de grupos) e as músicas referenciadas que ele ainda não vê. */
export async function setsForUser(env, me, visibleSongIds) {
  const r = await env.DB.prepare(
    `SELECT s.*, u.name AS owner_name, m.can_edit_list, m.can_transpose, m.can_edit_songs, m.can_manage,
       (SELECT COUNT(*) FROM setlist_members x WHERE x.setlist_id = s.id) AS members
     FROM setlists s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN setlist_members m ON m.setlist_id = s.id AND m.user_id = ?
     WHERE s.deleted = 0 AND (s.user_id = ? OR m.user_id IS NOT NULL)`
  ).bind(me.id, me.id).all();
  const sets = r.results.map(x => setOutFor(x, me));
  const need = new Set();
  sets.forEach(s => s.items.forEach(it => { if (!visibleSongIds.has(it.songId)) need.add(it.songId); }));
  let extra = [];
  const ids = [...need].filter(validId);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const q = await env.DB.prepare(`SELECT * FROM songs WHERE deleted = 0 AND id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    extra = extra.concat(q.results);
  }
  return { sets, extra };
}

async function access(env, setId, me) {
  const s = await env.DB.prepare('SELECT * FROM setlists WHERE id = ?').bind(setId).first();
  if (!s) return { set: null };
  if (s.user_id === me.id) return { set: s, perms: ALL };
  const m = await env.DB.prepare('SELECT * FROM setlist_members WHERE setlist_id = ? AND user_id = ?').bind(setId, me.id).first();
  return { set: s, perms: m ? permsOf(m) : null };
}

async function addLogs(env, setId, me, entries) {
  if (!entries.length) return;
  await env.DB.batch(entries.slice(0, 40).map(([action, detail]) =>
    env.DB.prepare('INSERT INTO setlist_logs (setlist_id, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(setId, me.id, me.name || me.email, action, str(detail, 500))));
}

/** Compara a versão antiga e a nova de um repertório: devolve as alterações e a permissão que cada uma exige. */
export async function logSetChanges(env, old, next) {
  const changes = [];
  if ((old.name || '') !== (next.name || '')) changes.push(['list', 'renomeou', `Renomeou para “${next.name}”`]);
  if ((old.set_date || '') !== (next.date || '')) changes.push(['list', 'data', `Mudou a data para ${fmtDate(next.date)}`]);
  const oi = parseItems(old.items), ni = next.items;
  const ids = [...new Set([...oi, ...ni].map(i => i.songId))].filter(validId);
  const info = {};
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    const q = await env.DB.prepare(`SELECT id, title, song_key FROM songs WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c).all();
    q.results.forEach(r => info[r.id] = r);
  }
  const title = id => `“${info[id] ? info[id].title : 'música excluída'}”`;
  const count = a => a.reduce((m, it) => (m[it.songId] = (m[it.songId] || 0) + 1, m), {});
  const oc = count(oi), nc = count(ni);
  let seqChanged = false;
  for (const id of new Set([...Object.keys(oc), ...Object.keys(nc)])) {
    const d = (nc[id] || 0) - (oc[id] || 0);
    for (let k = 0; k < d; k++) { changes.push(['list', 'adicionou', `Adicionou ${title(id)}`]); seqChanged = true; }
    for (let k = 0; k < -d; k++) { changes.push(['list', 'removeu', `Removeu ${title(id)}`]); seqChanged = true; }
  }
  if (!seqChanged && oi.map(i => i.songId).join() !== ni.map(i => i.songId).join()) changes.push(['list', 'reordenou', 'Mudou a ordem das músicas']);
  // pares por ocorrência da mesma música
  const seen = {}, olds = {};
  oi.forEach(it => (olds[it.songId] = olds[it.songId] || []).push(it));
  for (const it of ni) {
    const k = seen[it.songId] = (seen[it.songId] || 0) + 1;
    const o = (olds[it.songId] || [])[k - 1];
    if (!o) continue;
    if ((o.transpose || 0) !== (it.transpose || 0)) {
      const base = info[it.songId] && info[it.songId].song_key;
      changes.push(['transpose', 'tom', `Mudou o tom de ${title(it.songId)}${base ? ` de ${keyAt(base, o.transpose || 0)} para ${keyAt(base, it.transpose || 0)}` : ''}`]);
    }
    const oc2 = o.content ?? null, nc2 = it.content ?? null;
    if (oc2 !== nc2) changes.push(['songs', 'versao', nc2 === null ? `Restaurou a cifra padrão de ${title(it.songId)}` : oc2 === null ? `Criou uma versão própria de ${title(it.songId)}` : `Editou a versão de ${title(it.songId)}`]);
    if ((o.notes ?? null) !== (it.notes ?? null)) changes.push(['songs', 'obs', `Alterou as observações de ${title(it.songId)}`]);
  }
  return changes;
}

function cleanItems(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 300)
    .filter(it => it && validId(String(it.songId)))
    .map(it => {
      const o = { songId: String(it.songId), transpose: Math.max(-11, Math.min(11, parseInt(it.transpose) || 0)) };
      if (typeof it.content === 'string') o.content = it.content.slice(0, 100000);
      if (typeof it.notes === 'string') o.notes = it.notes.slice(0, 1000);
      if (typeof it.key === 'string' && /^[A-G][#b]?m?$/.test(it.key)) o.key = it.key;
      return o;
    });
}

export async function groupRoutes(req, env, url, path, m, me) {
  /* busca de usuários para convidar ao grupo */
  if (path === '/api/users/search' && m === 'GET') {
    const q = '%' + String(url.searchParams.get('q') || '').trim().replace(/[%_]/g, '') + '%';
    if (q.length < 4) return json({ users: [] });
    const r = await env.DB.prepare(
      `SELECT id, name, email FROM users WHERE status = 'active' AND id != ? AND (name LIKE ? OR email LIKE ?) ORDER BY name COLLATE NOCASE LIMIT 8`
    ).bind(me.id, q, q).all();
    return json({ users: r.results });
  }

  let mm = path.match(/^\/api\/sets\/([^/]+)(?:\/(members|logs|leave)(?:\/([^/]+))?)?$/);
  if (!mm) return null;
  const [, id, sub, uid] = mm;
  if (!validId(id)) return err(400, 'Identificador inválido.');
  const { set, perms } = await access(env, id, me);
  if (set && !perms) return err(404, 'Repertório não encontrado.');

  /* salvar / excluir o repertório */
  if (!sub) {
    if (m === 'DELETE') {
      if (!set) return json({ ok: true });
      if (!perms.owner) return err(403, 'Só o dono pode excluir o repertório. Você pode sair do grupo.');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM setlist_members WHERE setlist_id = ?').bind(id),
        env.DB.prepare('DELETE FROM setlist_logs WHERE setlist_id = ?').bind(id),
        env.DB.prepare('DELETE FROM setlists WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
    if (m !== 'PUT') return err(405, 'Método não permitido.');
    const s = await body(req);
    const items = cleanItems(s.items);
    const itemsJson = JSON.stringify(items);
    if (itemsJson.length > 1500000) return err(413, 'Repertório muito grande.');
    const next = { name: str(s.name, 200), date: str(s.date, 10), items };

    if (!set) {
      if (!isStaff(me)) {
        const lim = await planOf(env, me);
        if (lim && lim.max_setlists != null) {
          const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM setlists WHERE user_id = ?').bind(me.id).first();
          if (c.n >= lim.max_setlists) return err(402, `Seu plano (${lim.name}) permite até ${lim.max_setlists} repertórios.`);
        }
      }
      await env.DB.prepare('INSERT INTO setlists (id, user_id, name, set_date, items, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .bind(id, me.id, next.name, next.date, itemsJson, now()).run();
      await addLogs(env, id, me, [['criou', `Criou o repertório “${next.name}”`]]);
      return json({ ok: true, version: 1 });
    }

    if (s.version !== undefined && s.version !== null && Number(s.version) !== set.version) {
      return err(409, 'Outra pessoa alterou este repertório agora há pouco. Atualizei para a versão mais recente — refaça sua alteração.');
    }
    const changes = await logSetChanges(env, set, next);
    if (!changes.length) return json({ ok: true, version: set.version });
    const denied = changes.find(c => !perms[c[0]]);
    if (denied) return err(403, `Você não tem permissão para ${PERM_LABEL[denied[0]]} neste repertório.`);
    const ver = set.version + 1;
    const r = await env.DB.prepare('UPDATE setlists SET name = ?, set_date = ?, items = ?, updated_at = ?, version = ?, deleted = 0 WHERE id = ? AND version = ?')
      .bind(next.name, next.date, itemsJson, now(), ver, id, set.version).run();
    if (!r.meta || r.meta.changes === 0) return err(409, 'Outra pessoa alterou este repertório agora há pouco. Atualizei para a versão mais recente — refaça sua alteração.');
    await addLogs(env, id, me, changes.map(c => [c[1], c[2]]));
    return json({ ok: true, version: ver });
  }

  if (!set) return err(404, 'Repertório não encontrado.');

  /* histórico */
  if (sub === 'logs' && m === 'GET') {
    const lim = Math.min(300, parseInt(url.searchParams.get('limit')) || 150);
    const r = await env.DB.prepare('SELECT id, user_id, user_name, action, detail, created_at FROM setlist_logs WHERE setlist_id = ? ORDER BY id DESC LIMIT ?').bind(id, lim).all();
    return json({ logs: r.results });
  }

  /* sair do grupo */
  if (sub === 'leave' && m === 'POST') {
    if (perms.owner) return err(400, 'O dono não pode sair. Exclua o repertório ou transfira os membros.');
    await env.DB.prepare('DELETE FROM setlist_members WHERE setlist_id = ? AND user_id = ?').bind(id, me.id).run();
    await addLogs(env, id, me, [['saiu', 'Saiu do grupo']]);
    return json({ ok: true });
  }

  /* membros */
  if (sub === 'members') {
    if (m === 'GET' && !uid) {
      const r = await env.DB.prepare(
        `SELECT m.*, u.name, u.email FROM setlist_members m JOIN users u ON u.id = m.user_id WHERE m.setlist_id = ? ORDER BY u.name COLLATE NOCASE`
      ).bind(id).all();
      const owner = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(set.user_id).first();
      return json({
        owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
        members: r.results.map(x => ({ id: x.user_id, name: x.name, email: x.email, perms: permsOf(x), addedAt: x.added_at })),
        myPerms: perms,
      });
    }
    if (!uid) return err(405, 'Método não permitido.');
    if (uid === set.user_id) return err(400, 'O dono sempre tem todas as permissões.');
    const target = await env.DB.prepare('SELECT id, name, email, status FROM users WHERE id = ?').bind(uid).first();
    if (!target) return err(404, 'Usuário não encontrado.');
    const tName = target.name || target.email;

    if (m === 'DELETE') {
      if (uid !== me.id && !perms.manage) return err(403, 'Você não tem permissão para gerenciar membros.');
      await env.DB.prepare('DELETE FROM setlist_members WHERE setlist_id = ? AND user_id = ?').bind(id, uid).run();
      await addLogs(env, id, me, [['membro', uid === me.id ? 'Saiu do grupo' : `Removeu ${tName} do grupo`]]);
      return json({ ok: true });
    }
    if (m === 'PUT') {
      if (!perms.manage) return err(403, 'Você não tem permissão para gerenciar membros.');
      if (target.status !== 'active') return err(400, 'Esse usuário ainda não ativou a conta ou está bloqueado.');
      const b = await body(req);
      const p = { list: b.list ? 1 : 0, transpose: b.transpose ? 1 : 0, songs: b.songs ? 1 : 0, manage: b.manage ? 1 : 0 };
      if (p.manage && !perms.owner) return err(403, 'Só o dono pode dar a permissão de gerenciar membros.');
      const ex = await env.DB.prepare('SELECT * FROM setlist_members WHERE setlist_id = ? AND user_id = ?').bind(id, uid).first();
      if (ex && ex.can_manage && !perms.owner) return err(403, 'Só o dono pode alterar quem gerencia membros.');
      await env.DB.prepare(
        `INSERT INTO setlist_members (setlist_id, user_id, can_edit_list, can_transpose, can_edit_songs, can_manage, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(setlist_id, user_id) DO UPDATE SET can_edit_list = excluded.can_edit_list, can_transpose = excluded.can_transpose,
           can_edit_songs = excluded.can_edit_songs, can_manage = excluded.can_manage`
      ).bind(id, uid, p.list, p.transpose, p.songs, p.manage, me.id).run();
      await addLogs(env, id, me, [['membro', ex ? `Alterou as permissões de ${tName}: ${permText(p)}` : `Adicionou ${tName} ao grupo (${permText(p)})`]]);
      return json({ ok: true });
    }
  }
  return err(405, 'Método não permitido.');
}
