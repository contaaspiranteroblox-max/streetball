'use strict';
// =====================================================================================
//  GINGA — servidor das salas (Node.js 16 ou mais novo, sem nenhuma dependência)
//
//  Como usar:   node ginga-servidor.js
//  Abre na porta 8080 (mude com PORTA=3000 node ginga-servidor.js).
//  - http://SEU-IP:8080/        → o jogo (o arquivo ginga.html tem que estar na mesma pasta)
//  - ws://SEU-IP:8080/ginga     → as salas (o jogo conecta sozinho quando é aberto por aqui)
//  - http://SEU-IP:8080/saude   → status em JSON
//  As contas (nome de usuário + senha, com ID começando no #1) ficam na pasta "dados"
//  ao lado do servidor (mude com DADOS=/caminho). Faça backup dessa pasta.
//
//  O servidor é quem manda na partida: ele roda a mesma física e os mesmos bots do jogo
//  (60 passos por segundo) e manda uma "foto" de tudo 30 vezes por segundo.
//  O protocolo completo está no PROTOCOLO.md.
// =====================================================================================
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');

// ---- 00-base.js (o mesmo código do jogo) ----
// ======================================================================= BASE (vale para o jogo e para o servidor)
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const TAU = Math.PI * 2;
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const easeOutElastic = t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * (TAU / 3)) + 1;
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function angDiff(a, b){ let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
const COR_RE = /^#[0-9a-f]{6}$/i;
function hexRgb(h){ const n = parseInt(COR_RE.test(h) ? h.slice(1) : '888888', 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbHex(c){ return '#' + c.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
function rgba(h, a){ const c = hexRgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
function mix(h1, h2, t){ const a = hexRgb(h1), b = hexRgb(h2); return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`; }
function corMix(h1, h2, t){ const a = hexRgb(h1), b = hexRgb(h2); return rgbHex(a.map((v, i) => lerp(v, b[i], t))); }
function fmt(n){ return Math.round(n).toLocaleString('pt-BR'); }
// limpa textos que vêm de fora (nomes, salas, chat)
function limpaTexto(s, max){ return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
const CORES_TIME = ['#e8473c', '#2f6fe6'];
const NOMES_TIME = ['VERMELHO', 'AZUL'];
const NOMES_BOT = ['Dudu', 'Tico', 'Bia', 'Nando', 'Lelê', 'Rafa', 'Mel', 'Caju', 'Biel', 'Tati', 'Zeca', 'Gui', 'Duda', 'Léo', 'Nina', 'Pipoca', 'Foguete', 'Sabiá', 'Juju', 'Bento', 'Kiki', 'Teteu', 'Lua', 'Chico'];

// ---- 20-skins.js (o mesmo código do jogo) ----
// ======================================================================= SKINS — o botão chapado (contorno preto e o número no meio)
// 20 desenhos, todos de graça. No meio do botão: até 2 números ou letras. A cor pode ser a do TIME ou uma da paleta.
const SK_PRETO = '#171717';
const PALETA = ['#ff4b1f', '#e8735a', '#c8102e', '#ff8c1a', '#ffd60a', '#e6a800', '#2ecc40', '#0b6e3a', '#8fd3f4', '#00b4d8', '#4a90e2', '#1f5fd6', '#1b2a4a', '#7b2ff7', '#b14dff', '#ff4fa3', '#ffffff', '#9aa0a6', '#222222', '#8b5a2b'];
const skFundo = (g, r, c) => { g.fillStyle = c; g.fillRect(-r - 1, -r - 1, 2 * r + 2, 2 * r + 2); };
function skPoli(g, pts){ g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); }
function estrela(g, x, y, r1, r2, n = 5, rot = -Math.PI / 2){ g.beginPath(); for (let i = 0; i < n * 2; i++){ const a = rot + i * Math.PI / n, rr = i % 2 ? r2 : r1; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); }
// cada desenho pinta o disco inteiro (o canvas já está no meio dele e recortado no círculo de raio r)
// k = { cor, esc (mais escura), cla (mais clara) }
const DESENHOS = {
  padrao(g, r, k){ skFundo(g, r, k.cor); },
  listras(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = '#ffffff'; const w = 2 * r / 5; for (let i = 1; i < 5; i += 2) g.fillRect(-r + i * w, -r - 1, w, 2 * r + 2); },
  faixa(g, r, k){ skFundo(g, r, k.cor); g.save(); g.rotate(Math.PI / 4); g.fillStyle = '#ffffff'; g.fillRect(-2 * r, -r * .25, 4 * r, r * .5); g.restore(); },
  metade(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = k.esc; g.fillRect(0, -r - 1, r + 1, 2 * r + 2); },
  barra(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = '#ffffff'; g.fillRect(-r - 1, -r * .27, 2 * r + 2, r * .54); },
  tricolor(g, r, k){ const w = 2 * r / 3; skFundo(g, r, k.esc); g.fillStyle = k.cor; g.fillRect(-r - 1, -r - 1, w + 1, 2 * r + 2); g.fillStyle = '#ffffff'; g.fillRect(-r + w, -r - 1, w, 2 * r + 2); },
  cruz(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = '#ffffff'; g.fillRect(-r * .5, -r - 1, r * .3, 2 * r + 2); g.fillRect(-r - 1, -r * .15, 2 * r + 2, r * .3); },
  losango(g, r, k){ skFundo(g, r, k.cor); skPoli(g, [[0, -r * .8], [r * .92, 0], [0, r * .8], [-r * .92, 0]]); g.fillStyle = k.cla; g.fill(); },
  xadrez(g, r, k){ const n = 4, s = 2 * r / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++){ g.fillStyle = (i + j) % 2 ? k.esc : k.cor; g.fillRect(-r + i * s - .5, -r + j * s - .5, s + 1, s + 1); } },
  bolinhas(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = k.cla; const s = r * .5; for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++){ const x = (i + (j % 2 ? .5 : 0)) * s, y = j * s * .87; g.beginPath(); g.arc(x, y, r * .12, 0, TAU); g.fill(); } },
  alvo(g, r, k){ skFundo(g, r, k.cor); for (const [q, c] of [[.78, '#ffffff'], [.56, k.cor]]){ g.beginPath(); g.arc(0, 0, r * q, 0, TAU); g.fillStyle = c; g.fill(); } },
  anel(g, r, k){ skFundo(g, r, k.cor); g.beginPath(); g.arc(0, 0, r * .64, 0, TAU); g.fillStyle = '#ffffff'; g.fill(); },
  estrela(g, r, k){ skFundo(g, r, k.cor); estrela(g, 0, 0, r * .98, r * .44); g.fillStyle = k.cla; g.fill(); },
  raio(g, r, k){ skFundo(g, r, k.cor); skPoli(g, [[r * .22, -r * 1.05], [-r * .5, r * .12], [-r * .04, r * .12], [-r * .28, r * 1.05], [r * .52, -r * .18], [r * .06, -r * .18]]); g.fillStyle = '#ffd23f'; g.fill(); g.lineJoin = 'round'; g.lineWidth = r * .07; g.strokeStyle = SK_PRETO; g.stroke(); },
  sol(g, r, k){ skFundo(g, r, k.cor); g.fillStyle = k.cla; const n = 12; for (let i = 0; i < n; i += 2){ const a = i * TAU / n; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 2 * r, a, a + TAU / n); g.closePath(); g.fill(); } },
  ondas(g, r, k){ skFundo(g, r, k.cor); g.lineWidth = r * .2; g.lineCap = 'butt'; [[-.55, '#ffffff'], [0, k.cla], [.55, '#ffffff']].forEach(([y0, c]) => { g.beginPath(); for (let i = 0; i <= 24; i++){ const x = -r - 2 + i * (2 * r + 4) / 24, y = (y0 + Math.sin(i / 24 * TAU * 1.5) * .11) * r; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.strokeStyle = c; g.stroke(); }); },
  yinyang(g, r, k){ skFundo(g, r, k.cor); g.beginPath(); g.arc(0, 0, r + 1, -Math.PI / 2, Math.PI / 2); g.arc(0, r / 2, r / 2, Math.PI / 2, -Math.PI / 2, true); g.arc(0, -r / 2, r / 2, Math.PI / 2, -Math.PI / 2); g.closePath(); g.fillStyle = k.esc; g.fill(); g.beginPath(); g.arc(0, -r / 2, r * .13, 0, TAU); g.fillStyle = k.cor; g.fill(); g.beginPath(); g.arc(0, r / 2, r * .13, 0, TAU); g.fillStyle = k.esc; g.fill(); },
  neon(g, r, k){ skFundo(g, r, '#12121c'); g.beginPath(); g.arc(0, 0, r * .8, 0, TAU); g.lineWidth = r * .17; g.strokeStyle = k.cor; g.stroke(); },
  pixel(g, r, k){ const n = 6, s = 2 * r / n, cs = [k.cor, k.esc, k.cla, k.cor]; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++){ const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; g.fillStyle = cs[Math.floor((h - Math.floor(h)) * cs.length)]; g.fillRect(-r + i * s - .5, -r + j * s - .5, s + 1, s + 1); } },
  bola(g, r, k){
    skFundo(g, r, '#ffffff');
    const pent = (x, y, R, a0) => { g.beginPath(); for (let i = 0; i < 5; i++){ const a = a0 + i * TAU / 5; i ? g.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R) : g.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R); } g.closePath(); g.fill(); };
    g.fillStyle = k.cor; pent(0, 0, r * .36, -Math.PI / 2);
    for (let i = 0; i < 5; i++){ const a = -Math.PI / 2 + Math.PI / 5 + i * TAU / 5; pent(Math.cos(a) * r * .98, Math.sin(a) * r * .98, r * .3, a + Math.PI); }
    g.strokeStyle = 'rgba(23,23,23,.55)'; g.lineWidth = r * .04;
    for (let i = 0; i < 5; i++){ const a = -Math.PI / 2 + i * TAU / 5; g.beginPath(); g.moveTo(Math.cos(a) * r * .36, Math.sin(a) * r * .36); g.lineTo(Math.cos(a) * r * .62, Math.sin(a) * r * .62); g.stroke(); }
  }
};
// tx = a cor do número: 'uni' (branco liso, como no HaxBall) · 'branco' (branco com contorno escuro) · 'cor' (a cor do botão)
const SKINS = [
  { id: 'padrao', nome: 'Padrão', tx: 'uni' }, { id: 'listras', nome: 'Listras', tx: 'branco' }, { id: 'faixa', nome: 'Faixa', tx: 'branco' },
  { id: 'metade', nome: 'Metade', tx: 'branco' }, { id: 'barra', nome: 'Barra', tx: 'branco' }, { id: 'tricolor', nome: 'Tricolor', tx: 'branco' },
  { id: 'cruz', nome: 'Cruz', tx: 'branco' }, { id: 'losango', nome: 'Losango', tx: 'branco' }, { id: 'xadrez', nome: 'Xadrez', tx: 'branco' },
  { id: 'bolinhas', nome: 'Bolinhas', tx: 'branco' }, { id: 'alvo', nome: 'Alvo', tx: 'branco' }, { id: 'anel', nome: 'Anel', tx: 'cor' },
  { id: 'estrela', nome: 'Estrela', tx: 'branco' }, { id: 'raio', nome: 'Raio', tx: 'branco' }, { id: 'sol', nome: 'Sol', tx: 'branco' },
  { id: 'ondas', nome: 'Ondas', tx: 'branco' }, { id: 'yinyang', nome: 'Yin-yang', tx: 'branco' }, { id: 'neon', nome: 'Neon', tx: 'cor' },
  { id: 'pixel', nome: 'Pixel', tx: 'branco' }, { id: 'bola', nome: 'Bola', tx: 'branco' }
];
const SKIN = Object.fromEntries(SKINS.map(s => [s.id, s]));
const skinDe = id => SKIN[id] || SKIN.padrao;
const textoBotao = s => Array.from(String(s || '').toUpperCase().replace(/[^0-9A-ZÀ-Ü]/g, '')).slice(0, 2).join('');
// a cor que o botão veste: a do time (ou a do time vermelho, fora de jogo) ou a escolhida
const corDoVisual = (v, corTime) => v && v.cor && v.cor !== 'time' && COR_RE.test(v.cor) ? v.cor : (corTime || CORES_TIME[0]);

// o botão inteiro. v = { desenho, texto, cor (já resolvida) } · o = { anel: cor do time em volta, brilho: verniz do lobby }
function desenhaBotao(g, x, y, r, v, o = {}){
  const sk = skinDe(v.desenho), cor = COR_RE.test(v.cor) ? v.cor : CORES_TIME[0];
  const k = { cor, esc: corMix(cor, '#000000', .42), cla: corMix(cor, '#ffffff', .5) };
  if (o.anel){ g.beginPath(); g.arc(x, y, r * 1.2, 0, TAU); g.fillStyle = o.anel; g.fill(); g.lineWidth = r * .07; g.strokeStyle = SK_PRETO; g.stroke(); }
  g.save(); g.translate(x, y); g.beginPath(); g.arc(0, 0, r, 0, TAU); g.clip();
  (DESENHOS[sk.id] || DESENHOS.padrao)(g, r, k);
  if (o.brilho){
    const gr = g.createRadialGradient(-r * .38, -r * .45, r * .05, 0, 0, r * 1.05);
    gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(.35, 'rgba(255,255,255,.08)'); gr.addColorStop(.75, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.32)');
    g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r);
  }
  g.restore();
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.lineWidth = r * (o.contorno || 2 / 15); g.strokeStyle = SK_PRETO; g.stroke();
  const texto = v.texto;
  if (!texto) return;
  const n = Array.from(texto).length, sz = r * (n > 1 ? 11 : 14) / 15;
  g.font = 'bold ' + sz.toFixed(2) + 'px Arial, "Helvetica Neue", Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const ty = y + r * .7 / 15;
  if (sk.tx === 'branco' || (sk.tx === 'uni' && corMuitoClara(cor))){ g.lineWidth = sz * .2; g.strokeStyle = 'rgba(23,23,23,.9)'; g.strokeText(texto, x, ty); }
  g.fillStyle = sk.tx === 'cor' ? (corMuitoClara(cor) && sk.id !== 'neon' ? SK_PRETO : cor) : '#ffffff';
  g.fillText(texto, x, ty);
}
function corMuitoClara(h){ const [r, gg, b] = hexRgb(h); return r * .299 + gg * .587 + b * .114 > 200; }
function pintaBotao(c, px, v, o = {}){         // desenha num canvas de px × px (resolução da tela)
  const d = Math.min(window.devicePixelRatio || 1, 3), n = Math.max(8, Math.round(px * d));
  if (c.width !== n || c.height !== n){ c.width = c.height = n; }
  const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, n, n);
  desenhaBotao(g, n / 2, n / 2, n / 2 * (o.anel ? .76 : .9), v, o);
  return c;
}
// o visual do jogador (salvo), já com a cor resolvida
function meuVisual(corTime){ const v = S.visual || {}; return { desenho: skinDe(v.desenho).id, texto: textoBotao(v.texto), cor: corDoVisual(v, corTime) }; }
// sprites da partida: um canvas por visual+tamanho
const cacheDisco = new Map();
function spriteBotao(v, anel, rpx){
  const k = v.desenho + '|' + v.cor + '|' + v.texto + '|' + (anel || '') + '|' + Math.round(rpx * 2);
  let c = cacheDisco.get(k);
  if (!c){
    if (cacheDisco.size > 120) cacheDisco.clear();
    const fator = anel ? 1.2 : 1, tam = Math.ceil(rpx * 2 * fator + 6);
    c = document.createElement('canvas'); c.width = c.height = tam;
    desenhaBotao(c.getContext('2d'), tam / 2, tam / 2, rpx, v, { anel });
    cacheDisco.set(k, c);
  }
  return c;
}

// ---- 30-sim.js (o mesmo código do jogo) ----
// ======================================================================= FÍSICA do GINGA (botões, bola, paredes e traves)
const FIS = {
  tick: 60, pr: 26, pInv: .65, acc: 23.454548, rev: 2, damp: .88, idle: .72, mom: .92, cruise: 226, vmax: 252,
  reachMul: 1.4, reachPad: 6, kick: 570, kickCd: .15, grace: .2, passMul: .6, recuo: .16,
  // bola mais leve (GINGA 3): pesa menos que o jogador, rola mais e sai mais longe no toque
  br: 11, bInv: 1.85, bDamp: .983, bounce: .5, pbMin: .05, pbMax: .3, pbScale: .06, wallB: .85, postB: .95, postR: 8, oob: 3,
  // GINGA: segurar o CHUTE antes de chegar na bola carrega o chute forte (mais rápido e sem frear tanto)
  cargaIni: .08, cargaDur: .4, cargaLento: .92, forteMul: 1.28, forteCd: 2.2, forteMin: .6,
  duploJan: .14, duploMul: .5
};
const ARENAS = {
  1: { W: 1000, H: 680, GW: 170, GD: 55, CC: 60, PAW: 220, PAH: 330 },
  2: { W: 1240, H: 840, GW: 200, GD: 60, CC: 70, PAW: 270, PAH: 420 },
  3: { W: 1480, H: 1000, GW: 230, GD: 64, CC: 80, PAW: 320, PAH: 500 }
};
const FORMACOES = [
  [[.5, 0]],
  [[.42, -.2], [.42, .2]],
  [[.3, 0], [.62, -.24], [.62, .24]],
  [[.26, 0], [.5, -.28], [.5, .28], [.74, 0]]
];
const SOMA_BOLA = 1 / (FIS.tick * (1 - FIS.bDamp));   // quanto a bola anda por unidade de velocidade até parar
// JOGABILIDADE: LEVE (o botão responde na hora e quase não desliza) · CLÁSSICA (com inércia: o botão desliza mais)
const MOVIMENTO = {
  leve:     { acc: 64, rev: 4.2, damp: .68, idle: .35, mom: .72 },
  classica: { acc: FIS.acc, rev: FIS.rev, damp: FIS.damp, idle: FIS.idle, mom: FIS.mom }
};

class Jog {
  constructor(id, time, nome, visual, humano){
    this.id = id; this.time = time; this.nome = nome; this.visual = visual || null; this.humano = !!humano;
    this.num = 0; this.dono = null;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.r = FIS.pr; this.inv = FIS.pInv; this.bola = false;
    this.px = 0; this.py = 0;
    this.mx = 0; this.my = 0;
    this.kD = false; this.pD = false; this.kN = 0; this.pN = 0; this._kN = 0; this._pN = 0;
    this.kL = { arm: true, tm: 0 }; this.pL = { arm: true, tm: 0 };
    this.kickCd = 0; this.segura = 0; this.carga = 0; this.forteCd = 0; this.duploT = 0;
    this.ultChuteT = -9; this.ultBotao = ''; this.chutando = false; this.passando = false;
    this.mira = true; this.travado = false;
    this.st = { gols: 0, assist: 0, chutes: 0, toques: 0, passes: 0, fortes: 0, contra: 0 };
    this.bot = null; this.papel = '';
  }
}
function trava(L, down, borda, dt){
  L.tm = Math.max(0, L.tm - dt);
  if (borda) L.tm = FIS.grace;
  if (!down) L.arm = true;
  return (down && L.arm) || L.tm > 0;
}
function consome(L){ L.arm = false; L.tm = 0; }

class Partida {
  constructor(o){
    this.o = o;
    const an = o.arena || clamp(o.n, 1, 3), A = ARENAS[an];
    Object.assign(this, { W: A.W, H: A.H, GW: A.GW, GD: A.GD, CC: A.CC, PAW: A.PAW, PAH: A.PAH, arenaN: an });
    this.M = MOVIMENTO[o.jogab] || MOVIMENTO.leve;
    this.jog = [];
    this.bola = { x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0, r: FIS.br, inv: FIS.bInv, bola: true, z: 0, vz: 0, pz: 0 };
    this.placar = [0, 0];
    this.t = 0; this.tick = 0;
    this.ev = [];
    this.toques = [];
    this.golLigado = true;
    this.montaArena();
    this.grav = []; this.gravMax = 420;
  }
  montaArena(){
    const W2 = this.W / 2, H2 = this.H / 2, G2 = this.GW / 2, D = this.GD;
    const seg = (ax, ay, bx, by, nx, ny, borda) => ({ ax, ay, bx, by, nx, ny, borda, dx: bx - ax, dy: by - ay, L2: (bx - ax) ** 2 + (by - ay) ** 2 });
    this.segs = [
      seg(-W2, -H2, W2, -H2, 0, 1, true), seg(-W2, H2, W2, H2, 0, -1, true),
      seg(-W2, -H2, -W2, -G2, 1, 0, true), seg(-W2, G2, -W2, H2, 1, 0, true),
      seg(W2, -H2, W2, -G2, -1, 0, true), seg(W2, G2, W2, H2, -1, 0, true),
      seg(-W2 - D, -G2, -W2 - D, G2, 0, 0, false), seg(-W2 - D, -G2, -W2, -G2, 0, 0, false), seg(-W2 - D, G2, -W2, G2, 0, 0, false),
      seg(W2 + D, -G2, W2 + D, G2, 0, 0, false), seg(W2, -G2, W2 + D, -G2, 0, 0, false), seg(W2, G2, W2 + D, G2, 0, 0, false)
    ];
    this.traves = [[-W2, -G2], [-W2, G2], [W2, -G2], [W2, G2]];
  }
  add(j){ this.jog.push(j); return j; }
  naBoca(x, y){ return Math.abs(y) <= this.GW / 2 + 5 && (x < -this.W / 2 + 10 || x > this.W / 2 - 10); }

  // posições do pontapé inicial (formação de cada modo)
  saida(){
    for (const time of [0, 1]){
      const m = this.jog.filter(j => j.time === time);
      const F = FORMACOES[Math.min(m.length, 4) - 1] || FORMACOES[0];
      m.forEach((j, i) => {
        let fx, fy;
        if (i < F.length){ [fx, fy] = F[i]; } else { fx = .3 + (i % 3) * .2; fy = ((i % 2) ? -1 : 1) * .25; }
        j.x = time === 0 ? -this.W / 2 + this.W / 2 * fx : this.W / 2 - this.W / 2 * fx;
        j.y = this.H * fy;
        j.vx = j.vy = 0; j.mx = j.my = 0; j.carga = 0; j.segura = 0; j.kickCd = 0; j.duploT = 0;
        j.px = j.x; j.py = j.y;
      });
    }
    const b = this.bola; b.x = b.y = b.vx = b.vy = 0; b.z = b.vz = 0; b.px = b.py = 0;
  }

  // ------------------------------------------------ habilidades e movimento
  habilidades(j, dt){
    j.kickCd = Math.max(0, j.kickCd - dt); j.forteCd = Math.max(0, j.forteCd - dt); j.duploT = Math.max(0, j.duploT - dt);
    const kB = j.kN !== j._kN, pB = j.pN !== j._pN; j._kN = j.kN; j._pN = j.pN;
    const kOn = trava(j.kL, j.kD || kB, kB, dt), pOn = trava(j.pL, j.pD || pB, pB, dt);
    if (j.kD && j.kL.arm && j.forteCd <= 0){ j.segura += dt; j.carga = clamp((j.segura - FIS.cargaIni) / FIS.cargaDur, 0, 1); }
    else { j.segura = 0; j.carga = 0; }
    if ((kB || pB) && this.t - j.ultChuteT < FIS.duploJan && j.ultBotao !== (kB ? 'k' : 'p')) j.duploT = .1;
    j.chutando = kOn; j.passando = pOn && !kOn;
  }
  movimento(j, dt, k){
    if (j.travado){ j.vx *= .5; j.vy *= .5; return; }
    let mx = j.mx, my = j.my; const m2 = mx * mx + my * my;
    if (m2 > 1e-4){
      const m = Math.sqrt(m2); const mag = Math.min(1, m); mx /= m; my /= m;
      const M = this.M;
      let a = M.acc * k * mag; if (j.carga > 0) a *= FIS.cargaLento;
      j.vx += mx * a * (j.vx * mx >= 0 ? 1 : M.rev);
      j.vy += my * a * (j.vy * my >= 0 ? 1 : M.rev);
    }
    const v = Math.hypot(j.vx, j.vy), vmax = FIS.vmax * (j.carga > 0 ? .92 : 1);
    if (v > vmax){ j.vx *= vmax / v; j.vy *= vmax / v; }
  }
  alcance(j){ return j.r * FIS.reachMul + this.bola.r + FIS.reachPad; }
  tentaChute(j){
    const b = this.bola;
    const dx = b.x - j.x, dy = b.y - j.y, d = Math.hypot(dx, dy);
    if (j.duploT > 0){
      const vb = Math.hypot(b.vx, b.vy);
      if (d < this.alcance(j) * 2 && d > 0 && vb > 100){
        const nx = dx / d, ny = dy / d, f = FIS.kick * FIS.duploMul;
        b.vx += nx * f; b.vy += ny * f; b.vz = Math.max(b.vz, 120);
        j._ultK = 'duplo'; j.duploT = 0; consome(j.kL); consome(j.pL); j.forteCd = FIS.forteCd; j.kickCd = FIS.kickCd;
        this.ev.push({ tipo: 'chute', k: 'duplo', j, f: FIS.kick * 1.5, x: b.x, y: b.y, nx, ny });
        return;
      }
    }
    if (!(j.chutando || j.passando) || j.kickCd > 0 || j.travado) return;
    if (d > this.alcance(j) || d <= 0) return;
    let nx = dx / d, ny = dy / d, f, k, fixa = false;
    if (j.chutando){
      const c = j.carga; f = FIS.kick * (1 + (FIS.forteMul - 1) * c); k = c >= FIS.forteMin ? 'forte' : 'chute';
      if (k === 'forte'){ j.forteCd = FIS.forteCd; j.st.fortes++; b.vz = 150 + 60 * c; }
      j.st.chutes++;
    } else {
      k = 'passe'; f = FIS.kick * FIS.passMul;
      if (j.mira){ const m = this.miraPasse(j, nx, ny); if (m){ nx = m.nx; ny = m.ny; f = m.v; fixa = true; } }
      j.st.passes++;
    }
    if (fixa){ b.vx = nx * f; b.vy = ny * f; } else { b.vx += nx * f; b.vy += ny * f; }
    if (k !== 'passe'){ j.vx -= nx * f * FIS.recuo; j.vy -= ny * f * FIS.recuo; }   // mamoball: o chute empurra o jogador um pouco para trás
    j.kickCd = FIS.kickCd; consome(j.kL); consome(j.pL); j.segura = 0; const carga = j.carga; j.carga = 0;
    j.ultChuteT = this.t; j.ultBotao = k === 'passe' ? 'p' : 'k'; j._ultK = k;
    this.tocou(j);
    this.ev.push({ tipo: 'chute', k, j, f, x: b.x, y: b.y, nx, ny, carga });
  }
  // passe que procura o companheiro (só dentro de um cone de 34° para onde a bola já iria)
  miraPasse(j, nx, ny){
    const b = this.bola; let melhor = null, ms = 1e9; const cosMax = Math.cos(34 * Math.PI / 180);
    for (const m of this.jog){
      if (m === j || m.time !== j.time) continue;
      const px = m.x + m.vx * .32, py = m.y + m.vy * .32;
      const tx = px - b.x, ty = py - b.y, dist = Math.hypot(tx, ty);
      if (dist < 70 || dist > 950) continue;
      const cos = (tx * nx + ty * ny) / dist; if (cos < cosMax) continue;
      // nunca recua a bola na direção do próprio gol
      const ux = tx / dist, uy = ty / dist, meuGolX = j.time === 0 ? -this.W / 2 : this.W / 2;
      if (ux * (meuGolX - b.x) > 0){ const tt = (meuGolX - b.x) / ux, yy = b.y + uy * tt; if (Math.abs(yy) < this.GW / 2 + 70) continue; }
      const s = Math.acos(clamp(cos, -1, 1)) * 2.2 + dist / 700;
      if (s < ms){ ms = s; melhor = { nx: tx / dist, ny: ty / dist, dist }; }
    }
    if (!melhor) return null;
    melhor.v = clamp(melhor.dist / SOMA_BOLA * 1.15 + 35, 170, FIS.kick * .95);
    return melhor;
  }
  tocou(j){
    const ult = this.toques[this.toques.length - 1];
    if (!ult || ult.j !== j || this.t - ult.t > .5){ this.toques.push({ j, t: this.t }); if (this.toques.length > 12) this.toques.shift(); j.st.toques++; }
    else ult.t = this.t;
  }

  // ------------------------------------------------ colisões
  empurra(b, nx, ny, pen, q){
    b.x += nx * pen; b.y += ny * pen;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0){ b.vx -= (1 + q) * vn * nx; b.vy -= (1 + q) * vn * ny; return -vn; }
    return 0;
  }
  arena(b){
    for (const s of this.segs){
      let t = ((b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy) / s.L2;
      if (s.borda && t >= 0 && t <= 1){
        const d = (b.x - s.ax) * s.nx + (b.y - s.ay) * s.ny;
        if (!b.bola){ const lim = -b.r * FIS.oob; if (d < lim) this.empurra(b, s.nx, s.ny, lim - d, 0); }
        else if (!this.naBoca(b.x, b.y) && d < b.r){ const imp = this.empurra(b, s.nx, s.ny, b.r - d, FIS.wallB); if (imp > 60) this.ev.push({ tipo: 'parede', imp, x: b.x, y: b.y }); }
        continue;
      }
      t = clamp(t, 0, 1);
      const cx = s.ax + s.dx * t, cy = s.ay + s.dy * t, ex = b.x - cx, ey = b.y - cy, dist = Math.hypot(ex, ey);
      if (dist < b.r && dist > 0){
        const imp = this.empurra(b, ex / dist, ey / dist, b.r - dist, FIS.bounce);
        if (b.bola && !s.borda && imp > 40) this.ev.push({ tipo: 'rede', imp, x: b.x, y: b.y });
      }
    }
    for (const [px, py] of this.traves){
      const ex = b.x - px, ey = b.y - py, dist = Math.hypot(ex, ey), R = b.r + FIS.postR;
      if (dist < R && dist > 0){
        const imp = this.empurra(b, ex / dist, ey / dist, R - dist, b.bola ? FIS.postB : FIS.bounce);
        if (b.bola && imp > 30) this.ev.push({ tipo: 'trave', imp, x: px, y: py });
      }
    }
    if (!b.bola){
      const lx = Math.abs(b.y) < this.GW / 2 ? this.W / 2 + this.GD : this.W / 2 + b.r * FIS.oob, ly = this.H / 2 + b.r * FIS.oob;
      if (b.x < -lx){ b.x = -lx; b.vx = Math.max(0, b.vx); } else if (b.x > lx){ b.x = lx; b.vx = Math.min(0, b.vx); }
      if (b.y < -ly){ b.y = -ly; b.vy = Math.max(0, b.vy); } else if (b.y > ly){ b.y = ly; b.vy = Math.min(0, b.vy); }
    }
  }
  corpos(a, b){
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), R = a.r + b.r;
    if (d >= R || d <= 0) return -1;
    const nx = dx / d, ny = dy / d, pen = R - d, im = a.inv + b.inv;
    a.x -= nx * pen * a.inv / im; a.y -= ny * pen * a.inv / im;
    b.x += nx * pen * b.inv / im; b.y += ny * pen * b.inv / im;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn > 0) return 0;
    const misto = a.bola !== b.bola;
    const e = misto ? FIS.pbMin + Math.min(FIS.pbMax, Math.abs(vn) / FIS.tick * FIS.pbScale) : FIS.bounce;
    const jj = -(1 + e) * vn / im;
    a.vx -= nx * jj * a.inv; a.vy -= ny * jj * a.inv;
    b.vx += nx * jj * b.inv; b.vy += ny * jj * b.inv;
    return -vn;
  }

  // ------------------------------------------------ um passo de 1/60 s
  passo(dt){
    this.t += dt; this.tick++;
    const k = dt * FIS.tick, b = this.bola;
    for (const j of this.jog){ j.px = j.x; j.py = j.y; }
    b.px = b.x; b.py = b.y; b.pz = b.z;
    for (const j of this.jog){ this.habilidades(j, dt); this.movimento(j, dt, k); }
    for (const j of this.jog) this.tentaChute(j);
    const M = this.M, dP = Math.pow(M.damp, k), dI = Math.pow(M.idle, k), dM = Math.pow(M.mom, k), dB = Math.pow(FIS.bDamp, k), cr2 = FIS.cruise * FIS.cruise;
    for (const j of this.jog){
      j.x += j.vx * dt; j.y += j.vy * dt;
      const v2 = j.vx * j.vx + j.vy * j.vy;
      const d = v2 > cr2 ? dM : (j.mx * j.mx + j.my * j.my > 1e-4 && !j.travado ? dP : dI);
      j.vx *= d; j.vy *= d;
      this.arena(j);
    }
    b.x += b.vx * dt; b.y += b.vy * dt; b.vx *= dB; b.vy *= dB;
    this.arena(b);
    const n = this.jog.length;
    for (let i = 0; i < n; i++){
      const a = this.jog[i];
      for (let q = i + 1; q < n; q++){ const imp = this.corpos(a, this.jog[q]); if (imp > 70) this.ev.push({ tipo: 'choque', imp, x: (a.x + this.jog[q].x) / 2, y: (a.y + this.jog[q].y) / 2 }); }
      const imp = this.corpos(a, b);
      if (imp >= 0){ this.tocou(a); if (imp > 25) this.ev.push({ tipo: 'toque', j: a, imp, x: b.x, y: b.y }); }
    }
    // altura da bola (só visual: chute forte dá uma subidinha)
    if (b.z > 0 || b.vz > 0){ b.vz -= 1100 * dt; b.z += b.vz * dt; if (b.z <= 0){ b.z = 0; b.vz = b.vz < -90 ? -b.vz * .35 : 0; } }
    // gol?
    if (this.golLigado && Math.abs(b.y) < this.GW / 2){
      if (b.x + b.r < -this.W / 2) this.marcou(1);
      else if (b.x - b.r > this.W / 2) this.marcou(0);
    }
    this.grava();
  }
  marcou(time){
    this.golLigado = false;
    this.placar[time]++;
    let autor = null, assist = null, contra = false;
    for (let i = this.toques.length - 1; i >= 0; i--){ const tq = this.toques[i]; if (this.t - tq.t < 12){ autor = tq.j; break; } }
    if (autor){
      if (autor.time !== time){ contra = true; autor.st.contra++; }
      else {
        autor.st.gols++;
        for (let i = this.toques.length - 2; i >= 0; i--){
          const tq = this.toques[i]; if (tq.j === autor) continue;
          if (tq.j.time === time && this.t - tq.t < 9){ assist = tq.j; assist.st.assist++; }
          break;
        }
      }
    }
    const ultChute = autor && !contra && this.t - autor.ultChuteT < 2.5 ? autor : null;
    this.ev.push({ tipo: 'gol', time, autor, assist, contra, x: this.bola.x, y: this.bola.y, forte: !!(ultChute && (autor._ultK === 'forte' || autor._ultK === 'duplo')) });
  }

  // ------------------------------------------------ gravação para o replay
  grava(){
    const f = new Float32Array(3 + this.jog.length * 3);
    const b = this.bola; f[0] = b.x; f[1] = b.y; f[2] = b.z;
    this.jog.forEach((j, i) => { f[3 + i * 3] = j.x; f[4 + i * 3] = j.y; f[5 + i * 3] = j.carga; });
    this.grav.push(f); if (this.grav.length > this.gravMax) this.grav.shift();
  }
  aplicaQuadro(f){
    const b = this.bola; b.px = b.x; b.py = b.y; b.pz = b.z; b.vx = (f[0] - b.x) * 60; b.vy = (f[1] - b.y) * 60; b.x = f[0]; b.y = f[1]; b.z = f[2];
    this.jog.forEach((j, i) => { j.px = j.x; j.py = j.y; j.vx = (f[3 + i * 3] - j.x) * 60; j.vy = (f[4 + i * 3] - j.y) * 60; j.x = f[3 + i * 3]; j.y = f[4 + i * 3]; j.carga = f[5 + i * 3]; });
  }
  // ------------------------------------------------ fotos do estado (servidor → jogo online)
  foto(){
    const b = this.bola, r1 = v => Math.round(v * 10) / 10;
    return { b: [r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), r1(b.z)], d: this.jog.map(j => [j.id, r1(j.x), r1(j.y), r1(j.vx), r1(j.vy), Math.round(j.carga * 100) / 100, j.forteCd > 0 ? r1(j.forteCd) : 0]) };
  }
  // previsão da bola sem paredes (para os bots)
  preve(t){ const b = this.bola, s = (1 - Math.pow(FIS.bDamp, t * FIS.tick)) * SOMA_BOLA; return { x: clamp(b.x + b.vx * s, -this.W / 2, this.W / 2), y: clamp(b.y + b.vy * s, -this.H / 2, this.H / 2) }; }
}

// ---- 40-ia.js (o mesmo código do jogo) ----
// ======================================================================= BOTS
const DIF_P = [
  { reac: .34, atraso: .16, erro: .2,  tol: .34, vel: .8,  carga: 0,   passe: .3,  antecipa: .45, duplo: 0,   lerdo: .25 },
  { reac: .2,  atraso: .1,  erro: .11, tol: .24, vel: .92, carga: .35, passe: .55, antecipa: .75, duplo: 0,   lerdo: .1 },
  { reac: .11, atraso: .05, erro: .06, tol: .16, vel: 1,   carga: .7,  passe: .75, antecipa: .95, duplo: .12, lerdo: .03 },
  { reac: .06, atraso: .02, erro: .03, tol: .11, vel: 1,   carga: .9,  passe: .85, antecipa: 1,   duplo: .3,  lerdo: 0 }
];
function preveDe(p, s, t){ const k = (1 - Math.pow(FIS.bDamp, t * FIS.tick)) * SOMA_BOLA; return { x: clamp(s.x + s.vx * k, -p.W / 2, p.W / 2), y: clamp(s.y + s.vy * k, -p.H / 2, p.H / 2) }; }
function distSeg(px, py, ax, ay, bx, by){ const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1; const t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1); return Math.hypot(px - ax - dx * t, py - ay - dy * t); }

const IA = {
  // o estado da IA fica guardado em cada partida (o servidor roda várias ao mesmo tempo)
  est(p){ return p.ia || (p.ia = { hist: [], times: [{ t: 0, ch: null }, { t: 0, ch: null }] }); },
  registra(p){ const h = this.est(p).hist, b = p.bola; h.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy }); if (h.length > 40) h.shift(); },
  percebe(p, atraso){ const h = this.est(p).hist, n = h.length; if (!n) return { x: 0, y: 0, vx: 0, vy: 0 }; return h[Math.max(0, n - 1 - Math.round(atraso * 60))]; },
  reset(p){ if (p) p.ia = null; },
  tempoAte(p, j, s){
    const v = 185;
    for (let t = 0; t <= 2; t += .1){ const bp = preveDe(p, s, t); const d = Math.hypot(bp.x - j.x, bp.y - j.y) - 28; if (d / v <= t) return t; }
    const bp = preveDe(p, s, 2); return 2 + Math.hypot(bp.x - j.x, bp.y - j.y) / v;
  },
  papeis(p, time, dt){
    const st = this.est(p).times[time]; st.t -= dt; if (st.t > 0) return; st.t = .22;
    const m = p.jog.filter(j => j.time === time); if (!m.length) return;
    const s = this.percebe(p, .05);
    let ch = null, best = 1e9;
    for (const j of m){
      if (j.bot && j.bot.fixo){ j.papel = j.bot.fixo; continue; }
      const ti = this.tempoAte(p, j, s) - (j === st.ch ? .22 : 0) - (j.humano ? .35 : 0);
      if (ti < best){ best = ti; ch = j; }
    }
    st.ch = ch; if (ch) ch.papel = 'atacante';
    const meuGolX = time === 0 ? -p.W / 2 : p.W / 2;
    const outros = m.filter(j => j !== ch && !(j.bot && j.bot.fixo)).sort((a, b) => Math.abs(a.x - meuGolX) - Math.abs(b.x - meuGolX));
    const noMeuLado = s.x * (meuGolX > 0 ? 1 : -1) > -60;
    outros.forEach((j, i) => { j.papel = i === 0 && (m.length >= 3 || noMeuLado) ? (m.length >= 3 ? 'goleiro' : 'zagueiro') : 'apoio'; });
  }
};

class Bot {
  constructor(j, dif){ this.j = j; this.dif = dif; this.P = DIF_P[clamp(dif, 0, 3)]; this.decT = 0; this.acao = null; this.botao = null; this.botaoT = 0; this.segurando = false; this.mira = 0; this.lado = Math.random() < .5 ? -1 : 1; this.fixo = null; this.duploPend = -1; this.lerdoT = 0; }
  // não chuta se a bola for sair na direção do próprio gol
  seguro(){
    const p = this.p, j = this.j, b = p.bola; if (!p) return true;
    const dx = b.x - j.x, dy = b.y - j.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const meuGolX = -this.dirAtk() * p.W / 2;
    if (ux * (meuGolX - b.x) > 0){ const t = (meuGolX - b.x) / ux; const yy = b.y + uy * t; if (Math.abs(yy) < p.GW / 2 + 70 && t < 1000) return false; }
    return true;
  }
  pensa(p, dt){
    this.p = p;
    const j = this.j; if (j.travado){ j.mx = j.my = 0; this.solta(); return; }
    this.decT -= dt; this.lerdoT -= dt;
    const s = IA.percebe(p, this.P.atraso);
    const papel = this.fixo || j.papel;
    if (papel === 'atacante') this.atacar(p, dt, s);
    else if (papel === 'goleiro') this.goleiro(p, dt, s);
    else if (papel === 'zagueiro') this.zagueiro(p, dt, s);
    else this.apoio(p, dt, s);
    this.botoes(p, dt);
  }
  vaiPara(p, gx, gy, chegada = 26, vel = 1){
    const j = this.j, W2 = p.W / 2, G2 = p.GW / 2;
    // sair de trás da linha de fundo sem enroscar na trave nem na rede
    if (Math.abs(j.x) > W2 - 4){
      const sx = Math.sign(j.x), dentro = Math.abs(j.y) < G2;
      if (dentro && Math.abs(gx) < W2 - 10){ gx = sx * (W2 - 60); gy = clamp(j.y, -G2 + 22, G2 - 22); }
      else if (!dentro && (Math.sign(gy) !== Math.sign(j.y) || Math.abs(gy) < G2 + 34)){ gx = sx * (W2 - 60); gy = Math.sign(j.y) * Math.max(Math.abs(j.y), G2 + j.r + 14); }
    }
    // destravar quando fica empurrando e não sai do lugar
    const vj = Math.hypot(j.vx, j.vy), quer = Math.hypot(gx - j.x, gy - j.y) > 40;
    if (quer && vj < 28) this.travaT = (this.travaT || 0) + 1 / 60; else this.travaT = 0;
    if (this.travaT > .7){ this.travaT = 0; const a = Math.atan2(gy - j.y, gx - j.x) + (Math.random() < .5 ? 1 : -1) * 1.3; this.desvio = { t: .45, x: j.x + Math.cos(a) * 120, y: j.y + Math.sin(a) * 120 }; }
    if (this.desvio && this.desvio.t > 0){ this.desvio.t -= 1 / 60; gx = this.desvio.x; gy = this.desvio.y; }
    // separação dos companheiros
    for (const o of p.jog){ if (o === j || o.time !== j.time) continue; const dx = j.x - o.x, dy = j.y - o.y, d = Math.hypot(dx, dy); if (d < 64 && d > 0 && j.papel !== 'atacante'){ gx += dx / d * (64 - d) * 1.4; gy += dy / d * (64 - d) * 1.4; } }
    const dx = gx - j.x, dy = gy - j.y, d = Math.hypot(dx, dy);
    if (d < 1.5){ j.mx = j.my = 0; return; }
    const mag = Math.min(1, d / chegada) * this.P.vel * vel;
    j.mx = dx / d * mag; j.my = dy / d * mag;
  }
  dirAtk(){ return this.j.time === 0 ? 1 : -1; }
  rivais(p){ return p.jog.filter(o => o.time !== this.j.time); }

  // ------------------------------------------------ quem vai na bola
  decide(p, s){
    const j = this.j, P = this.P, dir = this.dirAtk(), golX = dir * p.W / 2, meuGolX = -golX;
    const bp = preveDe(p, s, .25);
    const distGol = Math.hypot(golX - bp.x, bp.y), distMeu = Math.hypot(meuGolX - bp.x, bp.y);
    let pressao = 1e9; for (const o of this.rivais(p)) pressao = Math.min(pressao, Math.hypot(o.x - bp.x, o.y - bp.y));
    this.mira = (Math.random() * 2 - 1) * P.erro;
    if (Math.random() < P.lerdo) this.lerdoT = rnd(.2, .5);
    if (distMeu < 340 && pressao < 130){
      this.acao = { tipo: 'afasta', tx: bp.x + dir * 520, ty: bp.y + (bp.y >= 0 ? 1 : -1) * 300, carregar: false }; return;
    }
    const alvoY = this.canto(p, golX);
    const qc = this.qualChute(p, bp, golX, alvoY, dir);
    const ps = this.melhorPasse(p, bp, dir, golX);
    // decide uma vez se vai carregar o chute forte e mantém a ideia por um tempinho
    this.planoT = (this.planoT || 0) - P.reac;
    if (this.planoT <= 0){ this.plano = Math.random() < P.carga; this.planoT = 1.4; }
    if (qc > .52 || (distGol < 360 && qc > .22)){ this.acao = { tipo: 'chute', tx: golX + dir * 30, ty: alvoY, carregar: distGol > 200 && this.plano }; return; }
    if (ps && Math.random() < P.passe && (ps.q > qc + .08 || pressao < 95)){ this.acao = { tipo: 'passe', tx: ps.x, ty: ps.y }; return; }
    if (distGol < 640 && qc > .3 && Math.random() < .45){ this.acao = { tipo: 'chute', tx: golX + dir * 30, ty: alvoY, carregar: this.plano }; return; }
    // conduzir: para o gol, desviando do rival mais perto
    let ty = bp.y * .6; let perto = null, pd = 1e9;
    for (const o of this.rivais(p)){ const ahead = (o.x - bp.x) * dir; if (ahead > 0 && ahead < 260){ const d = Math.hypot(o.x - bp.x, o.y - bp.y); if (d < pd){ pd = d; perto = o; } } }
    if (perto) ty = bp.y + (perto.y > bp.y ? -1 : 1) * 170;
    this.acao = { tipo: 'conduz', tx: clamp(bp.x + dir * 300, -p.W / 2 + 60, p.W / 2 - 60), ty: clamp(ty, -p.H / 2 + 70, p.H / 2 - 70) };
    if (Math.abs(this.acao.tx - bp.x) < 120) this.acao = { tipo: 'chute', tx: golX + dir * 30, ty: alvoY, carregar: false };
  }
  canto(p, golX){
    let gk = null, gd = 1e9;
    for (const o of this.rivais(p)){ const d = Math.hypot(o.x - golX, o.y); if (d < gd){ gd = d; gk = o; } }
    const m = p.GW / 2 - 24;
    if (gk && gd < 220) return (gk.y > 0 ? -1 : 1) * m * rnd(.55, 1);
    return (Math.random() < .5 ? -1 : 1) * m * rnd(.2, .9);
  }
  qualChute(p, bp, golX, alvoY, dir){
    if ((golX - bp.x) * dir < 20) return 0;
    const dist = Math.hypot(golX - bp.x, alvoY - bp.y);
    let q = clamp(1 - (dist - 220) / 620, 0, 1);
    const ang = Math.abs(Math.atan2(bp.y, Math.abs(golX - bp.x)));
    q *= clamp(1.3 - ang, .15, 1);
    for (const o of this.rivais(p)){ if (distSeg(o.x, o.y, bp.x, bp.y, golX, alvoY) < 30) q *= .45; }
    return q;
  }
  melhorPasse(p, bp, dir, golX){
    let best = null;
    for (const m of p.jog){
      if (m === this.j || m.time !== this.j.time) continue;
      const tx = m.x + m.vx * .3, ty = m.y + m.vy * .3, d = Math.hypot(tx - bp.x, ty - bp.y);
      if (d < 110 || d > 760) continue;
      let q = .45 + clamp((tx - bp.x) * dir / 420, -.4, .45);
      for (const o of this.rivais(p)) if (distSeg(o.x, o.y, bp.x, bp.y, tx, ty) < 42) q -= .5;
      q += (1 - clamp(Math.hypot(golX - tx, ty) / 900, 0, 1)) * .35;
      if (m.humano) q += .12;
      if (!best || q > best.q) best = { q, x: tx, y: ty, m };
    }
    return best && best.q > .2 ? best : null;
  }
  atacar(p, dt, s){
    const j = this.j, P = this.P, b = p.bola;
    if (this.decT <= 0 || !this.acao){ this.decT = P.reac * rnd(.8, 1.3); this.decide(p, s); }
    if (this.lerdoT > 0){ this.vaiPara(p, s.x, s.y, 30, .6); return; }
    const a = this.acao;
    const dist = Math.hypot(s.x - j.x, s.y - j.y);
    const bp = preveDe(p, s, clamp(dist / 260, 0, .6) * P.antecipa);
    let ax = a.tx - bp.x, ay = a.ty - bp.y; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
    const an = Math.atan2(ay, ax) + this.mira; ax = Math.cos(an); ay = Math.sin(an);
    const rx = j.x - bp.x, ry = j.y - bp.y, along = rx * ax + ry * ay, perp = -rx * ay + ry * ax;
    const contato = j.r + b.r;
    // bola presa no canto ou na linha: bate pro meio
    const vb = Math.hypot(b.vx, b.vy), naParede = Math.abs(b.x) > p.W / 2 - 34 || Math.abs(b.y) > p.H / 2 - 34;
    if (vb < 30 && naParede && dist < 60){ this.presoT = (this.presoT || 0) + dt; } else this.presoT = 0;
    if (this.presoT > .9){ this.presoT = 0; this.acao = { tipo: 'afasta', tx: 0, ty: 0, carregar: false }; this.decT = .8; }
    const atras = this.atras ? along < -contato * .05 : along < -contato * .55;
    this.atras = atras;
    let gx, gy;
    if (!atras){
      // contorna a bola sem encostar: primeiro sai de lado, depois vai por trás
      const lado = perp >= 0 ? 1 : -1, px = -ay * lado, py = ax * lado, R0 = contato + 12;
      if (Math.abs(perp) < R0 + 8){ const al = Math.max(along, 6); gx = bp.x + ax * al + px * (R0 + 24); gy = bp.y + ay * al + py * (R0 + 24); }
      else { gx = bp.x + px * (R0 + 14) - ax * (contato + 8); gy = bp.y + py * (R0 + 14) - ay * (contato + 8); }
      this.soltaCarga();
      // se está colado e é pra afastar, bate assim mesmo
      if (a.tipo === 'afasta' && dist < p.alcance(j) + 2){ const dirMeuGol = -this.dirAtk(); if ((b.x - j.x) * dirMeuGol < 0) this.aperta('k'); }
    } else {
      gx = bp.x - ax * (contato + 2); gy = bp.y - ay * (contato + 2);
      const mbx = b.x - j.x, mby = b.y - j.y, mbl = Math.hypot(mbx, mby) || 1;
      const erro = Math.acos(clamp((mbx * ax + mby * ay) / mbl, -1, 1));
      const reach = p.alcance(j);
      if (a.tipo === 'conduz'){ gx = bp.x + ax * 34; gy = bp.y + ay * 34; }
      else if (erro < P.tol){
        gx = bp.x + ax * 12; gy = bp.y + ay * 12;
        if (a.tipo === 'passe'){ if (mbl < reach + 1) this.aperta('p'); }
        else if (a.carregar && j.forteCd <= 0 && mbl > reach + 4) this.segura();
        else if (mbl < reach + 1) this.aperta('k');
      } else if (a.carregar && j.forteCd <= 0 && erro < P.tol * 2.5 && mbl < 320 && mbl > reach + 4) this.segura();
      else this.soltaCarga();
    }
    this.vaiPara(p, gx, gy, 12, 1);
  }
  goleiro(p, dt, s){
    const j = this.j, dir = this.dirAtk(), meuGolX = -dir * p.W / 2, b = p.bola;
    let ty = s.y * .5;
    if (s.vx * -dir > 60){ const tt = Math.abs((meuGolX - s.x) / s.vx); if (tt < 1.6) ty = s.y + s.vy * tt * .85; }
    ty = clamp(ty, -p.GW / 2 + 14, p.GW / 2 - 14);
    let gx = meuGolX + dir * (j.r + 18), gy = ty;
    const distBolaGol = Math.hypot(s.x - meuGolX, s.y), vb = Math.hypot(s.vx, s.vy), db = Math.hypot(s.x - j.x, s.y - j.y);
    let rivalPerto = 1e9; for (const o of this.rivais(p)) rivalPerto = Math.min(rivalPerto, Math.hypot(o.x - s.x, o.y - s.y));
    if (distBolaGol < 250 && (vb < 170 || db < 75) && (rivalPerto > db - 10 || db < 60)){
      let ux = s.x - meuGolX, uy = s.y; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      gx = s.x - ux * (j.r + b.r) + ux * 10; gy = s.y - uy * (j.r + b.r) + uy * 10;
      const mbx = b.x - j.x, mby = b.y - j.y, mbl = Math.hypot(mbx, mby) || 1;
      if (mbl < p.alcance(j) + 1 && (mbx * ux + mby * uy) / mbl > .2) this.aperta('k');
      this.vaiPara(p, gx, gy, 10, 1); return;
    }
    this.vaiPara(p, gx, gy, 22, 1);
  }
  zagueiro(p, dt, s){
    const j = this.j, dir = this.dirAtk(), meuGolX = -dir * p.W / 2, b = p.bola;
    const vx = s.x - meuGolX, vy = s.y, L = Math.hypot(vx, vy) || 1;
    const dd = clamp(L * .42, 110, 420);
    let gx = meuGolX + vx / L * dd, gy = vy / L * dd;
    // marca o rival livre mais perigoso quando a bola está longe
    if (L > 520){
      let alvo = null, ad = 1e9;
      for (const o of this.rivais(p)){ const d = Math.hypot(o.x - meuGolX, o.y); if (d < ad && Math.hypot(o.x - s.x, o.y - s.y) > 120){ ad = d; alvo = o; } }
      if (alvo){ const ox = alvo.x - meuGolX, oy = alvo.y, ol = Math.hypot(ox, oy) || 1; gx = lerp(gx, meuGolX + ox / ol * (ol - 70), .6); gy = lerp(gy, oy / ol * (ol - 70), .6); }
    }
    const db = Math.hypot(b.x - j.x, b.y - j.y);
    if (db < p.alcance(j) + 1){ const ux = b.x - j.x; if (ux * dir > 0) this.aperta('k'); }
    this.vaiPara(p, gx, gy, 26, 1);
  }
  apoio(p, dt, s){
    const j = this.j, dir = this.dirAtk();
    if (Math.abs(s.y) > p.H * .25) this.lado = s.y > 0 ? -1 : 1;
    let gx = clamp(s.x + dir * 240, -p.W / 2 + 110, p.W / 2 - 110);
    if (gx * dir > p.W / 2 - 150) gx = dir * (p.W / 2 - 150);
    let gy = clamp(s.y + this.lado * 230, -p.H / 2 + 70, p.H / 2 - 70);
    const db = Math.hypot(p.bola.x - j.x, p.bola.y - j.y);
    if (db < p.alcance(j) + 1 && (p.bola.x - j.x) * dir > 0) this.aperta('k');
    this.vaiPara(p, gx, gy, 40, 1);
  }
  // ------------------------------------------------ botões
  aperta(b){
    if (this.botao || !this.seguro()) return;
    const j = this.j;
    if (b === 'k'){ j.kD = true; j.kN++; } else { j.pD = true; j.pN++; }
    this.botao = b; this.botaoT = .12; this.segurando = false;
    if (b === 'k' && this.acao && this.acao.tipo === 'chute' && Math.random() < this.P.duplo) this.duploPend = .06;
  }
  segura(){
    const j = this.j;
    if (this.botao === 'k' && this.segurando){ this.botaoT = .3; return; }
    if (this.botao || !this.seguro()) return;
    j.kD = true; j.kN++; this.botao = 'k'; this.segurando = true; this.botaoT = .3;
  }
  soltaCarga(){ if (this.segurando){ this.j.kD = false; this.botao = null; this.segurando = false; } }
  solta(){ this.j.kD = this.j.pD = false; this.botao = null; this.segurando = false; }
  botoes(p, dt){
    const j = this.j;
    if (this.duploPend > 0){ this.duploPend -= dt; if (this.duploPend <= 0){ j.pN++; this.duploPend = -1; } }
    if (!this.botao) return;
    if (!this.seguro()){ this.solta(); j.kL.tm = 0; j.pL.tm = 0; return; }
    this.botaoT -= dt;
    const L = this.botao === 'k' ? j.kL : j.pL;
    if (!L.arm || this.botaoT <= 0) this.solta();
  }
}

// ---- 45-proto.js (o mesmo código do jogo) ----
// ======================================================================= SALAS: regras e protocolo (o mesmo arquivo roda no jogo e no servidor)
// Tudo viaja em JSON pelo WebSocket; cada mensagem tem o campo t (o tipo). A lista completa está no PROTOCOLO.md.
const PROTO = 3;
// nome de usuário: de 3 a 8 letras ou números (pode _ e .). Para entrar, aceita os nomes antigos (até 16).
const USUARIO_MAX = 8;
const USUARIO_RE = /^[\p{L}\p{N}_.]{3,8}$/u, USUARIO_ENTRAR_RE = /^[\p{L}\p{N}_.]{3,16}$/u;
const usuarioMin = u => String(u).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const SALA = {
  nomeMin: 3, nomeMax: 32, senhaMax: 32, chatMax: 80, espMax: 12, nomeJogMax: 16,
  modos: [1, 2, 3, 4], campos: [1, 2, 3], tempos: [3, 5, 7, 10], gols: [0, 1, 3, 5, 10]
};
const ESPECTADOR = 2;                                     // time 0 = VERMELHO, 1 = AZUL, 2 = espectadores
const CAMPO_NOME = { 1: 'PEQUENO', 2: 'MÉDIO', 3: 'GRANDE' };
const REGIAO_NOME = { sa: 'BRASIL', us: 'EUA', eu: 'EUROPA', local: 'AQUI' };
const STATUS_NOME = { espera: 'ESPERANDO', comecando: 'COMEÇANDO', jogo: 'EM JOGO' };
const HORAS_SALA = ['tarde', 'por', 'noite'];
const campoPadrao = modo => modo <= 1 ? 1 : modo === 2 ? 2 : 3;
const maxJogadores = modo => modo * 2;

// ajustes da sala sempre válidos (o que vier errado volta para o padrão)
function cfgSala(c){
  c = c && typeof c === 'object' ? c : {};
  const modo = SALA.modos.includes(+c.modo) ? +c.modo : 2;
  return {
    modo,
    campo: SALA.campos.includes(+c.campo) ? +c.campo : campoPadrao(modo),
    tempo: SALA.tempos.includes(+c.tempo) ? +c.tempo : 3,
    gols: SALA.gols.includes(+c.gols) ? +c.gols : 5,
    ouro: c.ouro !== false,
    trocaJogo: c.trocaJogo !== false,
    hora: HORAS_SALA.includes(c.hora) ? c.hora : 'por',
    jogab: c.jogab === 'classica' ? 'classica' : 'leve'
  };
}
const nomeSala = s => { s = limpaTexto(s, SALA.nomeMax); return s.length >= SALA.nomeMin ? s : ''; };
const nomeJogador = s => { s = limpaTexto(s, SALA.nomeJogMax); return s.length >= 2 ? s : 'Jogador'; };
const senhaLimpa = s => String(s == null ? '' : s).slice(0, SALA.senhaMax);
function visualLimpo(v){
  v = v && typeof v === 'object' ? v : {};
  return { desenho: skinDe(v.desenho).id, texto: textoBotao(v.texto), cor: v.cor === 'time' || COR_RE.test(v.cor) ? v.cor : 'time' };
}
// quantos jogam e quantos assistem
function contaSala(s){ let jog = 0, esp = 0; for (const m of s.membros) m.time === ESPECTADOR ? esp++ : jog++; return { jog, esp }; }
const vagasTime = (s, t) => s.cfg.modo - s.membros.filter(m => m.time === t).length;
// a linha da sala na lista
function resumoSala(s){
  const { jog, esp } = contaSala(s), dono = s.membros.find(m => m.id === s.dono);
  return { id: s.id, nome: s.nome, tipo: s.tipo, tranca: !!s.tranca, modo: s.cfg.modo, campo: s.cfg.campo, tempo: s.cfg.tempo, regiao: s.regiao,
    jog, max: maxJogadores(s.cfg.modo), esp, status: s.status, dono: dono ? dono.nome : '', donoVf: !!(dono && dono.vf), placar: s.status === 'jogo' && s.placar ? s.placar.slice() : null };
}
// para onde vai quem entra: o time com menos gente (se tiver vaga) ou a arquibancada
function timeQueEntra(s){
  const a = vagasTime(s, 0), b = vagasTime(s, 1);
  if (a <= 0 && b <= 0) return ESPECTADOR;
  if (a === b) return Math.random() < .5 ? 0 : 1;
  return a > b ? 0 : 1;
}
// nome de bot que ainda não está na sala
function nomeDeBot(s){
  const usados = new Set(s.membros.map(m => m.nome));
  const livres = NOMES_BOT.filter(n => !usados.has(n));
  return livres.length ? livres[Math.floor(Math.random() * livres.length)] : 'Bot ' + (s.membros.length + 1);
}
const DIF_NOME = ['FÁCIL', 'MÉDIO', 'DIFÍCIL', 'LENDA'];

// ======================================================================= RANKING DAS SALAS: gols, assistências e melhor da partida
// rk = { j: jogos, v: vitórias, g: gols, a: assistências, m: vezes que foi o melhor da partida }
const rkZero = () => ({ j: 0, v: 0, g: 0, a: 0, m: 0 });
function rkLimpo(r){ r = r && typeof r === 'object' ? r : {}; const o = rkZero(); for (const k in o) o[k] = Math.max(0, Math.min(1e7, Math.floor(+r[k] || 0))); return o; }
const RK_NOMES = { g: 'GOLS', a: 'ASSISTÊNCIAS', m: 'MELHOR DA PARTIDA' };
// a nota de cada um na partida: gol 10, assistência 6, vitória 4, chute 1, passe 0,6, toque 0,25 e gol contra −6
function notaPartida(st, venceu){ return (st.gols | 0) * 10 + (st.assist | 0) * 6 + (venceu ? 4 : 0) + (st.chutes | 0) + (st.passes | 0) * .6 + (st.toques | 0) * .25 - (st.contra | 0) * 6; }
// o melhor da partida: a maior nota (empate: mais gols, depois mais assistências). jogs = [{ id, time, st }]
function melhorDaPartida(jogs, placar){
  let melhor = null, mn = -1e9;
  for (const j of jogs || []){
    if (!j || !j.st) continue;
    const venceu = (j.time === 0 && placar[0] > placar[1]) || (j.time === 1 && placar[1] > placar[0]);
    const n = Math.round(notaPartida(j.st, venceu) * 100) / 100;
    if (!melhor || n > mn || (n === mn && ((j.st.gols | 0) > (melhor.st.gols | 0) || ((j.st.gols | 0) === (melhor.st.gols | 0) && (j.st.assist | 0) > (melhor.st.assist | 0))))){ melhor = j; mn = n; }
  }
  return melhor ? { id: melhor.id, nota: mn } : null;
}


const CONFIG = {
  porta: +process.env.PORTA || +process.env.PORT || 8080,
  nome: limpaTexto(process.env.NOME || 'GINGA', 40),
  regiao: ['sa', 'us', 'eu'].includes(process.env.REGIAO) ? process.env.REGIAO : 'sa',
  maxSalas: 200, maxConexoesIp: 12, maxJogadores: 2000,
  html: process.env.HTML || path.join(__dirname, 'ginga.html'),
  voltaSeg: 20,             // segundos para voltar depois de cair, sem perder o lugar
  replay: true,
  dados: process.env.DADOS || path.join(__dirname, 'dados'),
  // admin: só a conta #1 (o dono do servidor: crie a sua conta primeiro)
  sessaoDias: 180,          // "continuar conectado": quanto tempo o login fica salvo
  oficiais: process.env.OFICIAIS === '1'   // salas oficiais automáticas (desligadas: o jogo é só nas salas personalizadas)
};
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const agoraMs = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ WebSocket (RFC 6455) na unha
const GUID_WS = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const conexoes = new Set(), porIp = new Map();
class Conexao {
  constructor(sock, ip){
    this.sock = sock; this.ip = ip; this.buf = Buffer.alloc(0); this.frag = null; this.vivo = true;
    this.jog = null; this.ultMsg = agoraMs(); this.pong = agoraMs();
    this.balde = 120; this.baldeT = agoraMs(); this.chatT = 0;
    conexoes.add(this); porIp.set(ip, (porIp.get(ip) || 0) + 1);
    sock.setNoDelay(true);
    sock.on('data', d => this.dados(d));
    sock.on('close', () => this.fim());
    sock.on('error', () => this.fim());
  }
  dados(d){
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > 1 << 20) return this.fecha(1009);
    for (;;){
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masc = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (len === 126){ if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (b.length < 10) return; if (b.readUInt32BE(2)) return this.fecha(1009); len = b.readUInt32BE(6); off = 10; }
      if (!masc) return this.fecha(1002);
      if (len > 65536) return this.fecha(1009);
      if (b.length < off + 4 + len) return;
      const k = b.subarray(off, off + 4); off += 4;
      const pl = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) pl[i] = b[off + i] ^ k[i & 3];
      this.buf = b.subarray(off + len);
      if (op === 8){ this.fecha(1000); return; }
      if (op === 9){ this.frame(10, pl); continue; }
      if (op === 10){ this.pong = agoraMs(); continue; }
      if (op === 0 || op === 1 || op === 2){
        if (op !== 0) this.frag = { op, partes: [pl], tam: pl.length };
        else if (this.frag){ this.frag.partes.push(pl); this.frag.tam += pl.length; if (this.frag.tam > 65536) return this.fecha(1009); }
        else return this.fecha(1002);
        if (fin){ const f = this.frag; this.frag = null; if (f.op === 1) this.texto(Buffer.concat(f.partes).toString('utf8')); }
        continue;
      }
      return this.fecha(1002);
    }
  }
  frame(op, data){
    if (!this.vivo) return;
    const n = data.length; let h;
    if (n < 126){ h = Buffer.allocUnsafe(2); h[1] = n; }
    else if (n < 65536){ h = Buffer.allocUnsafe(4); h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.allocUnsafe(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    h[0] = 0x80 | op;
    if (this.sock.writableLength > 2 << 20){ this.fecha(1008); return; }   // cliente lento demais
    this.sock.write(Buffer.concat([h, data]));
  }
  envia(m){ if (this.vivo) this.frame(1, Buffer.from(typeof m === 'string' ? m : JSON.stringify(m))); }
  fecha(cod){
    if (!this.vivo) return;
    const c = Buffer.allocUnsafe(2); c.writeUInt16BE(cod || 1000, 0);
    try { this.frame(8, c); } catch (_) {}
    this.vivo = false; try { this.sock.end(); } catch (_) {}
    setTimeout(() => { try { this.sock.destroy(); } catch (_) {} }, 1000);
    this.fim();
  }
  fim(){
    if (this._fim) return; this._fim = true; this.vivo = false;
    conexoes.delete(this); const n = (porIp.get(this.ip) || 1) - 1; if (n > 0) porIp.set(this.ip, n); else porIp.delete(this.ip);
    if (this.jog) caiu(this.jog, this);
  }
  texto(s){
    this.ultMsg = agoraMs();
    // limite de mensagens por segundo (balde de fichas)
    const t = agoraMs(); this.balde = Math.min(120, this.balde + (t - this.baldeT) * .09); this.baldeT = t;
    if (--this.balde < 0){ if (this.balde < -200) this.fecha(1008); return; }
    let m; try { m = JSON.parse(s); } catch (_) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { mensagem(this, m); } catch (e) { log('erro na mensagem', m.t, e && e.stack || e); }
  }
}

// ------------------------------------------------------------------ jogadores, salas e chat
const jogadores = new Map(), porToken = new Map(), salas = new Map();
const chatGeral = { brasil: [], global: [] };
let seq = 0, seqSala = 0, listaSuja = true;
const novoId = () => ++seq;

class Sala {
  constructor(o){
    this.id = 's' + (++seqSala).toString(36);
    this.nome = o.nome; this.senha = o.senha || ''; this.tipo = o.tipo || 'pers';
    this.cfg = cfgSala(o.cfg); this.regiao = CONFIG.regiao;
    this.membros = []; this.dono = o.dono != null ? o.dono : null;
    this.status = 'espera'; this.placar = [0, 0]; this.hist = []; this.expulsos = new Set();
    this.p = null; this.fase = null; this.faseT = 0; this.k = 0; this.evs = []; this.pausada = false;
    this.suja = true; this.autoT = 0; this.saidos = [];
    salas.set(this.id, this); listaSuja = true;
  }
  estado(){
    return { id: this.id, nome: this.nome, tipo: this.tipo, tranca: !!this.senha, dono: this.dono, cfg: this.cfg, regiao: this.regiao, status: this.status,
      pausada: this.pausada, placar: this.placar, hist: this.hist.slice(0, 10),
      membros: this.membros.map(m => ({ id: m.id, cid: m.jog && m.jog.conta ? m.jog.conta.id : null, vf: !!m.vf, nome: m.nome, visual: m.visual, time: m.time, bot: m.bot, volta: !!m.volta, st: m.st })) };
  }
  humanos(){ return this.membros.filter(m => m.bot == null); }
  manda(msg){ const s = JSON.stringify(msg); for (const m of this.membros) if (m.jog && m.jog.con) m.jog.con.envia(s); }
  sis(texto){ this.manda({ t: 'chat', canal: 'sala', de: '', texto, sis: true }); }
}
const membroDe = (s, id) => s ? s.membros.find(m => m.id === id) : null;

// ------------------------------------------------------------------ CONTAS: nome de usuário + senha, ID começando no #1
// dados/contas.json guarda as contas (senha com scrypt, nunca a senha) e os logins salvos;
// dados/perfis/<id>.json guarda o progresso de cada conta (moedas, nível, skins...).
const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const Contas = {
  d: { prox: 1, contas: [], sessoes: {}, adm: [] }, porMin: new Map(), porId: new Map(),
  sujo: false, gravando: false, salvaT: null, perfis: new Map(), perfilT: new Map(),
  get arq(){ return path.join(CONFIG.dados, 'contas.json'); },
  get pastaPerfis(){ return path.join(CONFIG.dados, 'perfis'); },
  carrega(){
    fs.mkdirSync(this.pastaPerfis, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.arq)){
      let d;
      try { d = JSON.parse(fs.readFileSync(this.arq, 'utf8')); }
      catch (e) { log(`ERRO: ${this.arq} está estragado (${e.message}). Conserte ou tire o arquivo de lá; o servidor não vai escrever por cima.`); process.exit(1); }
      this.d = { prox: Math.max(1, d.prox | 0), contas: Array.isArray(d.contas) ? d.contas : [], sessoes: d.sessoes && typeof d.sessoes === 'object' ? d.sessoes : {}, adm: Array.isArray(d.adm) ? d.adm.slice(-300) : [] };
    }
    for (const c of this.d.contas){ c.rk = rkLimpo(c.rk); this.porMin.set(c.min, c); this.porId.set(c.id, c); if (c.id >= this.d.prox) this.d.prox = c.id + 1; }
    this.limpaSessoes();
    log(`${this.d.contas.length} conta(s); a próxima conta criada vai ser a #${this.d.prox}`);
  },
  limpaSessoes(){ const t = Date.now(); for (const [k, x] of Object.entries(this.d.sessoes)) if (!x || x.exp < t || !this.porId.has(x.id)){ delete this.d.sessoes[k]; this.sujo = true; } },
  salva(){ this.sujo = true; if (!this.salvaT) this.salvaT = setTimeout(() => this.grava(), 700); },
  grava(){
    this.salvaT = null;
    if (this.gravando || !this.sujo) return;
    this.sujo = false; this.gravando = true;
    const tmp = this.arq + '.tmp';
    fs.writeFile(tmp, JSON.stringify(this.d), { mode: 0o600 }, e => {
      if (e) return this.gravou(e);
      fs.rename(tmp, this.arq, e2 => this.gravou(e2));
    });
  },
  gravou(e){ this.gravando = false; if (e){ log('erro salvando as contas:', e.message); this.sujo = true; } if (this.sujo) this.salva(); },
  gravaJa(){
    try {
      if (this.sujo || this.gravando){ const tmp = this.arq + '.saida'; fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 }); fs.renameSync(tmp, this.arq); this.sujo = false; }
      for (const [id, t] of this.perfilT){ clearTimeout(t); this.gravaPerfilJa(id); }
    } catch (e) { log('erro salvando na saída:', e.message); }
  },
  hash(senha, sal){ return new Promise((res, rej) => crypto.scrypt(String(senha).normalize('NFC'), sal, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k))); },
  async cria(usuario, senha){
    const min = usuarioMin(usuario);
    if (this.porMin.has(min)) return null;
    const sal = crypto.randomBytes(16), k = await this.hash(senha, sal);
    if (this.porMin.has(min)) return null;                          // alguém pegou o nome enquanto calculava
    const c = { id: this.d.prox++, usuario, min, sal: sal.toString('base64'), hash: k.toString('base64'), criado: Date.now(), ultimo: Date.now(), rk: rkZero() };
    this.d.contas.push(c); this.porMin.set(min, c); this.porId.set(c.id, c); this.salva();
    log(`conta nova: #${c.id} ${c.usuario}`);
    return c;
  },
  async confere(usuario, senha){
    const c = this.porMin.get(usuarioMin(usuario));
    const sal = c ? Buffer.from(c.sal, 'base64') : crypto.randomBytes(16);
    const k = await this.hash(senha, sal);                          // calcula mesmo sem conta (mesmo tempo de resposta)
    return c && crypto.timingSafeEqual(k, Buffer.from(c.hash, 'base64')) ? c : null;
  },
  async novaSenha(c, senha){ const sal = crypto.randomBytes(16), k = await this.hash(senha, sal); c.sal = sal.toString('base64'); c.hash = k.toString('base64'); this.salva(); },
  abreSessao(c, lembrar){ const tok = crypto.randomBytes(24).toString('hex'); this.d.sessoes[sha256(tok)] = { id: c.id, exp: Date.now() + (lembrar ? CONFIG.sessaoDias : 1) * 864e5 }; this.salva(); return tok; },
  daSessao(tok){ if (typeof tok !== 'string' || tok.length > 100) return null; const x = this.d.sessoes[sha256(tok)]; if (!x || x.exp < Date.now()) return null; return this.porId.get(x.id) || null; },
  fechaSessao(tok){ if (typeof tok === 'string' && this.d.sessoes[sha256(tok)]){ delete this.d.sessoes[sha256(tok)]; this.salva(); } },
  fechaOutras(c, tok){ const k = sha256(tok); for (const [h, x] of Object.entries(this.d.sessoes)) if (x.id === c.id && h !== k) delete this.d.sessoes[h]; this.salva(); },
  // progresso de cada conta (o servidor só guarda; quem joga é o aparelho)
  arqPerfil(id){ return path.join(this.pastaPerfis, (id | 0) + '.json'); },
  perfil(id){
    if (this.perfis.has(id)) return this.perfis.get(id);
    let d = null; try { d = JSON.parse(fs.readFileSync(this.arqPerfil(id), 'utf8')); } catch (_) {}
    this.perfis.set(id, d); return d;
  },
  guardaPerfil(id, dados){
    this.perfis.set(id, dados);
    if (this.perfilT.has(id)) return;
    this.perfilT.set(id, setTimeout(() => { this.perfilT.delete(id); this.gravaPerfil(id); }, 1500));
  },
  gravaPerfil(id){ const tmp = this.arqPerfil(id) + '.tmp'; fs.writeFile(tmp, JSON.stringify(this.perfis.get(id)), { mode: 0o600 }, e => { if (e) return log('erro salvando perfil', id, e.message); fs.rename(tmp, this.arqPerfil(id), () => {}); }); },
  gravaPerfilJa(id){ const tmp = this.arqPerfil(id) + '.saida'; fs.writeFileSync(tmp, JSON.stringify(this.perfis.get(id)), { mode: 0o600 }); fs.renameSync(tmp, this.arqPerfil(id)); }
};
// ------------------------------------------------------------------ ADMIN: verificado (o V na frente do nome) e tirar do chat
const PARA_SEMPRE = 8.64e15;
const ehAdmin = c => !!c && c.id === 1;
const vfDe = j => !!(j && j.conta && j.conta.verif);
const mudo = c => !!c && (c.mudoAte || 0) > Date.now();
const jogDaConta = id => { for (const j of jogadores.values()) if (j.conta && j.conta.id === id && j.con) return j; return null; };
function contaAdm(x){
  const m = mudo(x);
  return { id: x.id, usuario: x.usuario, vf: !!x.verif, admin: ehAdmin(x), mudoAte: m ? x.mudoAte : 0, mudoMotivo: m ? x.mudoMotivo || '' : '', online: !!jogDaConta(x.id), visual: x.visual || null, criado: x.criado || 0, ultimo: x.ultimo || 0, rk: x.rk, rkAdm: x.rkAdm || null };
}
function registra(eu, acao, alvo, min, d){
  Contas.d.adm.push(Object.assign({ t: Date.now(), por: eu.usuario, porId: eu.id, acao, alvo: alvo.usuario, alvoId: alvo.id, min }, d ? { d } : {}));
  if (Contas.d.adm.length > 300) Contas.d.adm.splice(0, Contas.d.adm.length - 300);
  Contas.salva(); log(`admin ${eu.usuario} (#${eu.id}): ${acao} ${alvo.usuario} (#${alvo.id})${min != null ? ' ' + (min || 'para sempre') + (min ? ' min' : '') : ''}${d ? ' ' + JSON.stringify(d) : ''}`);
}
// ------------------------------------------------------------------ RANKING DAS SALAS (gols, assistências e melhor da partida)
// Cada conta guarda rk = { j, v, g, a, m }. O servidor soma no fim das partidas que valem (gente de verdade nos dois times).
const Rk = {
  cache: {}, sujo: true,
  muda(){ this.sujo = true; },
  ordem(por){
    if (this.sujo){ this.cache = {}; this.sujo = false; }
    if (!this.cache[por]){
      const l = Contas.d.contas.filter(c => c.rk && c.rk[por] > 0).sort((x, y) => y.rk[por] - x.rk[por] || x.rk.j - y.rk.j || x.id - y.id);
      let pos = 0, ult = null; const posDe = new Map();
      l.forEach((c, i) => { if (c.rk[por] !== ult){ pos = i + 1; ult = c.rk[por]; } posDe.set(c.id, pos); });
      this.cache[por] = { l, posDe };
    }
    return this.cache[por];
  },
  pos(c){ return { g: this.ordem('g').posDe.get(c.id) || 0, a: this.ordem('a').posDe.get(c.id) || 0, m: this.ordem('m').posDe.get(c.id) || 0 }; },
  // manda os números novos para a pessoa (se estiver online)
  avisa(c){ const j = jogDaConta(c.id); if (j && j.con) j.con.envia({ t: 'rk', rk: c.rk, pos: this.pos(c) }); }
};
function ranking(jog, c, m){
  const por = ['g', 'a', 'm'].includes(m.por) ? m.por : 'g', o = Rk.ordem(por);
  const lista = o.l.slice(0, 50).map(x => ({ cid: x.id, nome: x.usuario, vf: !!x.verif, visual: x.visual || null, rk: x.rk, pos: o.posDe.get(x.id) }));
  const eu = jog.conta ? { pos: o.posDe.get(jog.conta.id) || 0, v: jog.conta.rk[por], j: jog.conta.rk.j } : null;
  c.envia({ t: 'ranking', por, lista, eu, total: o.l.length });
}
function perfilDe(jog, c, m){
  const x = Contas.porId.get(m.id | 0);
  if (!x) return c.envia({ t: 'perfilDe', erro: 'Conta não encontrada' });
  c.envia({ t: 'perfilDe', p: { cid: x.id, usuario: x.usuario, vf: !!x.verif, visual: x.visual || null, rk: x.rk, pos: Rk.pos(x), criado: x.criado || 0 } });
}
// o selo muda na hora em todo lugar onde a pessoa aparece
function espalhaSelo(conta){
  for (const j of jogadores.values()){
    if (!j.conta || j.conta.id !== conta.id) continue;
    if (j.con) j.con.envia({ t: 'selo', vf: !!conta.verif });
    const s = j.sala, mb = membroDe(s, j.id);
    if (mb){ mb.vf = !!conta.verif; s.suja = true; listaSuja = true; if (s.p){ const pj = s.p.jog.find(x => x.id === j.id); if (pj){ pj.vf = mb.vf; s.elencoSujo = true; } } }
  }
}
function avisaMudo(conta){ const j = jogDaConta(conta.id); if (j && j.con) j.con.envia({ t: 'mudo', ate: mudo(conta) ? conta.mudoAte : 0, motivo: mudo(conta) ? conta.mudoMotivo || '' : '' }); }
function admin(jog, c, m){
  const eu = jog.conta; if (!ehAdmin(eu)) return erro(jog, 'proibido', 'Só admin pode fazer isso');
  const resp = o => c.envia(Object.assign({ t: 'admin' }, o));
  const alvo = Contas.porId.get(m.id | 0);
  switch (m.acao){
    case 'busca': {
      const q = limpaTexto(m.q, 20), n = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : 0, mq = usuarioMin(q);
      let l;
      if (n) l = Contas.porId.has(n) ? [Contas.porId.get(n)] : [];
      else l = Contas.d.contas.filter(x => !mq || x.min.includes(mq)).sort((a, b) => (a.min.startsWith(mq) ? 0 : 1) - (b.min.startsWith(mq) ? 0 : 1) || a.id - b.id).slice(0, 40);
      return resp({ acao: 'busca', q, lista: l.map(contaAdm) });
    }
    case 'lista': {
      if (m.tipo === 'historico') return resp({ acao: 'lista', tipo: 'historico', lista: Contas.d.adm.slice(-80).reverse() });
      const l = Contas.d.contas.filter(x => m.tipo === 'verificados' ? x.verif : mudo(x)).slice(0, 300).map(contaAdm);
      return resp({ acao: 'lista', tipo: m.tipo === 'verificados' ? 'verificados' : 'mudos', lista: l });
    }
    case 'verificar': {
      if (!alvo) return erro(jog, 'naoExiste', 'Conta não encontrada');
      const sim = !!m.sim;
      if (!!alvo.verif !== sim){ alvo.verif = sim; Contas.salva(); registra(eu, sim ? 'verificou' : 'tirouVerificado', alvo); espalhaSelo(alvo); }
      return resp({ acao: 'ok', conta: contaAdm(alvo), tx: sim ? `${alvo.usuario} agora é verificado` : `${alvo.usuario} não é mais verificado` });
    }
    case 'mutar': {
      if (!alvo) return erro(jog, 'naoExiste', 'Conta não encontrada');
      if (alvo.id === eu.id) return erro(jog, 'proibido', 'Você não pode tirar o seu próprio chat');
      if (alvo.id === 1 || (ehAdmin(alvo) && eu.id !== 1)) return erro(jog, 'proibido', 'Não dá para tirar o chat de um admin');
      const min = [10, 60, 1440, 10080, 0].includes(m.min | 0) ? m.min | 0 : 60;
      alvo.mudoAte = min ? Date.now() + min * 60000 : PARA_SEMPRE; alvo.mudoMotivo = limpaTexto(m.motivo, 60);
      Contas.salva(); registra(eu, 'mutou', alvo, min); avisaMudo(alvo);
      return resp({ acao: 'ok', conta: contaAdm(alvo), tx: `${alvo.usuario} ficou sem chat` });
    }
    case 'desmutar': {
      if (!alvo) return erro(jog, 'naoExiste', 'Conta não encontrada');
      if (mudo(alvo)){ alvo.mudoAte = 0; alvo.mudoMotivo = ''; Contas.salva(); registra(eu, 'desmutou', alvo); avisaMudo(alvo); }
      return resp({ acao: 'ok', conta: contaAdm(alvo), tx: `${alvo.usuario} pode falar no chat de novo` });
    }
    // mexer nos números do ranking (gols, assistências, melhor da partida): aparece no perfil e no ranking
    case 'ajustar': {
      if (!alvo) return erro(jog, 'naoExiste', 'Conta não encontrada');
      const d = {}; for (const k of ['g', 'a', 'm']){ const v = Math.trunc(+m[k] || 0); if (v) d[k] = clamp(v, -99999, 99999); }
      if (!Object.keys(d).length) return resp({ acao: 'ok', conta: contaAdm(alvo), tx: 'Nada mudou' });
      alvo.rk = rkLimpo(alvo.rk); alvo.rkAdm = alvo.rkAdm || { g: 0, a: 0, m: 0 };
      for (const k in d){ const antes = alvo.rk[k]; alvo.rk[k] = Math.max(0, antes + d[k]); d[k] = alvo.rk[k] - antes; alvo.rkAdm[k] = (alvo.rkAdm[k] | 0) + d[k]; }
      Rk.muda(); Contas.salva(); registra(eu, 'ajustou', alvo, null, d); Rk.avisa(alvo);
      return resp({ acao: 'ok', conta: contaAdm(alvo), tx: `Números de ${alvo.usuario}: ${alvo.rk.g} gols · ${alvo.rk.a} assist. · ${alvo.rk.m}× melhor da partida` });
    }
  }
}
// muitas tentativas erradas seguram o login por uns minutos
const tentativas = new Map();
function travado(k){ const t = tentativas.get(k); return !!(t && t.n >= 8 && t.ate > Date.now()); }
function errou(k){ const t = tentativas.get(k) || { n: 0, ate: 0 }; if (t.ate < Date.now()) t.n = 0; t.n++; t.ate = Date.now() + 5 * 60e3; tentativas.set(k, t); }
function dadosLimpos(d){
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  let t; try { t = JSON.stringify(d); } catch (_) { return null; }
  return t.length <= 24000 ? JSON.parse(t) : null;
}
const stZ = () => ({ j: 0, v: 0, g: 0, a: 0, m: 0 });

function criaOficiais(){
  if (!CONFIG.oficiais) return;
  for (const modo of [1, 2, 3, 4]){
    const n = [...salas.values()].filter(s => s.tipo === 'oficial' && s.cfg.modo === modo).length;
    if (!n) new Sala({ nome: `Oficial ${modo}v${modo}`, tipo: 'oficial', cfg: { modo, tempo: 3, gols: 5 } });
  }
}
function resumos(){ return [...salas.values()].map(resumoSala); }
function online(){ return [...jogadores.values()].filter(j => j.con).length; }
function mandaLista(c){ c.envia({ t: 'salas', lista: resumos(), online: online() }); }

// ------------------------------------------------------------------ mensagens
const PRECISA_CONTA = { criar: 1, entrar: 1, rapido: 1, cmd: 1, ajustes: 1, chat: 1, in: 1 };
function mensagem(c, m){
  if (m.t === 'oi') return oi(c, m);
  const jog = c.jog; if (!jog) return;
  if (PRECISA_CONTA[m.t] && !jog.conta){ if (m.t !== 'in') erro(jog, 'precisaConta', 'Entre na sua conta para jogar online'); return; }
  switch (m.t){
    case 'cadastro': cadastro(jog, c, m); break;
    case 'login': entrarConta(jog, c, m); break;
    case 'sairConta': sairConta(jog, c); break;
    case 'salvar': if (jog.conta){ const d = dadosLimpos(m.dados); if (d) Contas.guardaPerfil(jog.conta.id, d); } break;
    case 'trocarSenha': trocarSenha(jog, c, m); break;
    case 'renomear': renomear(jog, c, m); break;
    case 'admin': admin(jog, c, m); break;
    case 'ranking': ranking(jog, c, m); break;
    case 'perfilDe': perfilDe(jog, c, m); break;
    case 'ping': c.envia({ t: 'pong', c: typeof m.c === 'number' ? m.c : 0, s: agoraMs() }); break;
    case 'perfil': perfil(jog, m); break;
    case 'salas': mandaLista(c); break;
    case 'online': c.envia({ t: 'online', lista: [...jogadores.values()].filter(j => j.con && j.conta).slice(0, 200).map(j => ({ id: j.id, cid: j.conta.id, vf: vfDe(j), nome: j.nome, visual: j.visual, sala: j.sala && !j.sala.senha ? j.sala.nome : '', tranca: !!(j.sala && j.sala.senha), salaId: j.sala && !j.sala.senha ? j.sala.id : '' })) }); break;
    case 'criar': criar(jog, m); break;
    case 'entrar': entrar(jog, m); break;
    case 'rapido': rapido(jog, m); break;
    case 'sair': sair(jog, 'voce'); break;
    case 'cmd': comando(jog, m); break;
    case 'ajustes': ajustes(jog, m); break;
    case 'chat': chat(jog, c, m); break;
    case 'dig': { const s = jog.sala; if (s && membroDe(s, jog.id)) s.manda({ t: 'dig', id: jog.id, on: m.on ? 1 : 0 }); break; }
    case 'pulaRep': pulaReplay(jog); break;
    case 'in': entrada(jog, m); break;
  }
}
function oi(c, m){
  if (m.v !== PROTO){ c.envia({ t: 'erro', cod: 'versao', tx: 'Versão diferente do servidor' }); c.fecha(1000); return; }
  if (c.jog) return perfil(c.jog, m);
  const token = typeof m.token === 'string' && /^[a-z0-9]{16,40}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
  let jog = porToken.get(token);
  if (jog && jog.con && jog.con !== c){ const velha = jog.con; velha.jog = null; velha.fecha(4000); }
  if (!jog){
    if (jogadores.size >= CONFIG.maxJogadores){ c.envia({ t: 'erro', cod: 'cheio', tx: 'O servidor está lotado' }); c.fecha(1013); return; }
    jog = { id: novoId(), token, con: null, nome: 'Jogador', visual: visualLimpo(null), mira: true, sala: null, sumiu: 0 };
    jogadores.set(jog.id, jog); porToken.set(token, jog);
  }
  jog.con = c; c.jog = jog; jog.sumiu = 0;
  perfil(jog, m, true);
  c.envia({ t: 'bemvindo', id: jog.id, nome: CONFIG.nome, regiao: CONFIG.regiao, v: PROTO, chat: { brasil: chatGeral.brasil.slice(-40), global: chatGeral.global.slice(-40) } });
  // voltou sem o login (saiu da conta ou limpou o aparelho): não continua dentro da conta
  if (jog.conta && m.sessao !== jog.tokenConta){ if (jog.sala) sair(jog, null); jog.conta = null; jog.tokenConta = null; jog.nome = nomeJogador(m.nome); }
  const s = jog.sala;
  // login salvo: entra sozinho na conta
  if (typeof m.sessao === 'string' && m.sessao){
    const conta = Contas.daSessao(m.sessao);
    if (conta) logou(jog, conta, true, false, m.sessao);
    else { if (jog.conta && jog.tokenConta === m.sessao){ jog.conta = null; jog.tokenConta = null; } c.envia({ t: 'semConta', motivo: 'sessao' }); }
  }
  if (s && jog.sala === s){
    const mb = membroDe(s, jog.id); if (mb){ mb.volta = false; s.suja = true; }
    c.envia({ t: 'sala', sala: s.estado() });
    if (s.p) c.envia(partidaMsg(s));
  }
  mandaLista(c); listaSuja = true;
}
// a conta só fica aberta num aparelho por vez
function logou(jog, conta, lembrar, novo, tokenVelho){
  for (const o of [...jogadores.values()]){
    if (o === jog || !o.conta || o.conta.id !== conta.id) continue;
    if (o.sala) sair(o, null);
    o.conta = null; o.tokenConta = null;
    if (o.con){ const v = o.con; v.envia({ t: 'erro', cod: 'outroAparelho', tx: 'Sua conta entrou em outro aparelho' }); v.jog = null; o.con = null; v.fecha(4001); }
    jogadores.delete(o.id); porToken.delete(o.token);
  }
  jog.conta = conta; jog.nome = conta.usuario;
  jog.tokenConta = tokenVelho || Contas.abreSessao(conta, lembrar);
  conta.ultimo = Date.now(); Contas.salva();
  const mb = membroDe(jog.sala, jog.id); if (mb){ mb.nome = jog.nome; jog.sala.suja = true; }
  if (!conta.visual && jog.visual){ conta.visual = jog.visual; Contas.salva(); }
  if (mb){ mb.vf = !!conta.verif; jog.sala.suja = true; }
  if (jog.con) jog.con.envia({ t: 'conta', id: conta.id, usuario: conta.usuario, token: jog.tokenConta, dados: novo ? null : Contas.perfil(conta.id), novo: !!novo,
    admin: ehAdmin(conta), vf: !!conta.verif, mudoAte: mudo(conta) ? conta.mudoAte : 0, mudoMotivo: mudo(conta) ? conta.mudoMotivo || '' : '',
    rk: conta.rk, pos: Rk.pos(conta) });
  listaSuja = true;
}
async function cadastro(jog, c, m){
  if (jog.ocupado) return;
  if (jog.conta) return erro(jog, 'jaLogado', 'Saia da conta antes de criar outra');
  const usuario = String(m.usuario == null ? '' : m.usuario).trim(), senha = String(m.senha == null ? '' : m.senha);
  if (!USUARIO_RE.test(usuario)) return erro(jog, 'usuario', 'Use de 3 a 8 letras ou números, sem espaço (pode _ e .)');
  if (senha.length < 6 || senha.length > 64) return erro(jog, 'senha', 'A senha precisa ter de 6 a 64 caracteres');
  const kc = 'cad:' + c.ip; if (travado(kc)) return erro(jog, 'devagar', 'Muitas contas criadas daqui agora. Tente mais tarde');
  jog.ocupado = true;
  try {
    const conta = await Contas.cria(usuario, senha);
    if (!conta) return erro(jog, 'existe', 'Esse nome de usuário já existe');
    Rk.muda();
    errou(kc);                                                     // conta 1 de 8 por 5 minutos
    const d = dadosLimpos(m.dados); if (d) Contas.guardaPerfil(conta.id, d);
    logou(jog, conta, m.lembrar !== false, true);
  } catch (e) { log('erro no cadastro', e && e.message); erro(jog, 'erro', 'Não deu para criar a conta agora'); }
  finally { jog.ocupado = false; }
}
async function entrarConta(jog, c, m){
  if (jog.ocupado) return;
  const usuario = String(m.usuario == null ? '' : m.usuario).trim().slice(0, 32), senha = String(m.senha == null ? '' : m.senha).slice(0, 64);
  const kIp = 'ip:' + c.ip, kU = 'u:' + usuarioMin(usuario);
  if (travado(kIp) || travado(kU)) return erro(jog, 'devagar', 'Muitas tentativas erradas. Espere uns minutos');
  jog.ocupado = true;
  try {
    const conta = await Contas.confere(usuario, senha);
    if (!conta){ errou(kIp); errou(kU); return erro(jog, 'senhaErrada', 'Usuário ou senha errados'); }
    tentativas.delete(kU);
    if (jog.conta && jog.conta.id !== conta.id){ if (jog.sala) sair(jog, 'voce'); if (jog.tokenConta) Contas.fechaSessao(jog.tokenConta); }
    logou(jog, conta, m.lembrar !== false, false);
  } catch (e) { log('erro no login', e && e.message); erro(jog, 'erro', 'Não deu para entrar agora'); }
  finally { jog.ocupado = false; }
}
function sairConta(jog, c){
  if (!jog.conta) return;
  if (jog.sala) sair(jog, 'voce');
  Contas.fechaSessao(jog.tokenConta);
  jog.conta = null; jog.tokenConta = null; jog.nome = 'Jogador';
  c.envia({ t: 'semConta', motivo: 'saiu' }); listaSuja = true;
}
// nome antigo com mais de 8 letras: a pessoa escolhe um novo (o ID e o progresso continuam)
function renomear(jog, c, m){
  const conta = jog.conta; if (!conta) return erro(jog, 'precisaConta', 'Entre na sua conta');
  if (Array.from(conta.usuario).length <= USUARIO_MAX) return erro(jog, 'proibido', 'O seu nome já está certo');
  const novo = String(m.novo == null ? '' : m.novo).trim();
  if (!USUARIO_RE.test(novo)) return erro(jog, 'usuario', 'Use de 3 a 8 letras ou números, sem espaço (pode _ e .)');
  const min = usuarioMin(novo), outra = Contas.porMin.get(min);
  if (outra && outra !== conta) return erro(jog, 'existe', 'Esse nome de usuário já existe');
  Contas.porMin.delete(conta.min); conta.usuario = novo; conta.min = min; Contas.porMin.set(min, conta); Contas.salva();
  jog.nome = novo;
  const mb = membroDe(jog.sala, jog.id); if (mb){ mb.nome = novo; jog.sala.suja = true; if (jog.sala.p){ const pj = jog.sala.p.jog.find(x => x.id === jog.id); if (pj){ pj.nome = novo; jog.sala.elencoSujo = true; } } }
  listaSuja = true; log(`conta #${conta.id} agora se chama ${novo}`);
  c.envia({ t: 'renomeou', usuario: novo });
}
async function trocarSenha(jog, c, m){
  if (!jog.conta || jog.ocupado) return;
  const nova = String(m.nova == null ? '' : m.nova);
  if (nova.length < 6 || nova.length > 64) return erro(jog, 'senha', 'A senha nova precisa ter de 6 a 64 caracteres');
  const kIp = 'ip:' + c.ip; if (travado(kIp)) return erro(jog, 'devagar', 'Muitas tentativas erradas. Espere uns minutos');
  jog.ocupado = true;
  try {
    const ok = await Contas.confere(jog.conta.usuario, String(m.atual == null ? '' : m.atual).slice(0, 64));
    if (!ok || ok.id !== jog.conta.id){ errou(kIp); return erro(jog, 'senhaErrada', 'A senha atual está errada'); }
    await Contas.novaSenha(jog.conta, nova);
    Contas.fechaOutras(jog.conta, jog.tokenConta);                 // os outros aparelhos precisam entrar de novo
    c.envia({ t: 'senhaOk' });
  } catch (e) { log('erro trocando a senha', e && e.message); erro(jog, 'erro', 'Não deu para trocar a senha agora'); }
  finally { jog.ocupado = false; }
}
function perfil(jog, m, quieto){
  jog.nome = jog.conta ? jog.conta.usuario : nomeJogador(m.nome); jog.visual = visualLimpo(m.visual); jog.mira = m.mira !== false;
  if (jog.conta && JSON.stringify(jog.conta.visual) !== JSON.stringify(jog.visual)){ jog.conta.visual = jog.visual; Contas.salva(); }
  const s = jog.sala, mb = membroDe(s, jog.id);
  if (mb){ mb.nome = jog.nome; mb.visual = jog.visual; s.suja = true; if (s.p){ const j = s.p.jog.find(x => x.id === jog.id); if (j){ j.nome = jog.nome; j.visual = jog.visual; j.mira = jog.mira; s.elencoSujo = true; } } }
  if (!quieto) listaSuja = true;
}
function erro(jog, cod, tx){ if (jog.con) jog.con.envia({ t: 'erro', cod, tx }); }

function criar(jog, m){
  const nome = nomeSala(m.nome); if (!nome) return erro(jog, 'nome', `O nome precisa de ${SALA.nomeMin} a ${SALA.nomeMax} letras`);
  if ([...salas.values()].filter(s => s.tipo === 'pers').length >= CONFIG.maxSalas) return erro(jog, 'limite', 'Muitas salas abertas agora. Tente entrar numa.');
  sair(jog, null, true);
  const s = new Sala({ nome, senha: senhaLimpa(m.senha), cfg: m.cfg, tipo: 'pers', dono: jog.id });
  poeNaSala(jog, s, 0);
  log(`sala criada "${s.nome}" (${s.id}) por ${jog.nome}`);
}
function poeNaSala(jog, s, time){
  const mb = { id: jog.id, nome: jog.nome, visual: jog.visual, vf: vfDe(jog), time, bot: null, jog, st: stZ(), volta: false, desde: agoraMs() };
  s.membros.push(mb); jog.sala = s; s.suja = true; listaSuja = true;
  if (jog.con) jog.con.envia({ t: 'sala', sala: s.estado() });
  s.sis(`${jog.nome} entrou na sala`);
  if (s.p){
    if (time !== ESPECTADOR) adicionaNaPartida(s, mb);
    if (jog.con) jog.con.envia(partidaMsg(s));
  }
}
function entrar(jog, m){
  const s = salas.get(String(m.id || ''));
  if (!s) return erro(jog, 'naoExiste', 'Essa sala não existe mais');
  if (jog.sala === s){ if (jog.con) jog.con.envia({ t: 'sala', sala: s.estado() }); return; }
  if (s.expulsos.has(jog.token)) return erro(jog, 'expulso', 'Você foi expulso dessa sala');
  if (s.senha && senhaLimpa(m.senha) !== s.senha) return erro(jog, 'senha', m.senha ? 'Senha errada' : 'Essa sala tem senha');
  let time = m.assistir ? ESPECTADOR : timeQueEntra(s);
  if (s.status === 'jogo' && s.tipo === 'oficial') time = ESPECTADOR;
  if (time === ESPECTADOR && s.membros.filter(x => x.time === ESPECTADOR).length >= SALA.espMax) return erro(jog, 'cheia', 'A sala está cheia');
  sair(jog, null, true);
  poeNaSala(jog, s, time);
}
function rapido(jog, m){
  const modo = SALA.modos.includes(+m.modo) ? +m.modo : 2;
  const livres = [...salas.values()].filter(s => !s.senha && !s.expulsos.has(jog.token) && s !== jog.sala && (vagasTime(s, 0) > 0 || vagasTime(s, 1) > 0));
  livres.sort((a, b) => (b.cfg.modo === modo) - (a.cfg.modo === modo) || (a.status === 'espera' ? 0 : 1) - (b.status === 'espera' ? 0 : 1) || contaSala(b).jog - contaSala(a).jog);
  let s = livres[0];
  if (!s && CONFIG.oficiais){ s = new Sala({ nome: `Oficial ${modo}v${modo} #${[...salas.values()].filter(x => x.tipo === 'oficial' && x.cfg.modo === modo).length + 1}`, tipo: 'oficial', cfg: { modo, tempo: 3, gols: 5 } }); }
  if (!s) return erro(jog, 'nenhuma', 'Nenhuma sala aberta agora: crie a sua e chame a galera!');
  entrar(jog, { id: s.id, senha: s.senha });
}
function sair(jog, motivo, quieto){
  const s = jog.sala; if (!s) return;
  const mb = membroDe(s, jog.id);
  s.membros = s.membros.filter(x => x.id !== jog.id); jog.sala = null;
  if (s.p && mb) tiraDaPartida(s, mb);
  if (jog.con && motivo) jog.con.envia({ t: 'saiu', motivo });
  if (s.dono === jog.id){ const h = s.humanos().sort((a, b) => a.desde - b.desde)[0]; s.dono = h ? h.id : null; if (h) s.sis(`${h.nome} agora é o dono da sala`); }
  if (mb && s.membros.length) s.sis(`${mb.nome} saiu da sala`);
  if (s.tipo === 'pers' && !s.humanos().length){ fechaSala(s); }
  s.suja = true; listaSuja = true;
  if (jog.con && motivo) mandaLista(jog.con);
}
function fechaSala(s){
  for (const m of s.membros) if (m.jog){ m.jog.sala = null; if (m.jog.con) m.jog.con.envia({ t: 'saiu', motivo: 'fechou' }); }
  s.membros = []; s.p = null; salas.delete(s.id); listaSuja = true;
  log(`sala fechada "${s.nome}" (${s.id})`);
}
function caiu(jog, con){
  if (jog.con !== con) return;
  jog.con = null; jog.sumiu = agoraMs();
  const mb = membroDe(jog.sala, jog.id); if (mb){ mb.volta = true; jog.sala.suja = true; }
  if (jog.sala && jog.sala.p){ const j = jog.sala.p.jog.find(x => x.id === jog.id); if (j){ j.mx = j.my = 0; j.kD = j.pD = false; } }
  listaSuja = true;
}

// ------------------------------------------------------------------ comandos dentro da sala
function comando(jog, m){
  const s = jog.sala; if (!s) return;
  const dono = s.dono === jog.id, alvo = membroDe(s, m.alvo);
  switch (m.c){
    case 'time': {
      const t = +m.time; if (!alvo || ![0, 1, 2].includes(t) || alvo.time === t) return;
      if (alvo.id !== jog.id && !dono) return erro(jog, 'proibido', 'Só o dono move os outros');
      if (t !== ESPECTADOR){
        if (vagasTime(s, t) <= 0) return erro(jog, 'cheia', `O ${NOMES_TIME[t]} está cheio`);
        if (s.status === 'jogo' && !dono && !(s.cfg && s.cfg.trocaJogo)) return erro(jog, 'jogo', 'Espere a partida acabar');   // (com a opção ligada, cada um se mexe sozinho)
      } else if (s.membros.filter(x => x.time === ESPECTADOR).length >= SALA.espMax) return erro(jog, 'cheia', 'Não cabe mais ninguém assistindo');
      const antes = alvo.time; alvo.time = t; s.suja = true; listaSuja = true;
      if (s.p){ if (antes !== ESPECTADOR) tiraDaPartida(s, alvo); if (t !== ESPECTADOR) adicionaNaPartida(s, alvo); }
      return;
    }
    case 'bot': {
      if (!dono || s.tipo === 'oficial') return erro(jog, 'proibido', 'Só o dono põe bots');
      const t = +m.time; if (![0, 1].includes(t) || vagasTime(s, t) <= 0) return erro(jog, 'cheia', 'Esse time está cheio');
      const usados = new Set(s.membros.filter(x => x.time === t).map(x => x.visual.texto));
      const num = ['7', '9', '10', '11', '8', '5', '3', '4'].find(n => !usados.has(n)) || '99';
      const b = { id: novoId(), nome: nomeDeBot(s), visual: { desenho: 'padrao', texto: num, cor: 'time' }, time: t, bot: clamp(m.dif | 0, 0, 3), jog: null, st: stZ(), volta: false, desde: agoraMs() };
      s.membros.push(b); s.suja = true; listaSuja = true; s.sis(`${b.nome} (bot ${DIF_NOME[b.bot]}) entrou no ${NOMES_TIME[t]}`);
      if (s.p) adicionaNaPartida(s, b);
      return;
    }
    case 'botDif': if (dono && alvo && alvo.bot != null){ alvo.bot = clamp(m.dif | 0, 0, 3); s.suja = true; if (s.p){ const j = s.p.jog.find(x => x.id === alvo.id); if (j && j.bot) j.bot = new Bot(j, alvo.bot); } } return;
    case 'expulsar': {
      if (!dono || !alvo || alvo.id === jog.id) return;
      if (alvo.bot != null){ s.membros = s.membros.filter(x => x !== alvo); if (s.p) tiraDaPartida(s, alvo); s.suja = true; listaSuja = true; s.sis(`${alvo.nome} saiu da sala`); return; }
      s.expulsos.add(alvo.jog.token); s.sis(`${alvo.nome} foi expulso`); sair(alvo.jog, 'expulso'); return;
    }
    case 'dono': if (dono && alvo && alvo.bot == null && alvo.id !== jog.id){ s.dono = alvo.id; s.suja = true; s.sis(`${alvo.nome} agora é o dono da sala`); } return;
    case 'comecar':
      if (!dono || s.tipo === 'oficial') return;
      if (s.status !== 'espera') return;
      if (!s.membros.some(x => x.time === 0) || !s.membros.some(x => x.time === 1)) return erro(jog, 'times', 'Precisa de pelo menos um jogador em cada time');
      comecaPartida(s); return;
    case 'parar': if (dono && s.p) paraPartida(s, `${jog.nome} parou a partida`); return;
    case 'pausar': case 'continuar':
      if (!dono || !s.p) return;
      s.pausada = m.c === 'pausar'; s.suja = true;
      s.manda({ t: 'pausa', on: s.pausada, por: jog.nome }); return;
  }
}
function ajustes(jog, m){
  const s = jog.sala; if (!s || s.dono !== jog.id) return erro(jog, 'proibido', 'Só o dono muda os ajustes');
  if (s.status !== 'espera') return erro(jog, 'jogo', 'Pare a partida para mudar os ajustes');
  const nome = nomeSala(m.nome); if (!nome) return erro(jog, 'nome', `O nome precisa de ${SALA.nomeMin} a ${SALA.nomeMax} letras`);
  s.nome = nome; s.cfg = cfgSala(m.cfg);
  const sh = m.senha || {};
  if (sh.modo === 'trocar' && senhaLimpa(sh.valor)) s.senha = senhaLimpa(sh.valor); else if (sh.modo === 'tirar') s.senha = '';
  for (const t of [0, 1]){                     // diminuiu o modo: quem sobra vai assistir (bots saem)
    let extra = -vagasTime(s, t);
    for (let i = s.membros.length - 1; i >= 0 && extra > 0; i--){ const x = s.membros[i]; if (x.time !== t) continue; if (x.bot != null) s.membros.splice(i, 1); else x.time = ESPECTADOR; extra--; }
  }
  s.suja = true; listaSuja = true; s.sis('O dono mudou os ajustes da sala');
}
function chat(jog, c, m){
  const texto = limpaTexto(m.texto, SALA.chatMax); if (!texto) return;
  if (mudo(jog.conta)) return c.envia({ t: 'erro', cod: 'mudo', tx: 'Você está sem chat', ate: jog.conta.mudoAte, motivo: jog.conta.mudoMotivo || '' });
  const t = agoraMs(); if (t - c.chatT < 700) return c.envia({ t: 'erro', cod: 'chatRapido', tx: 'Calma! Espere um pouquinho para mandar outra' }); c.chatT = t;
  const cid = jog.conta ? jog.conta.id : null, vf = vfDe(jog);
  if (m.canal === 'sala'){ const s = jog.sala; if (!s) return; const mb = membroDe(s, jog.id); s.manda({ t: 'chat', canal: 'sala', de: jog.nome, cid, vf, texto, time: mb ? mb.time : 2 }); return; }
  if (m.canal !== 'brasil' && m.canal !== 'global') return;
  const msg = { t: 'chat', canal: m.canal, de: jog.nome, cid, vf, texto }, l = chatGeral[m.canal];
  l.push(msg); if (l.length > 80) l.shift();
  const s = JSON.stringify(msg); for (const x of conexoes) if (x.jog) x.envia(s);
}

// ------------------------------------------------------------------ a partida (o servidor é o juiz)
const elenco = s => s.p.jog.map(j => ({ id: j.id, time: j.time, nome: j.nome, visual: j.visual, bot: !!j.bot, vf: !!j.vf }));
const partidaMsg = s => ({ t: 'partida', cfg: s.cfg, jog: elenco(s), placar: s.placar, tempo: Math.max(0, r1(s.tempo)), fase: s.fase, ouro: s.ouro, pausada: s.pausada });
function jogDe(s, mb){
  const j = new Jog(mb.id, mb.time, mb.nome, mb.visual, mb.bot == null);
  if (mb.bot != null) j.bot = new Bot(j, mb.bot);
  j.mira = mb.jog ? mb.jog.mira !== false : true; j.vf = !!mb.vf;
  return j;
}
function comecaPartida(s){
  const c = s.cfg, p = new Partida({ n: c.modo, arena: c.campo, jogab: c.jogab });
  for (const t of [0, 1]) for (const mb of s.membros.filter(x => x.time === t)) p.add(jogDe(s, mb));
  p.saida(); for (const j of p.jog) j.travado = true;
  Object.assign(s, { p, status: 'jogo', placar: [0, 0], tempo: c.tempo * 60, ouro: false, fase: 'saida', faseT: 0, conta: 0, k: 0, evs: [], pausada: false, saidos: [], suja: true, elencoSujo: false, primeiraSaida: true });
  p.placar = s.placar; listaSuja = true;
  s.manda(partidaMsg(s));
  log(`partida começou em "${s.nome}" (${c.modo}v${c.modo})`);
}
function adicionaNaPartida(s, mb){
  const p = s.p; if (!p || p.jog.some(j => j.id === mb.id)) return;
  const j = jogDe(s, mb), W2 = p.W / 2;
  j.x = (mb.time === 0 ? -1 : 1) * W2 * .5; j.y = (Math.random() - .5) * p.H * .5; j.px = j.x; j.py = j.y;
  j.travado = s.fase === 'saida';
  p.add(j); s.elencoSujo = true;
}
function tiraDaPartida(s, mb){
  const p = s.p; if (!p) return;
  const j = p.jog.find(x => x.id === mb.id); if (!j) return;
  s.saidos.push(j); p.jog = p.jog.filter(x => x !== j); s.elencoSujo = true;
  for (const tq of p.toques) if (tq.j === j) tq.j = null;
  p.toques = p.toques.filter(tq => tq.j);
  if (!p.jog.some(x => x.time === 0) || !p.jog.some(x => x.time === 1)) setImmediate(() => { if (s.p === p) paraPartida(s, 'Um dos times ficou vazio: partida parada'); });
}
// todo mundo pulou o replay → a partida volta na hora (sem esperar os 4,6 s)
function pulaReplay(jog){
  const s = jog.sala; if (!s || !s.p || s.fase !== 'replay') return;
  s.pulaRep = s.pulaRep || new Set();
  if (s.pulaRep.has(jog.id)) return;
  s.pulaRep.add(jog.id);
  const jogs = s.membros.filter(m => m.jog && m.bot == null && m.time !== ESPECTADOR);
  const n = jogs.filter(m => s.pulaRep.has(m.id)).length;
  if (jogs.length > 1) s.manda({ t: 'pulaRep', tx: `${jog.nome} pulou o replay (${n}/${jogs.length})` });
  if (jogs.length && n >= jogs.length) s.faseT = 99;   // todos pularam: acelera a fase
}

function paraPartida(s, tx){
  if (!s.p) return;
  s.p = null; s.status = 'espera'; s.fase = null; s.pausada = false; s.suja = true; listaSuja = true; s.autoT = 0;
  s.manda({ t: 'fim', parada: true, placar: s.placar, tx });
  if (tx) s.sis(tx);
}
function evRede(s, ev){
  const o = { tipo: ev.tipo, x: r1(ev.x || 0), y: r1(ev.y || 0) };
  if (ev.j) o.j = ev.j.id;
  if (ev.imp != null) o.imp = Math.round(ev.imp);
  if (ev.tipo === 'chute'){ o.k = ev.k; o.f = Math.round(ev.f); o.nx = r2(ev.nx); o.ny = r2(ev.ny); }
  if (ev.tipo === 'gol'){ o.time = ev.time; o.autor = ev.autor ? ev.autor.id : null; o.assist = ev.assist ? ev.assist.id : null; o.contra = !!ev.contra; o.forte = !!ev.forte; o.pl = s.placar.slice(); }
  return o;
}
function mudaFase(s, f){ s.fase = f; s.faseT = 0; s.manda({ t: 'fase', f }); }
function acabou(s){ const g = s.cfg.gols; return s.ouro || (g > 0 && (s.placar[0] >= g || s.placar[1] >= g)); }
const CONTA = [[1.7, 3], [2.35, 2], [3.0, 1], [3.65, 0]], CONTA2 = [[.2, 2], [.8, 1], [1.4, 0]];
function passoSala(s, dt){
  const p = s.p; if (!p) return;
  s.k++;
  if (s.elencoSujo){ s.elencoSujo = false; s.manda({ t: 'elenco', jog: elenco(s) }); }
  if (!s.pausada){
    s.faseT += dt;
    if (s.fase === 'saida'){
      const passos = s.primeiraSaida ? CONTA : CONTA2;
      while (s.conta < passos.length && s.faseT >= passos[s.conta][0]){
        const n = passos[s.conta++][1]; s.manda({ t: 'contagem', n });
        if (!n){ for (const j of p.jog) j.travado = false; mudaFase(s, 'jogo'); s.primeiraSaida = false; }
      }
    }
    if (s.fase === 'saida' || s.fase === 'jogo' || s.fase === 'gol'){
      IA.registra(p); IA.papeis(p, 0, dt); IA.papeis(p, 1, dt);
      for (const j of p.jog) if (j.bot) j.bot.pensa(p, dt);
      p.passo(dt);
      for (const ev of p.ev){
        if (ev.tipo === 'gol'){ s.placar = p.placar; s.evs.push(evRede(s, ev)); mudaFase(s, 'gol'); }
        else s.evs.push(evRede(s, ev));
      }
      p.ev.length = 0;
    }
    if (s.fase === 'jogo' && !s.ouro){
      s.tempo -= dt;
      if (s.tempo <= 0){ s.tempo = 0; if (s.placar[0] === s.placar[1] && s.cfg.ouro) s.ouro = true; else return fimPartida(s); }
    }
    if (s.fase === 'gol' && s.faseT > 2.4){
      if (CONFIG.replay){ s.pulaRep = new Set(); mudaFase(s, 'replay'); }
      else if (acabou(s)) return fimPartida(s);
      else { p.saida(); IA.reset(p); for (const j of p.jog) j.travado = true; p.golLigado = true; p.toques.length = 0; s.conta = 0; mudaFase(s, 'saida'); }
    }
    if (s.fase === 'replay' && s.faseT > 4.6){
      if (acabou(s)) return fimPartida(s);
      p.saida(); IA.reset(p); for (const j of p.jog){ j.travado = true; if (j.bot) j.bot.solta(); } p.golLigado = true; p.toques.length = 0; s.conta = 0; mudaFase(s, 'saida');
    }
  }
  // 30 fotos por segundo
  if (s.k % 2 === 0){
    const f = p.foto();
    const msg = { t: 'q', k: s.k, b: f.b, d: f.d, pl: s.placar, tm: r1(Math.max(0, s.tempo)), o: s.ouro ? 1 : 0 };
    if (s.evs.length){ msg.e = s.evs; s.evs = []; }
    s.manda(msg);
  }
}
function fimPartida(s){
  const p = s.p; if (!p) return;
  const [a, b] = s.placar, todos = [...p.jog, ...s.saidos];
  const st = todos.map(j => ({ id: j.id, nome: j.nome, vf: !!j.vf, bot: !!j.bot, time: j.time, gols: j.st.gols, assist: j.st.assist, chutes: j.st.chutes, toques: j.st.toques, passes: j.st.passes, fortes: j.st.fortes, contra: j.st.contra | 0 }));
  // o melhor da partida (entre todo mundo que jogou, bots também)
  const melhor = melhorDaPartida(todos.map(j => ({ id: j.id, time: j.time, st: j.st })), [a, b]);
  for (const j of p.jog){ const mb = membroDe(s, j.id); if (!mb) continue; mb.st.j++; if ((j.time === 0 && a > b) || (j.time === 1 && b > a)) mb.st.v++; mb.st.g += j.st.gols; mb.st.a += j.st.assist; if (melhor && melhor.id === j.id) mb.st.m = (mb.st.m | 0) + 1; }
  // RANKING: vale quando os dois times terminam com gente de verdade (com conta). Quem saiu no meio leva os gols que fez.
  const contaDe = j => { const jg = jogadores.get(j.id); return !j.bot && jg && jg.conta ? jg.conta : null; };
  const vale = [0, 1].every(t => p.jog.some(j => j.time === t && contaDe(j)));
  if (vale){
    for (const j of todos){
      const c = contaDe(j); if (!c) continue;
      const r = c.rk = rkLimpo(c.rk), ficou = p.jog.includes(j);
      if (ficou){ r.j++; if ((j.time === 0 && a > b) || (j.time === 1 && b > a)) r.v++; }
      r.g += j.st.gols; r.a += j.st.assist; if (melhor && melhor.id === j.id) r.m++;
    }
    Rk.muda(); Contas.salva();
    for (const j of todos){ const c = contaDe(j); if (c) Rk.avisa(c); }
  }
  s.hist.unshift([a, b]); s.hist = s.hist.slice(0, 10);
  s.p = null; s.status = 'espera'; s.fase = null; s.pausada = false; s.suja = true; listaSuja = true; s.autoT = 0;
  s.manda({ t: 'fim', placar: [a, b], st, melhor: melhor ? melhor.id : null, vale });
  s.sis(`Fim de jogo: VERMELHO ${a} × ${b} AZUL`);
  log(`partida acabou em "${s.nome}": ${a} × ${b}`);
  if (s.tipo === 'oficial') rodizio(s);
}
// salas oficiais: quem estava assistindo entra no lugar de quem saiu, e a partida começa sozinha
function rodizio(s){
  for (const mb of s.membros.filter(x => x.time === ESPECTADOR && x.bot == null).sort((a, b) => a.desde - b.desde)){
    const t = timeQueEntra(s); if (t === ESPECTADOR) break; mb.time = t;
  }
  s.suja = true;
}
function autoOficial(s, dt){
  if (s.tipo !== 'oficial' || s.p) return;
  const temA = s.membros.some(x => x.time === 0 && x.jog && x.jog.con), temB = s.membros.some(x => x.time === 1 && x.jog && x.jog.con);
  if (!temA || !temB){
    if (s.status !== 'espera'){ s.status = 'espera'; s.suja = true; listaSuja = true; }
    // equilibra: alguém sozinho num time e o outro vazio, com gente assistindo
    if (s.membros.some(x => x.time === ESPECTADOR)) rodizio(s);
    s.autoT = 0; return;
  }
  if (s.status === 'espera'){ s.status = 'comecando'; s.autoT = 0; s.suja = true; listaSuja = true; s.sis('A partida começa em 5 segundos'); }
  s.autoT += dt;
  if (s.autoT >= 5) comecaPartida(s);
}
function entrada(jog, m){
  const s = jog.sala; if (!s || !s.p) return;
  const j = s.p.jog.find(x => x.id === jog.id); if (!j) return;
  let mx = clamp(+m.mx || 0, -1, 1), my = clamp(+m.my || 0, -1, 1); const l = Math.hypot(mx, my); if (l > 1){ mx /= l; my /= l; }
  const kn = m.kn | 0, pn = m.pn | 0, joga = (s.fase === 'jogo' || s.fase === 'gol') && !s.pausada;
  if (j.netK == null){ j.netK = kn; j.netP = pn; }
  if (joga){
    j.mx = mx; j.my = my; j.kD = !!m.k; j.pD = !!m.p;
    if (kn !== j.netK) j.kN++;
    if (pn !== j.netP) j.pN++;
  } else { j.mx = j.my = 0; j.kD = j.pD = false; }
  j.netK = kn; j.netP = pn;
}

// ------------------------------------------------------------------ relógio do servidor
let ultimo = process.hrtime.bigint(), acum = 0, contaSeg = 0;
function laco(){
  const t = process.hrtime.bigint(); let dt = Number(t - ultimo) / 1e9; ultimo = t;
  if (dt > .25) dt = .25;
  acum += dt;
  let n = 0;
  while (acum >= 1 / 60 && n < 8){
    acum -= 1 / 60; n++;
    for (const s of salas.values()){ try { if (s.p) passoSala(s, 1 / 60); else autoOficial(s, 1 / 60); } catch (e) { log('erro na sala', s.id, e && e.stack || e); paraPartida(s, 'Erro no servidor: partida parada'); } }
  }
  if (n >= 8) acum = 0;
  for (const s of salas.values()) if (s.suja){ s.suja = false; s.manda({ t: 'sala', sala: s.estado() }); }
  contaSeg += dt;
  if (contaSeg >= 1){ contaSeg = 0; faxina(); }
  if (listaSuja && (laco.listaT = (laco.listaT || 0) + dt) > .5){
    laco.listaT = 0; listaSuja = false;
    const msg = JSON.stringify({ t: 'salas', lista: resumos(), online: online() });
    for (const c of conexoes) if (c.jog && !c.jog.sala) c.envia(msg);
  }
}
function faxina(){
  const t = agoraMs();
  for (const jog of [...jogadores.values()]){
    if (jog.con || !jog.sumiu) continue;
    if (t - jog.sumiu > CONFIG.voltaSeg * 1000 || !jog.sala){ if (jog.sala) sair(jog, null); jogadores.delete(jog.id); porToken.delete(jog.token); listaSuja = true; }
  }
  for (const c of [...conexoes]){
    if (t - c.ultMsg > 60000 && t - c.pong > 60000){ c.fecha(1001); continue; }
    if (t - c.pong > 20000 && c.vivo) c.frame(9, Buffer.from('p'));
  }
  for (const [k, x] of tentativas) if (x.ate < t) tentativas.delete(k);
  if (Math.random() < .02) Contas.limpaSessoes();
  // oficiais extras (as #2, #3...) que ficaram vazias somem
  for (const s of [...salas.values()]) if (s.tipo === 'oficial' && / #\d+$/.test(s.nome) && !s.membros.length){ salas.delete(s.id); listaSuja = true; }
  criaOficiais();
}

// ------------------------------------------------------------------ HTTP: o jogo, a saúde e o upgrade para WebSocket
let htmlCache = null, htmlMtime = 0;
function html(){
  try { const st = fs.statSync(CONFIG.html); if (!htmlCache || st.mtimeMs !== htmlMtime){ htmlCache = fs.readFileSync(CONFIG.html); htmlMtime = st.mtimeMs; } return htmlCache; }
  catch (_) { return null; }
}
const servidor = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/ginga.html')){
    const h = html();
    if (!h){ res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Coloque o ginga.html na mesma pasta do servidor.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(h); return;
  }
  if (req.method === 'GET' && url === '/saude'){
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, nome: CONFIG.nome, protocolo: PROTO, online: online(), contas: Contas.d.contas.length, salas: salas.size, partidas: [...salas.values()].filter(s => s.p).length })); return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Não encontrado');
});
servidor.on('upgrade', (req, sock) => {
  const url = (req.url || '/').split('?')[0];
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const key = req.headers['sec-websocket-key'];
  if (url !== '/ginga' || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket'){ sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  if ((porIp.get(ip) || 0) >= CONFIG.maxConexoesIp){ sock.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  const aceite = crypto.createHash('sha1').update(key + GUID_WS).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + aceite + '\r\n\r\n');
  new Conexao(sock, ip);
});
Contas.carrega();
criaOficiais();
setInterval(laco, 1000 / 120);
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { log('desligando: salvando as contas…'); Contas.gravaJa(); process.exit(0); });
servidor.listen(CONFIG.porta, () => {
  log(`GINGA no ar: http://localhost:${CONFIG.porta}/  ·  salas em ws://localhost:${CONFIG.porta}/ginga`);
  if (!html()) log(`aviso: não achei ${CONFIG.html} — o jogo não vai abrir pelo navegador, só as salas.`);
});
process.on('uncaughtException', e => log('erro solto:', e && e.stack || e));
