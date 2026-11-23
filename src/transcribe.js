// NaNota — transcrição da letra (Workers AI · Whisper large v3 turbo)
// O navegador manda o áudio em pedaços curtos (WAV 16 kHz mono, em base64);
// aqui cada pedaço vira palavras com o tempo de início e fim.

import { json, err, now, body, isStaff } from './lib.js';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_CHUNK_SEC = 40;          // cada pedaço tem no máximo isso
const DAILY_MIN_MEMBER = 30;       // minutos de áudio por dia para cada usuário
const DAILY_MIN_STAFF = 240;       // administradores e master

// frases que o Whisper costuma "inventar" em trechos só instrumentais
const JUNK = [
  /amara\.org/i, /legendas? (pela|por|da)/i, /legendado por/i, /tradu[cç][aã]o e legendas/i,
  /obrigad[oa] por assistir/i, /inscreva-?se/i, /deixe (seu|o) like/i, /ative o sininho/i,
  /^\s*(m[uú]sica|\[m[uú]sica\]|♪+|aplausos|risos)\s*\.?\s*$/i, /www\.|https?:\/\//i,
];
const isJunk = t => JUNK.some(r => r.test(t || ''));

function wavSeconds(b64) {
  // WAV PCM 16 bits mono 16 kHz: 32.000 bytes por segundo (cabeçalho de 44 bytes)
  const bytes = Math.floor(b64.length * 3 / 4);
  return Math.max(0, (bytes - 44) / 32000);
}

function toWords(r) {
  const out = [];
  const segs = Array.isArray(r && r.segments) ? r.segments : [];
  if (segs.length) {
    for (const s of segs) {
      const txt = String(s.text || '').trim();
      if (!txt || isJunk(txt)) continue;
      if (typeof s.no_speech_prob === 'number' && s.no_speech_prob > 0.85) continue;
      if (typeof s.compression_ratio === 'number' && s.compression_ratio > 2.8) continue;
      const ws = Array.isArray(s.words) ? s.words : [];
      if (ws.length) {
        for (const w of ws) {
          const t = String(w.word || '').trim();
          if (t) out.push({ w: t, s: +w.start || 0, e: +w.end || +w.start || 0 });
        }
      } else {
        // sem tempo por palavra: reparte o tempo do trecho entre as palavras
        const parts = txt.split(/\s+/).filter(Boolean);
        const a = +s.start || 0, z = Math.max(a + 0.1, +s.end || a + parts.length * 0.4);
        parts.forEach((t, i) => out.push({ w: t, s: a + (z - a) * i / parts.length, e: a + (z - a) * (i + 1) / parts.length }));
      }
      out[out.length - 1] && (out[out.length - 1].seg = true); // fim de frase do Whisper
    }
  } else if (Array.isArray(r && r.words)) {
    for (const w of r.words) {
      const t = String(w.word || '').trim();
      if (t) out.push({ w: t, s: +w.start || 0, e: +w.end || +w.start || 0 });
    }
  }
  // corta laços de repetição (a mesma palavra 5+ vezes seguidas)
  const clean = [];
  for (const w of out) {
    const n = clean.length;
    if (n >= 4 && [1, 2, 3, 4].every(k => clean[n - k].w.toLowerCase() === w.w.toLowerCase())) continue;
    clean.push(w);
  }
  return clean.map(w => ({ w: w.w, s: Math.round(w.s * 100) / 100, e: Math.round(w.e * 100) / 100, ...(w.seg ? { seg: 1 } : {}) }));
}

// ---- correção da letra por IA (só palavras mal ouvidas; nunca reescreve) ----
const FIX_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const bigr = s => { s = String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ç ]/g, ''); const o = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); o.set(k, (o.get(k) || 0) + 1); } return o; };
const dice = (a, b) => { const A = bigr(a), B = bigr(b); let n = 0, ta = 0, tb = 0; A.forEach(v => ta += v); B.forEach(v => tb += v); A.forEach((v, k) => { n += Math.min(v, B.get(k) || 0); }); return ta + tb ? 2 * n / (ta + tb) : 0; };
function textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  const c = r.choices && r.choices[0]; if (c && c.message) return c.message.content || '';
  return '';
}
async function fixLyrics(env, lines, title, lang) {
  const n = lines.length;
  const sys = `Você revisa transcrições automáticas de letras de música cantada (idioma: ${lang}). O áudio tinha banda e voz, então algumas palavras foram ouvidas errado.
Regras:
- Corrija SÓ palavras claramente mal ouvidas (sem sentido no contexto), acentos e concordância.
- NÃO reescreva, NÃO invente versos, NÃO traduza, NÃO mude a ordem, NÃO junte nem separe linhas, NÃO remova repetições.
- Se uma linha estiver certa ou se tiver dúvida, devolva igual.
Responda só com JSON: {"lines": [ ... exatamente ${n} textos, na mesma ordem ... ]}`;
  const user = `Música: ${title || '(sem título)'}\nLinhas (${n}):\n` + JSON.stringify(lines);
  const r = await env.AI.run(FIX_MODEL, {
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    max_tokens: Math.min(4000, 60 + n * 40), temperature: 0.1,
    chat_template_kwargs: { enable_thinking: false },
  });
  let t = textOf(r).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const a = t.indexOf('{'), z = t.lastIndexOf('}'); if (a >= 0 && z > a) t = t.slice(a, z + 1);
  let out; try { out = JSON.parse(t).lines; } catch (e) { return null; }
  if (!Array.isArray(out) || out.length !== n) return null;
  // validação linha a linha: mudança pequena e plausível, senão mantém a original
  return out.map((x, i) => {
    const o = lines[i], c = String(x || '').trim();
    const wo = o.split(/\s+/).length, wc = c.split(/\s+/).length;
    if (!c || wc < wo * 0.6 || wc > wo * 1.5 + 1 || dice(o, c) < 0.45) return o;
    return c;
  });
}

export async function transcribeRoutes(req, env, path, me) {
  if (path === '/api/lyrics/fix' && req.method === 'POST') {
    if (!env.AI) return err(503, 'A IA ainda não está ligada no servidor.');
    const { lines, title, lang } = await body(req);
    if (!Array.isArray(lines) || !lines.length) return err(400, 'Sem linhas.');
    const L = lines.slice(0, 160).map(x => String(x || '').slice(0, 160));
    try {
      const fixed = await fixLyrics(env, L, String(title || '').slice(0, 120), /^[a-z]{2}$/.test(String(lang || '')) ? lang : 'pt');
      return json({ lines: fixed || L, ok: !!fixed });
    } catch (e) { console.error('fix', e && e.message); return json({ lines: L, ok: false }); }
  }
  if (path !== '/api/transcribe') return null;

  if (req.method === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare('SELECT secs FROM ai_usage WHERE user_id = ? AND day = ?').bind(me.id, day).first();
    const lim = (isStaff(me) ? DAILY_MIN_STAFF : DAILY_MIN_MEMBER) * 60;
    return json({ enabled: !!env.AI, usedSec: row ? row.secs : 0, limitSec: lim });
  }
  if (req.method !== 'POST') return err(405, 'Método não permitido.');
  if (!env.AI) return err(503, 'A transcrição ainda não está ligada no servidor.');

  const { audio, lang, prompt } = await body(req);
  if (typeof audio !== 'string' || audio.length < 1000) return err(400, 'Áudio vazio.');
  const secs = wavSeconds(audio);
  if (secs > MAX_CHUNK_SEC + 1) return err(413, 'Pedaço de áudio grande demais.');

  const day = new Date().toISOString().slice(0, 10);
  const lim = (isStaff(me) ? DAILY_MIN_STAFF : DAILY_MIN_MEMBER) * 60;
  const row = await env.DB.prepare('SELECT secs FROM ai_usage WHERE user_id = ? AND day = ?').bind(me.id, day).first();
  if ((row ? row.secs : 0) + secs > lim) return err(429, `Você chegou ao limite de ${Math.round(lim / 60)} min de transcrição por dia. Amanhã libera de novo.`);

  const input = {
    audio,
    task: 'transcribe',
    language: /^[a-z]{2}$/.test(String(lang || '')) ? lang : 'pt',
    condition_on_previous_text: false,
    hallucination_silence_threshold: 2,
  };
  const p = String(prompt || '').slice(0, 400).trim();
  if (p) input.initial_prompt = p;

  let r;
  try { r = await env.AI.run(MODEL, input); }
  catch (e) {
    console.error('whisper', e && e.message);
    return err(502, 'O serviço de transcrição não respondeu. Tente de novo em instantes.');
  }

  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, secs, calls, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET secs = secs + excluded.secs, calls = calls + 1, updated_at = excluded.updated_at`
  ).bind(me.id, day, Math.ceil(secs), now()).run();

  const words = toWords(r);
  const info = r && r.transcription_info;
  return json({ words, lang: info && info.language || input.language, sec: Math.round(secs * 10) / 10 });
}

export { toWords as _toWords };
