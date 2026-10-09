/* =====================================================================
   STREETBALL · SERVIDOR DEDICADO (v64)
   Roda as salas do jogo na nuvem: cada sala é uma instância do próprio jogo
   executando como anfitriã dentro do Node (jsdom), então a física, os bots e
   as regras são EXATAMENTE os do jogo. Os jogadores só mandam direção/chute
   e recebem o estado — por isso a internet deles quase não importa.

   v64: salas PÚBLICAS (formação automática) · chat da comunidade (BRASIL/GLOBAL) ·
   ID de membro · sala vazia fecha em 5 s · partida rápida.

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
const MAX_SALAS = +(process.env.MAX_SALAS || 6);       // salas simultâneas (públicas + personalizadas)
const SALA_VAZIA_MS = 5 * 1000;                        // v65: sala sem ninguém fecha em 5 s (e sai da lista)
const MURAL_TTL_MS = 90 * 1000;                        // registro do mural some se o anfitrião parar de avisar

require('./sb-link.js');                               // define globalThis.SB_MAKE_PEER
const makePeerClass = globalThis.SB_MAKE_PEER;

/* ---------- página do jogo com o transporte injetado ---------- */
const LINK_SRC = fs.readFileSync(path.join(DIR, 'sb-link.js'), 'utf8');
let PAGINA = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
if (PAGINA.includes('<!--SB-LINK-->')) PAGINA = PAGINA.replace('<!--SB-LINK-->', '<script>\n' + LINK_SRC + '\n</script>');
else PAGINA = PAGINA.replace('<script>\n(function(){', '<script>\n' + LINK_SRC + '\n</script>\n<script>\n(function(){');
if (!PAGINA.includes('SB_MAKE_PEER')) { console.error('FALHA ao injetar sb-link.js na página'); process.exit(1); }

/* ---------- registro de peers (clientes ws + anfitriãs jsdom) ---------- */
const peers = new Map();        // id → {enviar(obj), fecharLocal()}
const links = new Set();        // "a|b" — conexões abertas entre dois peers
const salas = new Map();        // codigo → {dom, janela, peerId, vaziaDesde, nome, modo, pub}
const mural = new Map();        // codigo → {codigo, nome, modo, jogs, senha, dono, ts}

function entrega(de, m) {
  const ep = peers.get(m.to);
  if (!ep) return false;
  ep.enviar(Object.assign({}, m, { from: de }));
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
function conexoesDe(peerId) {
  let n = 0;
  for (const l of links) { const [a, b] = l.split('|'); if (a === peerId || b === peerId) n++; }
  return n;
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

/* ---------- v64: CHAT DA COMUNIDADE (em memória; some ao reiniciar) ---------- */
const CHATS = { BRASIL: [], GLOBAL: [] };
const chatRate = new Map();                            // ip → último envio
function chatApi(canal, corpo, ip) {
  canal = String(canal || '').toUpperCase();
  if (!CHATS[canal]) return { erro: 'canal desconhecido' };
  if (!corpo) return { msgs: CHATS[canal].slice(-50) };
  const agora = Date.now();
  if (chatRate.get(ip) > agora - 2000) return { ok: false };           // no máx. 1 msg a cada 2 s por IP
  chatRate.set(ip, agora);
  const de = String(corpo.de || 'Jogador').slice(0, 16), texto = String(corpo.texto || '').slice(0, 80).trim();
  if (!texto) return { ok: false };
  CHATS[canal].push({ de, texto, ts: agora });
  if (CHATS[canal].length > 50) CHATS[canal].splice(0, CHATS[canal].length - 50);
  return { ok: true };
}

/* ---------- v64: ID DE MEMBRO (o 1º jogador registrado é o ID 1) ---------- */
const PERFIL_ARQ = path.join(DIR, 'perfis.json');
let perfis = {};
try { perfis = JSON.parse(fs.readFileSync(PERFIL_ARQ, 'utf8')); } catch (_) {}
let proxId = Object.values(perfis).reduce((m, p) => Math.max(m, (p && p.id) | 0), 0) + 1;
let perfisT = 0;
function perfisSalvar() {
  clearTimeout(perfisT);
  perfisT = setTimeout(() => { try { fs.writeFileSync(PERFIL_ARQ, JSON.stringify(perfis)); } catch (_) {} }, 2000);
}
function perfilApi(corpo) {
  const uid = String(corpo && corpo.uid || '').slice(0, 64);
  if (!uid) return { erro: 'sem uid' };
  const nome = String(corpo.nome || 'Jogador').slice(0, 8) || 'Jogador';
  if (!perfis[uid]) { perfis[uid] = { id: proxId++, nome }; console.log('[perfil] ID %d → %s', perfis[uid].id, nome); }
  else perfis[uid].nome = nome;
  perfisSalvar();
  return { id: perfis[uid].id };
}

/* ---------- v64: SALAS PÚBLICAS (formação automática) ---------- */
const PUB_CFG = {
  classico: { titulo: 'Arena Clássica', modo: 'classico', estadio: 'classico', quadra: 'volei' },
  real:     { titulo: 'Real Soccer',    modo: 'classico', estadio: 'real',     quadra: 'volei' },
  volei:    { titulo: 'Arena Vôlei',    modo: 'volei',    estadio: 'classico', quadra: 'volei' }
};
const PUB_LANES = [];
for (const modo of ['classico', 'real', 'volei']) for (let i = 1; i <= 5; i++) PUB_LANES.push(modo + '-' + i);
const pubVivas = new Map();                            // lane → codigo
const pubValida = id => PUB_LANES.includes(String(id || ''));

function pubConfig(lane) {
  const [modo, i] = lane.split('-');
  const c = PUB_CFG[modo];
  return { nome: c.titulo + ' 0' + i, modo: c.modo, estadio: c.estadio, quadra: c.quadra, eu: -1, bots: [0, 0], nivel: [1, 1],
    tempo: 3, gols: 3, prorrog: true, vel: 100, fis: {}, fisV: {}, v3: true, v2: true, vBloq: false, senha: '',
    format: 4, custom: true, pub: true,
    cores: [{ a: 0, t: '#ffffff', c: ['#ff4a19'] }, { a: 0, t: '#ffffff', c: ['#00bae5'] }] };
}
function pubLinha(lane) {
  const codigo = pubVivas.get(lane), viva = codigo && salas.has(codigo);
  const jogs = viva ? conexoesDe(salas.get(codigo).peerId) : 0;
  return { id: lane, players: jogs, capacity: 8, bench: Math.max(0, jogs - 8), playing: jogs >= 2, full: jogs >= 11, code: viva ? codigo : null };
}
function pubEntrar(lane, pronto) {
  if (!pubValida(lane)) return pronto({ erro: 'sala desconhecida' });
  const codigo = pubVivas.get(lane);
  if (codigo && salas.has(codigo)) return pronto({ code: codigo });
  const novo = geraCodigo();
  abreSalaServidor(novo, pubConfig(lane), c => { pubVivas.set(lane, c); pronto({ code: c }); }, erro => pronto({ erro }));
}
function pubRapido(modo, pronto) {
  const lanes = PUB_LANES.filter(l => l.startsWith(modo === 'real' || modo === 'volei' ? modo : 'classico'));
  if (!lanes.length) return pronto({ erro: 'modo desconhecido' });
  const linhas = lanes.map(pubLinha);
  const viva = linhas.filter(l => l.players > 0 && !l.full).sort((a, b) => b.players - a.players)[0];
  pubEntrar(viva ? viva.id : lanes[0], pronto);
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
      url: 'http://localhost/?debug',
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
          },
          fechar() { try { this._desreg && this._desreg(); } catch (_) {} }
        }));
        // o jogo chama fetch('/api/salas') para o mural: atende em processo, sem HTTP
        window.fetch = (url, o) => {
          const rota = String(url).split('?')[0];
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
          if (S.pub) window.localStorage.setItem('sb-auto-teams', '1');   // v64: sala pública = formação automática
        } catch (_) {}
      }
    });
  } catch (e) { return falha('erro ao criar a sala: ' + e.message); }

  const janela = dom.window;
  const sala = { dom, janela, peerId, codigo, vaziaDesde: Date.now(), nome: String(S.nome || 'Sala'), pub: !!S.pub };
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
  for (const [lane, c] of pubVivas) if (c === codigo) pubVivas.delete(lane);
  try { fechaLinksDe(s.peerId); } catch (_) {}
  try { peers.delete(s.peerId); } catch (_) {}
  try { s.janela.close(); } catch (_) {}
  console.log('[sala %s] fechada', codigo);
}
// limpeza: sala sem ninguém por SALA_VAZIA_MS é derrubada (economia e lista limpa)
setInterval(() => {
  const agora = Date.now();
  for (const [codigo, s] of salas) {
    if (conexoesDe(s.peerId) > 0) { s.vaziaDesde = agora; continue; }
    if (agora - s.vaziaDesde > SALA_VAZIA_MS) fechaSalaServidor(codigo);
  }
}, 5000);

/* ---------- HTTP: o jogo, os arquivos e as APIs ---------- */
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const url = decodeURIComponent(u.pathname);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0];
  const responder = (r, status) => { res.writeHead(status || (r === null ? 404 : 200), { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(r || { erro: 'não encontrado' })); };
  const lerCorpo = fn => {
    let corpo = '';
    req.on('data', d => { corpo += d; if (corpo.length > 20000) req.destroy(); });
    req.on('end', () => { let j = null; try { j = JSON.parse(corpo); } catch (_) {} ; fn(j); });
  };

  if (url === '/api/salas' || url === '/api/salas/sair') {
    if (req.method === 'POST') return lerCorpo(j => responder(muralApi(url, j)));
    return responder(muralApi(url, null));
  }
  if (url === '/api/salas/criar' && req.method === 'POST') {
    return lerCorpo(j => {
      const cfg = j && j.sala;
      if (!cfg || typeof cfg !== 'object') return responder({ erro: 'configuração inválida' });
      abreSalaServidor(geraCodigo(), cfg, c => responder({ codigo: c }), erro => responder({ erro }));
    });
  }
  if (url === '/api/chat') {
    if (req.method === 'POST') return lerCorpo(j => responder(chatApi(u.searchParams.get('canal') || (j && j.canal), j, ip)));
    return responder(chatApi(u.searchParams.get('canal'), null, ip));
  }
  if (url === '/api/perfil' && req.method === 'POST') return lerCorpo(j => responder(perfilApi(j)));
  if (url === '/api/publicas') return responder({ salas: PUB_LANES.map(pubLinha) });
  if (url === '/api/publicas/entrar' && req.method === 'POST') return lerCorpo(j => pubEntrar(j && j.id, responder));
  if (url === '/api/publicas/rapido' && req.method === 'POST') return lerCorpo(j => pubRapido(j && j.modo, responder));

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
