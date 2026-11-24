// NaNota — buscar a cifra de um link (uma página por vez, a pedido do usuário logado)
import { json, err, now, body } from './lib.js';

const SITES = [
  [/(^|\.)cifraclub\.com\.br$/, 'cifraclub'],
  [/(^|\.)cifras\.com\.br$/, 'cifras'],
  [/(^|\.)ultimate-guitar\.com$/, 'ug'],
  [/(^|\.)e-chords\.com$/, 'echords'],
  [/(^|\.)letras\.(mus\.br|com)$/, 'letras'],
];
const DAILY = 40; // páginas por usuário por dia

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, k) => (k.toLowerCase() in ENT ? ENT[k.toLowerCase()] : m));
}
const strip = s => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
const clean = s => strip(s).replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
const one = (html, re) => { const m = html.match(re); return m ? clean(m[1]).replace(/\s+/g, ' ').trim() : ''; };

// o maior bloco <pre> da página (onde os sites de cifra põem a cifra)
function biggestPre(html) {
  let best = '';
  for (const m of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
    const t = clean(m[1]);
    if (t.length > best.length) best = t;
  }
  return best;
}
function metaTitle(html) {
  return one(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || one(html, /<title>([\s\S]*?)<\/title>/i);
}

function parseCifraClub(html) {
  const area = (html.match(/<div[^>]+class=["'][^"']*cifra_cnt[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || html;
  const text = biggestPre(area) || biggestPre(html);
  const title = one(html, /<h1[^>]*class=["'][^"']*\bt1\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
  const artist = one(html, /<h2[^>]*class=["'][^"']*\bt3\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  const key = one(html, /id=["']cifra_tom["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  const capo = one(html, /id=["']cifra_capo["'][^>]*>([\s\S]*?)<\/span>/i);
  const tuning = one(html, /id=["']cifra_afi["'][^>]*>([\s\S]*?)<\/span>/i);
  return { text, title, artist, key, notes: [capo, tuning && !/E A D G B E/i.test(tuning) ? tuning : ''].filter(Boolean).join(' · ') };
}

function parseUG(html) {
  const m = html.match(/class=["']js-store["'][^>]*data-content=["']([^"']+)["']/i);
  if (!m) return null;
  let data; try { data = JSON.parse(decode(m[1])); } catch (e) { return null; }
  const tv = data && data.store && data.store.page && data.store.page.data;
  const tab = tv && (tv.tab || {}), wiki = tv && tv.tab_view && tv.tab_view.wiki_tab;
  if (!wiki || !wiki.content) return null;
  const text = String(wiki.content).replace(/\r/g, '')
    .replace(/\[ch\]([\s\S]*?)\[\/ch\]/g, '$1').replace(/\[\/?tab\]/g, '')
    .replace(/\[(Intro|Verse[^\]]*|Chorus[^\]]*|Bridge|Outro|Solo|Pre-Chorus|Interlude)\]/gi, '[$1]');
  const meta = tv.tab_view.meta || {};
  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(), title: tab.song_name || '', artist: tab.artist_name || '',
    key: tab.tonality_name || meta.tonality || '', notes: meta.capo ? `Capotraste na ${meta.capo}ª casa` : '',
  };
}

function parseLetras(html) {
  const area = (html.match(/<div[^>]+class=["'][^"']*(?:lyric-original|cnt-letra)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1];
  if (!area) return null;
  const text = clean(area.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<\/?p[^>]*>/gi, ''));
  const title = one(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const artist = one(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return { text, title, artist, key: '', notes: 'Só a letra (o site não tem acordes)' };
}

export function extractChart(kind, html) {
  let r = null;
  if (kind === 'cifraclub') r = parseCifraClub(html);
  else if (kind === 'ug') r = parseUG(html);
  else if (kind === 'letras') r = parseLetras(html);
  if (!r || !r.text) {
    const text = biggestPre(html);
    if (text) r = { text, title: (r && r.title) || '', artist: (r && r.artist) || '', key: (r && r.key) || '', notes: (r && r.notes) || '' };
  }
  if (!r || !r.text || r.text.length < 20) return null;
  if (!r.title) { const t = metaTitle(html).split(/\s+[-|–]\s+/); r.title = t[0] || ''; if (!r.artist && t[1]) r.artist = t[1]; }
  r.text = r.text.slice(0, 60000);
  return r;
}

export async function fetchChartRoute(req, env, path, me) {
  if (path !== '/api/fetch-chart' || req.method !== 'POST') return null;
  const { url } = await body(req);
  let u; try { u = new URL(String(url || '').trim()); } catch (e) { return err(400, 'Link inválido.'); }
  if (!/^https?:$/.test(u.protocol)) return err(400, 'Link inválido.');
  const host = u.hostname.toLowerCase();
  const site = SITES.find(([re]) => re.test(host));
  if (!site) return err(400, 'Esse site ainda não é suportado. Use Cifra Club, Cifras.com.br, Ultimate Guitar, E-Chords ou Letras — ou copie e cole a cifra.');

  // limite diário por usuário
  const day = new Date().toISOString().slice(0, 10), uid = me.id + ':link';
  const row = await env.DB.prepare('SELECT calls FROM ai_usage WHERE user_id = ? AND day = ?').bind(uid, day).first();
  if (row && row.calls >= DAILY) return err(429, `Limite de ${DAILY} links por dia atingido. Amanhã libera de novo.`);
  await env.DB.prepare(`INSERT INTO ai_usage (user_id, day, secs, calls, updated_at) VALUES (?, ?, 0, 1, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1, updated_at = excluded.updated_at`).bind(uid, day, now()).run();

  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NaNota/1.0; importacao de cifra a pedido do usuario)', 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6' },
      cf: { cacheTtl: 3600 },
    });
  } catch (e) { return err(502, 'Não consegui abrir a página. Tente de novo ou copie e cole a cifra.'); }
  if (res.status === 404) return err(404, 'Página não encontrada. Confira o link.');
  if (!res.ok) return err(502, `O site recusou a leitura (${res.status}). Copie e cole a cifra.`);
  const html = (await res.text()).slice(0, 3_000_000);
  const r = extractChart(site[1], html);
  if (!r) return err(422, 'Abri a página, mas não encontrei a cifra nela. Copie e cole a cifra.');
  return json({ ...r, site: site[1], url: res.url || u.href });
}
