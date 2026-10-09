/* =====================================================================
   STREETBALL · SERVIDOR DEDICADO (v63)
   Roda as salas do jogo na nuvem: cada sala é uma instância do próprio jogo
   executando como anfitriã dentro do Node (jsdom), então a física, os bots e
   as regras são EXATAMENTE os do jogo. Os jogadores só mandam direção/chute
   e recebem o estado — por isso a internet deles quase não importa.

   Uso:  node servidor.js   (porta 3000, ou PORT=xxxx)
   Deps: npm install  (ws + jsdom)
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { JSDOM } = require('jsdom');

const PORT = +(process.env.PORT || 3000);
const DIR = __dirname;
const NET_PRE = 'streetball-v52-';
const MAX_SALAS = +(process.env.MAX_SALAS || 10);      // quantas salas simultâneas no servidor
const SALA_VAZIA_MS = 5 * 60 * 1000;                   // sala vazia morre depois de 5 min
const MURAL_TTL_MS = 90 * 1000;                        // registro do mural some se o anfitrião parar de avisar

require('./sb-link.js');                               // define globalThis.SB_MAKE_PEER
const makePeerClass = globalThis.SB_MAKE_PEER;

/* ---------- página do jogo com o transporte injetado ---------- */
const LINK_SRC = fs.readFileSync(path.join(DIR, 'sb-link.js'), 'utf8');
let PAGINA = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
PAGINA = PAGINA.replace('<!--SB-LINK-->', '<script>\n' + LINK_SRC + '\n</script>');
if (!PAGINA.includes('SB_MAKE_PEER')) { console.error('FALHA ao injetar sb-link.js na página'); process.exit(1); }

/* ---------- registro de peers (clientes ws + anfitriãs jsdom) ---------- */
const peers = new Map();        // id → {enviar(obj), fecharLocal()}
const links = new Set();        // "a|b" — conexões abertas entre dois peers
const salas = new Map();        // codigo → {dom, janela, peerId, vaziaDesde, nome, modo}
const mural = new Map();        // codigo → {codigo, nome, modo, jogs, senha, dono, ts}

function entrega(de, m) {
  const ep = peers.get(m.to);
  if (!ep) return false;
  const pacote = Object.assign({}, m, { from: de });
  ep.enviar(pacote);
  return true;
}
function fechaLinksDe(id) {
  for (const l of Array.from(links)) {
    const [a, b] = l.split('|');
    if (a !== id && b !== id) continue;
    links.delete(l);
    const outro = a === id ? b : a;
    const ep = peers.get(outro);
    if (ep) ep.enviar({ t: 'c', from: id });
  }
}
function registraPeer(id, enviar) {
  peers.set(id, { enviar });
  return () => { if (peers.get(id) && peers.get(id).enviar === enviar) peers.delete(id); };
}

/* ---------- o MURAL (a lista pública de salas: /api/salas) ---------- */
function muralApi(rota, corpo) {
  if (rota === '/api/salas' && !corpo) {
    const agora = Date.now();
    for (const [k, v] of mural) if (agora - v.ts > MURAL_TTL_MS) mural.delete(k);
    return { salas: Array.from(mural.values()).map(v => ({ codigo: v.codigo, nome: v.nome, modo: v.modo, jogs: v.jogs, senha: v.senha, dono: v.dono })) };
  }
  if (rota === '/api/salas' && corpo && typeof corpo.codigo === 'string') {
    mural.set(corpo.codigo, { codigo: corpo.codigo, nome: String(corpo.nome || 'Sala').slice(0, 30), modo: String(corpo.modo || 'classico'),
      jogs: corpo.jogs | 0, senha: !!corpo.senha, dono: String(corpo.dono || '').slice(0, 12), ts: Date.now() });
    return { ok: true };
  }
  if (rota === '/api/salas/sair' && corpo) { mural.delete(String(corpo.codigo || '')); return { ok: true }; }
  return null;
}

/* ---------- stubs de navegador para o jogo rodar dentro do Node ---------- */
function ctxStub(canvas) {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k === 'measureText') return () => ({ width: 0 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => grad;
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w, height: h });
      return function () {};
    },
    set() { return true; }
  });
}

/* ---------- uma sala = o jogo rodando como anfitrião dentro do jsdom ---------- */
function abreSalaServidor(codigo, salaCfg, pronto, falha) {
  const peerId = NET_PRE + codigo;
  if (peers.has(peerId)) return falha('código em uso');
  if (salas.size >= MAX_SALAS) return falha('O servidor está cheio, tente já já');

  const S = Object.assign({}, salaCfg);
  S.id = 'srv-' + codigo;
  S.eu = -1;                                           // o servidor só apita: nunca entra em campo como jogador
  const seed = JSON.stringify({ v: 2, salas: [S], eu: { nome: 'SERVIDOR', av: 'SV', skin: 'padrao', cor: '', ok: true } });

  let dom;
  try {
    dom = new JSDOM(PAGINA, {
      url: 'http://localhost/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.SB_LOCAL = true;                        // esta página é a anfitriã: sem WebSocket nela
        // canvas sem desenho (só a física importa aqui)
        window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(this); };
        // Peer = transporte direto em memória (o registro do servidor é o "roteador")
        window.Peer = makePeerClass((onMsg, onClose) => ({
          abrir(id) {
            this._id = id;
            this._desreg = registraPeer(id, m => onMsg(m));
            setTimeout(() => onMsg({ t: 'open' }), 0);
          },
          enviar(o) {
            const de = this._id;
            if (o.t === 'd' || o.t === 'c') entrega(de, o);
            else if (o.t === 'conn') { /* a anfitriã não inicia conexões */ }
          },
          fechar() { try { this._desreg && this._desreg(); } catch (_) {} }
        }));
        // o jogo chama fetch('/api/salas') para o mural: atende em processo, sem HTTP
        window.fetch = (url, o) => {
          const rota = String(url);
          const corpo = o && o.body ? JSON.parse(o.body) : null;
          return Promise.resolve().then(() => {
            const r = muralApi(rota, corpo);
            if (r === null) throw new Error('http 404');
            return { ok: true, json: () => Promise.resolve(r) };
          });
        };
        window.navigator.sendBeacon = () => true;
        try {
          window.localStorage.setItem('streetball-salas-v1', seed);
          window.localStorage.setItem('sb-auto', codigo);
          window.localStorage.setItem('sb-sala', S.id);
        } catch (_) {}
      }
    });
  } catch (e) { return falha('erro ao criar a sala: ' + e.message); }

  const janela = dom.window;
  const sala = { dom, janela, peerId, codigo, vaziaDesde: Date.now(), nome: String(S.nome || 'Sala') };
  salas.set(codigo, sala);
  console.log('[sala %s] criada (%s)', codigo, sala.nome);

  janela.addEventListener('error', e => console.log('[sala %s] erro na página: %s', codigo, e.message));
  // a sala está pronta quando a anfitriã (Peer local) abriu
  const t0 = Date.now();
  const espera = setInterval(() => {
    if (peers.has(peerId)) { clearInterval(espera); pronto(codigo); }
    else if (Date.now() - t0 > 15000) { clearInterval(espera); fechaSalaServidor(codigo); falha('a sala não abriu'); }
  }, 100);
}
function fechaSalaServidor(codigo) {
  const s = salas.get(codigo); if (!s) return;
  salas.delete(codigo); mural.delete(codigo);
  try { fechaLinksDe(s.peerId); } catch (_) {}
  try { const ep = peers.get(s.peerId); if (ep) peers.delete(s.peerId); } catch (_) {}
  try { s.janela.close(); } catch (_) {}
  console.log('[sala %s] fechada', codigo);
}
// limpeza: sala sem ninguém por SALA_VAZIA_MS é derrubada (economia = menos cobrança)
setInterval(() => {
  const agora = Date.now();
  for (const [codigo, s] of salas) {
    let ocup = 0;
    for (const l of links) { const [a, b] = l.split('|'); if (a === s.peerId || b === s.peerId) ocup++; }
    if (ocup > 0) { s.vaziaDesde = agora; continue; }
    if (agora - s.vaziaDesde > SALA_VAZIA_MS) fechaSalaServidor(codigo);
  }
}, 30000);

/* ---------- HTTP: o jogo, os arquivos e o mural ---------- */
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.startsWith('/api/')) {
    const responder = r => { res.writeHead(r === null ? 404 : 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(r || { erro: 'não encontrado' })); };
    if (url === '/api/salas/criar' && req.method === 'POST') {
      let corpo = '';
      req.on('data', d => { corpo += d; if (corpo.length > 20000) req.destroy(); });
      req.on('end', () => {
        let j = null; try { j = JSON.parse(corpo); } catch (_) {}
        const cfg = j && j.sala;
        if (!cfg || typeof cfg !== 'object') return responder({ erro: 'configuração inválida' });
        const codigo = geraCodigo();
        abreSalaServidor(codigo, cfg, c => responder({ codigo: c }), erro => responder({ erro }));
      });
      return;
    }
    if (req.method === 'POST') {
      let corpo = ''; req.on('data', d => { corpo += d; if (corpo.length > 20000) req.destroy(); });
      req.on('end', () => { let j = null; try { j = JSON.parse(corpo); } catch (_) {} ; responder(muralApi(url, j)); });
      return;
    }
    return responder(muralApi(url, null));
  }
  if (url === '/ws') { res.writeHead(426); return res.end('websocket'); }
  if (url === '/' || url === '/index.html') {          // o jogo vai com o transporte (sb-link) injetado
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(PAGINA);
  }
  const alvo = path.normalize(path.join(DIR, url));
  if (!alvo.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(alvo, (e, dados) => {
    if (e) { res.writeHead(404); return res.end('não encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(dados);
  });
});
function geraCodigo() {
  const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (; ;) {
    let s = ''; for (let i = 0; i < 4; i++) s += ALFA[Math.floor(Math.random() * ALFA.length)];
    if (!salas.has(s) && !peers.has(NET_PRE + s)) return s;
  }
}

/* ---------- WebSocket: os jogadores ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  let id = null, desreg = null;
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'reg') {
      if (id) return;
      id = String(m.id || '').slice(0, 64);
      if (!id || peers.has(id)) { try { ws.send(JSON.stringify({ t: 'err', type: 'unavailable-id' })); } catch (_) {} ; return; }
      desreg = registraPeer(id, obj => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} });
      try { ws.send(JSON.stringify({ t: 'open' })); } catch (_) {}
      return;
    }
    if (!id) return;
    if (m.t === 'conn') {
      const alvo = String(m.to || '');
      if (!peers.has(alvo)) { try { ws.send(JSON.stringify({ t: 'err', type: 'peer-unavailable' })); } catch (_) {} ; return; }
      links.add([id, alvo].sort().join('|'));
      entrega(id, { t: 'conn', to: alvo });
      try { ws.send(JSON.stringify({ t: 'conn-ok', to: alvo })); } catch (_) {}
      return;
    }
    if (m.t === 'd' || m.t === 'c') { m.to = String(m.to || ''); entrega(id, m); }
  });
  ws.on('close', () => { if (id){ fechaLinksDe(id); desreg && desreg(); } });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

server.listen(PORT, () => console.log('Streetball no ar: http://localhost:' + PORT + '  (salas na nuvem, máx. ' + MAX_SALAS + ')'));
