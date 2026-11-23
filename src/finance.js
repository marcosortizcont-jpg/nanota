// NaNota — módulo financeiro: modelos de planos (em /api/admin/plans), assinaturas, cobranças e recebimentos (PIX)
import { json, err, body, str, now, validId, planOut } from './lib.js';

const METHODS = ['pix', 'dinheiro', 'transferencia', 'cartao', 'boleto', 'outro'];
export const today = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); // horário de MS/MT
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const cents = v => Math.max(0, Math.round(Number(v) || 0));
const uid = p => p + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const txidNew = () => 'NN' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();

function addPeriod(date, interval, dueDay) {
  const [y, m] = date.split('-').map(Number);
  const months = interval === 'year' ? 12 : 1;
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(dueDay || 10, last));
  return t.toISOString().slice(0, 10);
}

/* ----- PIX (BR Code estático, padrão EMV do Banco Central) ----- */
function emv(id, v) { return id + String(v.length).padStart(2, '0') + v; }
export function crc16(s) {
  let crc = 0xFFFF;
  for (const ch of new TextEncoder().encode(s)) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const plain = (s, n) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .-]/g, '').toUpperCase().trim().slice(0, n);
export function pixPayload({ key, name, city, amountCents, txid }) {
  const gui = emv('00', 'br.gov.bcb.pix') + emv('01', String(key).trim());
  let p = emv('00', '01') + emv('26', gui) + emv('52', '0000') + emv('53', '986');
  if (amountCents > 0) p += emv('54', (amountCents / 100).toFixed(2));
  p += emv('58', 'BR') + emv('59', plain(name, 25) || 'NANOTA') + emv('60', plain(city, 15) || 'BRASIL');
  p += emv('62', emv('05', (txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) + '6304';
  return p + crc16(p);
}

async function settings(env) {
  const r = await env.DB.prepare('SELECT key, value FROM settings').all();
  const o = {}; r.results.forEach(x => o[x.key] = x.value); return o;
}
const chargeOut = (c, t) => ({ ...c, status_view: c.status === 'pendente' && c.due_date < t ? 'vencido' : c.status });

/** Área do usuário: plano, assinatura e cobranças com PIX. */
export async function myBilling(env, me) {
  const t = today();
  const [plan, sub, ch, st] = await Promise.all([
    env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(me.plan_id || 'gratuito').first(),
    env.DB.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status != 'cancelada' ORDER BY created_at DESC LIMIT 1`).bind(me.id).first(),
    env.DB.prepare(`SELECT id, description, amount_cents, due_date, status, paid_at, method, txid FROM charges WHERE user_id = ? AND status != 'cancelado' ORDER BY due_date DESC LIMIT 24`).bind(me.id).all(),
    settings(env),
  ]);
  const pixOn = !!st.pix_key;
  return json({
    plan: plan ? planOut(plan) : null,
    subscription: sub ? { status: sub.status, priceCents: sub.price_cents, interval: sub.billing_interval, nextDue: sub.next_due_date } : null,
    charges: ch.results.map(c => {
      const o = chargeOut(c, t);
      if (pixOn && c.status === 'pendente') o.pix = pixPayload({ key: st.pix_key, name: st.pix_name, city: st.pix_city, amountCents: c.amount_cents, txid: c.txid });
      delete o.txid; return o;
    }),
    pix: pixOn ? { name: st.pix_name || '', instructions: st.pay_instructions || '' } : null,
  });
}

async function setUserPlan(env, userId, planId) {
  let p = planId ? await env.DB.prepare('SELECT id FROM plans WHERE id = ?').bind(planId).first() : null;
  if (!p) p = await env.DB.prepare('SELECT id FROM plans WHERE is_default = 1 LIMIT 1').first();
  await env.DB.prepare('UPDATE users SET plan_id = ? WHERE id = ?').bind(p ? p.id : 'gratuito', userId).run();
}

export async function financeRoutes(req, env, url, path, m, me) {
  if (!path.startsWith('/api/fin/')) return null;
  if (!me.is_master) return err(403, 'O módulo financeiro é exclusivo do usuário master.');
  const t = today();

  /* ----- resumo ----- */
  if (path === '/api/fin/summary' && m === 'GET') {
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : t.slice(0, 7);
    const one = sql => env.DB.prepare(sql);
    const [rec, toRec, over, subs, series, byPlan] = await env.DB.batch([
      one(`SELECT COALESCE(SUM(COALESCE(paid_cents, amount_cents)),0) AS v, COUNT(*) AS n FROM charges WHERE status = 'pago' AND substr(paid_at,1,7) = ?`).bind(month),
      one(`SELECT COALESCE(SUM(amount_cents),0) AS v, COUNT(*) AS n FROM charges WHERE status = 'pendente' AND substr(due_date,1,7) = ?`).bind(month),
      one(`SELECT COALESCE(SUM(amount_cents),0) AS v, COUNT(*) AS n FROM charges WHERE status = 'pendente' AND due_date < ?`).bind(t),
      one(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE billing_interval WHEN 'month' THEN price_cents WHEN 'year' THEN price_cents / 12.0 ELSE 0 END),0) AS mrr FROM subscriptions WHERE status = 'ativa'`),
      one(`SELECT substr(paid_at,1,7) AS mes, SUM(COALESCE(paid_cents, amount_cents)) AS v FROM charges WHERE status = 'pago' AND paid_at >= date(?, '-11 months', 'start of month') GROUP BY mes ORDER BY mes`).bind(t),
      one(`SELECT p.id, p.name, COUNT(s.id) AS n, COALESCE(SUM(s.price_cents),0) AS v FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status = 'ativa' GROUP BY p.id ORDER BY p.sort, p.price_cents`),
    ]);
    const users = await one(`SELECT plan_id, COUNT(*) AS n FROM users WHERE status != 'disabled' GROUP BY plan_id`).all();
    return json({
      month, today: t,
      received: rec.results[0], toReceive: toRec.results[0], overdue: over.results[0],
      activeSubs: subs.results[0].n, mrr: Math.round(subs.results[0].mrr),
      series: series.results, byPlan: byPlan.results, usersByPlan: users.results,
    });
  }

  /* ----- configurações de recebimento ----- */
  if (path === '/api/fin/settings') {
    if (m === 'GET') return json(await settings(env));
    if (m === 'PUT') {
      const b = await body(req);
      const keys = { pix_key: 77, pix_name: 25, pix_city: 15, pay_instructions: 500 };
      await env.DB.batch(Object.entries(keys).filter(([k]) => b[k] !== undefined).map(([k, n]) =>
        env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, str(b[k], n).trim())));
      return json({ ok: true });
    }
  }

  /* ----- cobranças ----- */
  if (path === '/api/fin/charges' && m === 'GET') {
    const st = url.searchParams.get('status') || 'todos', month = url.searchParams.get('month') || '', userId = url.searchParams.get('user_id') || '';
    const where = [], vals = [];
    if (st === 'vencido') { where.push(`c.status = 'pendente' AND c.due_date < ?`); vals.push(t); }
    else if (['pendente', 'pago', 'cancelado'].includes(st)) { where.push('c.status = ?'); vals.push(st); }
    if (/^\d{4}-\d{2}$/.test(month)) { where.push(`(substr(c.due_date,1,7) = ? OR substr(c.paid_at,1,7) = ?)`); vals.push(month, month); }
    if (userId) { where.push('c.user_id = ?'); vals.push(userId); }
    const r = await env.DB.prepare(
      `SELECT c.*, COALESCE(u.name, c.customer_name) AS name, COALESCE(u.email, c.customer_email) AS email, p.name AS plan_name
       FROM charges c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.due_date DESC, c.created_at DESC LIMIT 500`
    ).bind(...vals).all();
    return json({ charges: r.results.map(c => chargeOut(c, t)) });
  }
  if (path === '/api/fin/charges' && m === 'POST') {
    const b = await body(req);
    const u = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(String(b.user_id || '')).first();
    if (!u) return err(400, 'Escolha o usuário da cobrança.');
    if (!(cents(b.amount_cents) > 0)) return err(400, 'Informe o valor.');
    if (!isDate(b.due_date)) return err(400, 'Informe o vencimento.');
    const id = uid('c');
    await env.DB.prepare(`INSERT INTO charges (id, user_id, customer_name, customer_email, plan_id, subscription_id, description, amount_cents, due_date, txid, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, u.id, u.name || '', u.email, b.plan_id ? String(b.plan_id) : null, b.subscription_id ? String(b.subscription_id) : null,
      str(b.description, 200) || 'Cobrança', cents(b.amount_cents), b.due_date, txidNew(), me.id).run();
    return json({ ok: true, id });
  }
  let mm = path.match(/^\/api\/fin\/charges\/([A-Za-z0-9-]+)(\/pix)?$/);
  if (mm) {
    const c = await env.DB.prepare('SELECT * FROM charges WHERE id = ?').bind(mm[1]).first();
    if (!c) return err(404, 'Cobrança não encontrada.');
    if (mm[2] && m === 'GET') {
      const st = await settings(env);
      if (!st.pix_key) return err(400, 'Cadastre a chave PIX em Configurações.');
      return json({ pix: pixPayload({ key: st.pix_key, name: st.pix_name, city: st.pix_city, amountCents: c.amount_cents, txid: c.txid }) });
    }
    if (m === 'PATCH') {
      const b = await body(req);
      if (b.action === 'pay') {
        if (c.status === 'cancelado') return err(400, 'Reabra a cobrança antes de dar baixa.');
        const method = METHODS.includes(b.method) ? b.method : 'pix';
        await env.DB.prepare(`UPDATE charges SET status = 'pago', paid_at = ?, paid_cents = ?, method = ?, notes = ? WHERE id = ?`)
          .bind(isDate(b.paid_at) ? b.paid_at : t, b.paid_cents != null && b.paid_cents !== '' ? cents(b.paid_cents) : c.amount_cents, method, str(b.notes, 300), c.id).run();
        return json({ ok: true });
      }
      if (b.action === 'cancel') { await env.DB.prepare(`UPDATE charges SET status = 'cancelado' WHERE id = ?`).bind(c.id).run(); return json({ ok: true }); }
      if (b.action === 'reopen') { await env.DB.prepare(`UPDATE charges SET status = 'pendente', paid_at = NULL, paid_cents = NULL, method = NULL WHERE id = ?`).bind(c.id).run(); return json({ ok: true }); }
      if (b.action === 'edit') {
        if (c.status === 'pago') return err(400, 'Cobrança já paga — reabra para editar.');
        await env.DB.prepare('UPDATE charges SET description = ?, amount_cents = ?, due_date = ? WHERE id = ?')
          .bind(str(b.description, 200) || c.description, cents(b.amount_cents) || c.amount_cents, isDate(b.due_date) ? b.due_date : c.due_date, c.id).run();
        return json({ ok: true });
      }
      return err(400, 'Ação inválida.');
    }
  }

  /* ----- assinaturas ----- */
  if (path === '/api/fin/subscriptions' && m === 'GET') {
    const r = await env.DB.prepare(
      `SELECT s.*, u.name, u.email, p.name AS plan_name,
         (SELECT COUNT(*) FROM charges c WHERE c.subscription_id = s.id AND c.status = 'pendente' AND c.due_date < ?) AS overdue
       FROM subscriptions s JOIN users u ON u.id = s.user_id LEFT JOIN plans p ON p.id = s.plan_id
       ORDER BY s.status = 'ativa' DESC, s.status = 'suspensa' DESC, u.name COLLATE NOCASE`
    ).bind(t).all();
    return json({ subscriptions: r.results });
  }
  if (path === '/api/fin/subscriptions' && m === 'POST') {
    const b = await body(req);
    const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(String(b.user_id || '')).first();
    if (!u) return err(400, 'Escolha o usuário.');
    const p = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(String(b.plan_id || '')).first();
    if (!p) return err(400, 'Escolha o plano.');
    const interval = ['month', 'year', 'none'].includes(b.billing_interval) ? b.billing_interval : (p.billing_interval || 'month');
    const dueDay = Math.max(1, Math.min(28, parseInt(b.due_day) || 10));
    const start = isDate(b.start_date) ? b.start_date : t;
    const id = uid('a');
    await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET status = 'cancelada', canceled_at = ? WHERE user_id = ? AND status != 'cancelada'`).bind(t, u.id),
      env.DB.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, status, price_cents, billing_interval, due_day, next_due_date, started_at, notes)
        VALUES (?, ?, ?, 'ativa', ?, ?, ?, ?, ?, ?)`).bind(id, u.id, p.id, b.price_cents != null && b.price_cents !== '' ? cents(b.price_cents) : p.price_cents,
        interval, dueDay, interval === 'none' ? null : start, start, str(b.notes, 300)),
      env.DB.prepare('UPDATE users SET plan_id = ? WHERE id = ?').bind(p.id, u.id),
    ]);
    return json({ ok: true, id });
  }
  mm = path.match(/^\/api\/fin\/subscriptions\/([A-Za-z0-9-]+)$/);
  if (mm && m === 'PATCH') {
    const s = await env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(mm[1]).first();
    if (!s) return err(404, 'Assinatura não encontrada.');
    const b = await body(req);
    const sets = [], vals = [];
    let planId = s.plan_id, status = s.status;
    if (b.plan_id !== undefined) {
      const p = await env.DB.prepare('SELECT id FROM plans WHERE id = ?').bind(String(b.plan_id)).first();
      if (!p) return err(400, 'Plano não encontrado.');
      planId = p.id; sets.push('plan_id = ?'); vals.push(p.id);
    }
    if (b.price_cents !== undefined) { sets.push('price_cents = ?'); vals.push(cents(b.price_cents)); }
    if (b.due_day !== undefined) { sets.push('due_day = ?'); vals.push(Math.max(1, Math.min(28, parseInt(b.due_day) || 10))); }
    if (b.next_due_date !== undefined && isDate(b.next_due_date)) { sets.push('next_due_date = ?'); vals.push(b.next_due_date); }
    if (b.notes !== undefined) { sets.push('notes = ?'); vals.push(str(b.notes, 300)); }
    if (b.status !== undefined && ['ativa', 'suspensa', 'cancelada'].includes(b.status)) {
      status = b.status; sets.push('status = ?'); vals.push(status);
      if (status === 'cancelada') { sets.push('canceled_at = ?'); vals.push(t); }
    }
    if (!sets.length) return err(400, 'Nada para alterar.');
    await env.DB.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, s.id).run();
    await setUserPlan(env, s.user_id, status === 'ativa' ? planId : null);
    return json({ ok: true });
  }

  /* ----- gerar cobranças das assinaturas ----- */
  if (path === '/api/fin/generate' && m === 'POST') {
    const b = await body(req);
    const until = isDate(b.until) ? b.until : t;
    const subs = await env.DB.prepare(
      `SELECT s.*, u.name, u.email, p.name AS plan_name FROM subscriptions s JOIN users u ON u.id = s.user_id LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.status = 'ativa' AND s.billing_interval != 'none' AND s.next_due_date IS NOT NULL AND s.next_due_date <= ? AND s.price_cents > 0`
    ).bind(until).all();
    let created = 0;
    for (const s of subs.results) {
      let due = s.next_due_date;
      const stmts = [];
      for (let k = 0; k < 24 && due <= until; k++) {
        const ex = await env.DB.prepare(`SELECT id FROM charges WHERE subscription_id = ? AND due_date = ? AND status != 'cancelado'`).bind(s.id, due).first();
        if (!ex) {
          const [y, mo] = due.split('-');
          stmts.push(env.DB.prepare(`INSERT INTO charges (id, user_id, customer_name, customer_email, plan_id, subscription_id, description, amount_cents, due_date, txid, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid('c'), s.user_id, s.name || '', s.email, s.plan_id, s.id,
            `Plano ${s.plan_name || s.plan_id} — ${s.billing_interval === 'year' ? y : mo + '/' + y}`, s.price_cents, due, txidNew(), me.id));
          created++;
        }
        due = addPeriod(due, s.billing_interval, s.due_day);
      }
      stmts.push(env.DB.prepare('UPDATE subscriptions SET next_due_date = ? WHERE id = ?').bind(due, s.id));
      await env.DB.batch(stmts);
    }
    return json({ ok: true, created });
  }

  return err(404, 'Rota não encontrada.');
}
