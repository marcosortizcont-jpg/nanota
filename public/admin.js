// NaNota — base comum dos módulos de administração (Usuários, Financeiro)
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c, i) => { const v = ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); return v + (i === 'month' ? '/mês' : i === 'year' ? '/ano' : ''); };
const fmtDate = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';
const fmtTs = t => t ? new Date(t * 1000).toLocaleDateString('pt-BR') : '—';
const toCents = v => Math.round(parseFloat(String(v || '0').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) * 100) || 0;
const centsStr = c => c ? (c / 100).toFixed(2).replace('.', ',') : '';
const todayStr = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
let ME = null;

async function api(method, path, data) {
  let r;
  try { r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-nanota': '1' }, body: data === undefined ? undefined : JSON.stringify(data) }); }
  catch (e) { throw Object.assign(new Error('Sem conexão com o servidor.'), { status: 0 }); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401) { location.href = '/?voltar=' + encodeURIComponent(location.pathname); throw new Error('Faça login.'); }
  if (!r.ok) throw Object.assign(new Error(j.error || ('Erro ' + r.status)), { status: r.status });
  return j;
}
function toast(msg) { document.querySelectorAll('.toast').forEach(x => x.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); }
function modal(html, wide) {
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = `<div class="mod" ${wide ? 'style="width:min(760px,100%)"' : ''}>${html}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', k); };
  const k = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', k);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  return { el: ov, close };
}
function confirmBox(msg, ok = 'Confirmar', danger = true) {
  return new Promise(res => {
    const m = modal(`<div class="mh">Confirmar</div><div class="mb"><p>${esc(msg)}</p></div><div class="mf"><button class="btn" data-x="0">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${esc(ok)}</button></div>`);
    m.el.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) { m.close(); res(b.dataset.x === '1'); } });
  });
}
let qrP = null;
function loadQR() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrP) qrP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; s.onload = () => res(window.qrcode); s.onerror = () => { qrP = null; rej(); }; document.head.appendChild(s); });
  return qrP;
}
async function drawQR(el, text, cell = 4) {
  try { const q = await loadQR(); const qr = q(0, 'M'); qr.addData(text); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize: cell, margin: 2 }); el.classList.add('qr'); }
  catch (e) { el.remove(); }
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copiado.'); } catch (e) { toast('Selecione o texto e copie.'); } }

/** Monta o topo com a navegação entre os módulos e confere o acesso. */
async function boot(page, { master = false } = {}) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="top"><div class="in">
    <a class="logo" href="/"><span class="dot">♯</span>NaNota</a>
    <nav class="nav" id="nav"><a href="/">🎵 Músicas</a><a href="/#repertorios">📋 Repertórios</a><a href="/ao-vivo.html">🎤 Ao vivo</a></nav>
    <div class="sp"></div><span class="who" id="who"></span><button class="btn sm" id="out">Sair</button></div></div>`);
  $('#out').onclick = async () => { try { await api('POST', '/api/logout'); } catch (e) {} location.href = '/'; };
  try { ME = (await api('GET', '/api/me')).user; } catch (e) { return false; }
  if (ME.mustChangePassword) { location.href = '/'; return false; }
  const staff = ME.role === 'admin' || ME.isMaster;
  $('#nav').insertAdjacentHTML('beforeend', (staff ? `<a href="/usuarios.html" class="${page === 'usuarios' ? 'act' : ''}">👥 Usuários</a>` : '') + (ME.isMaster ? `<a href="/financeiro.html" class="${page === 'financeiro' ? 'act' : ''}">💰 Financeiro</a>` : ''));
  $('#who').textContent = (ME.name || ME.email) + (ME.isMaster ? ' · master' : ME.role === 'admin' ? ' · admin' : '');
  if (!staff || (master && !ME.isMaster)) {
    $('#app').innerHTML = `<div class="gate"><div><h1>Acesso restrito</h1><p>${master ? 'Este módulo é exclusivo do usuário master.' : 'Este módulo é exclusivo de administradores.'}</p><a class="btn primary" href="/">Voltar ao NaNota</a></div></div>`;
    return false;
  }
  return true;
}
