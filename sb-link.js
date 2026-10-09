/* =====================================================================
   STREETBALL · v64 — sb-link.js
   Transporte das salas online pelo SERVIDOR DEDICADO (WebSocket), no lugar do PeerJS.
   - No navegador (servido pelo servidor do jogo): define window.Peer (compatível com a
     interface do PeerJS que o jogo usa), window.SB_DEDICADO = true, os serviços online
     (salas públicas, chat da comunidade) e o ID de membro.
   - No servidor (Node, dentro do jsdom): a fábrica SB_MAKE_PEER é reutilizada com um
     transporte direto em memória; e a FORMAÇÃO AUTOMÁTICA tira o pessoal do banco.
   Protocolo do socket: reg {t:'reg',id} · conn {t:'conn',to} · dados {t:'d',to,m} ·
   fechar conexão {t:'c',to}. O servidor responde com: open · err · conn · conn-ok · d · c.
   ===================================================================== */
(function (root) {
  'use strict';
  function makePeerClass(criarSocket) {
    class Conn {
      constructor(peer, remoto) { this._p = peer; this.peer = remoto; this._h = {}; this._morta = false; }
      on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
      _fire(ev, a) { (this._h[ev] || []).slice().forEach(f => { try { f(a); } catch (_) {} }); }
      send(m) { this._p._send({ t: 'd', to: this.peer, m }); }
      close() { if (this._morta) return; this._morta = true; try { this._p._send({ t: 'c', to: this.peer }); } catch (_) {} }
    }
    return class Peer {
      constructor(id, cfg) {
        if (id && typeof id === 'object') { cfg = id; id = undefined; }
        this.id = id || ('c-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        this._h = {}; this._conns = new Map(); this._morto = false;
        this._sock = criarSocket(m => this._msg(m), () => this._caiu());
        this._sock.abrir(this.id);
      }
      on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
      _fire(ev, a) { (this._h[ev] || []).slice().forEach(f => { try { f(a); } catch (_) {} }); }
      _send(o) { try { this._sock.enviar(o); } catch (_) {} }
      _msg(m) {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'open') this._fire('open', this.id);
        else if (m.t === 'err') this._fire('error', { type: m.type || 'server-error' });
        else if (m.t === 'conn') { const c = new Conn(this, m.from); this._conns.set(m.from, c); this._fire('connection', c); }
        else if (m.t === 'conn-ok') { const c = this._conns.get(m.to); if (c) c._fire('open'); }
        else if (m.t === 'd') { const c = this._conns.get(m.from); if (c) c._fire('data', m.m); }
        else if (m.t === 'c') { const c = this._conns.get(m.from); if (c) { this._conns.delete(m.from); c._fire('close'); } }
      }
      _caiu() {
        this._fire('error', { type: 'network' });
        for (const c of this._conns.values()) c._fire('close');
        this._conns.clear();
      }
      connect(alvo) { const c = new Conn(this, alvo); this._conns.set(alvo, c); this._send({ t: 'conn', to: alvo }); return c; }
      destroy() { this._morto = true; try { this._sock.fechar(); } catch (_) {} }
      reconnect() {}
      disconnect() {}
    };
  }
  root.SB_MAKE_PEER = makePeerClass;

  const ehNavegador = typeof window !== 'undefined' && typeof WebSocket !== 'undefined' &&
    window.location && /^https?:$/.test(window.location.protocol);

  /* ---- transporte WebSocket (navegador) — substitui o PeerJS ---- */
  if (ehNavegador && !window.SB_LOCAL) {
    const url = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
    window.SB_DEDICADO = true;
    window.Peer = makePeerClass((onMsg, onClose) => {
      const ws = new WebSocket(url);
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } onMsg(m); };
      ws.onclose = () => onClose();
      ws.onerror = () => {};
      return {
        abrir(id) {
          const m = JSON.stringify({ t: 'reg', id });
          if (ws.readyState === 1) ws.send(m);
          else ws.addEventListener('open', () => ws.send(m), { once: true });
        },
        enviar(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
        fechar() { try { ws.close(); } catch (_) {} }
      };
    });
  }

  /* =====================================================================
     v64: SERVIÇOS ONLINE — só no navegador, servido pelo servidor do jogo
     ===================================================================== */
  if (ehNavegador && !window.SB_LOCAL) {
    const post = (url, corpo) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) }).then(r => r.json());
    const perfilLer = () => { try { return (JSON.parse(localStorage.getItem('streetball-salas-v1') || '{}') || {}).eu || {}; } catch (_) { return {}; } };

    /* -- o seu ID de membro: o primeiro jogador do servidor é o ID 1, o segundo o 2... -- */
    let SB_UID = null;
    try { SB_UID = localStorage.getItem('sb-uid'); } catch (_) {}
    if (!SB_UID) {
      SB_UID = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('sb-uid', SB_UID); } catch (_) {}
    }
    let SB_ID = 0;
    const patchId = () => {
      if (!SB_ID) return;
      const el = document.querySelector('.lb-eu-tx small');
      if (el && el.textContent !== ('ID ' + SB_ID)) el.textContent = 'ID ' + SB_ID;
    };
    const perfilSinc = () => {
      const eu = perfilLer();
      post('/api/perfil', { uid: SB_UID, nome: String(eu.nome || 'Jogador').slice(0, 8) })
        .then(j => { if (j && j.id) { SB_ID = j.id | 0; patchId(); } }).catch(() => {});
    };
    perfilSinc(); setInterval(perfilSinc, 30000); setInterval(patchId, 2000);
    setTimeout(patchId, 2500);

    /* -- salas públicas, partida rápida e o chat da comunidade -- */
    window.StreetballServices = {
      listPublicRooms() { return fetch('/api/publicas').then(r => r.json()).then(j => j.salas || []); },
      joinPublicRoom(id) { return post('/api/publicas/entrar', { id }); },
      quickPlay(modo) { return post('/api/publicas/rapido', { modo: String(modo || 'classico') }); },
      chat(canal) {
        return fetch('/api/chat?canal=' + encodeURIComponent(canal)).then(r => r.json())
          .then(j => (j.msgs || []).map(m => ({ name: m.de, text: m.texto })));
      },
      sendChat(canal, texto) {
        const eu = perfilLer();
        const de = String(eu.nome || 'Jogador').slice(0, 8) + (SB_ID ? ' #' + SB_ID : '');
        return post('/api/chat', { canal, de, texto: String(texto || '').slice(0, 80) });
      }
    };

    /* -- o chat da comunidade se atualiza sozinho enquanto está aberto -- */
    setInterval(() => {
      const log = document.querySelector('.community-drawer .social-chat') || document.querySelector('.social-chat');
      if (!log) return;
      const tit = (document.querySelector('#ui-pop-caixa h2') || {}).textContent || '';
      if (!tit.includes('COMUNIDADE')) return;
      const canal = (document.querySelector('.module-tabs button[aria-selected="true"]') || {}).textContent || 'BRASIL';
      fetch('/api/chat?canal=' + encodeURIComponent(canal)).then(r => r.json()).then(j => {
        const msgs = j.msgs || [];
        const key = msgs.length + ':' + (msgs.length ? msgs[msgs.length - 1].ts : 0);
        if (log.dataset.sbKey === key) return;
        log.dataset.sbKey = key;
        log.textContent = '';
        if (!msgs.length) { const p = document.createElement('p'); p.textContent = 'Nenhuma mensagem ainda. Puxe assunto!'; log.appendChild(p); return; }
        for (const m of msgs) {
          const p = document.createElement('p'), b = document.createElement('b');
          b.textContent = m.de + ': ';
          p.append(b, document.createTextNode(m.texto));
          log.appendChild(p);
        }
        log.scrollTop = log.scrollHeight;
      }).catch(() => {});
    }, 4000);

    /* -- CLUBE: em breve -- */
    setInterval(() => {
      for (const b of document.querySelectorAll('.home-tile')) {
        if (b.dataset.sbClube || !(b.textContent || '').includes('CLUBE')) continue;
        b.dataset.sbClube = '1';
        const tx = b.querySelector('span:not(.game-icon)');
        if (tx && !tx.querySelector('small')) { const s = document.createElement('small'); s.textContent = 'EM BREVE'; tx.appendChild(s); }
        const clone = b.cloneNode(true);
        b.replaceWith(clone);
        clone.addEventListener('click', () => {
          const a = document.getElementById('ui-aviso');
          if (a) { a.textContent = 'CLUBE: EM BREVE!'; a.classList.add('on'); setTimeout(() => a.classList.remove('on'), 1800); }
        });
      }
    }, 1500);
  }

  /* =====================================================================
     v64: FORMAÇÃO AUTOMÁTICA — dentro do servidor (a anfitriã jsdom), nas salas
     públicas: quem entra sai do banco direto para o time com menos gente.
     ===================================================================== */
  if (typeof window !== 'undefined' && window.SB_LOCAL) {
    let auto = null;
    try { auto = localStorage.getItem('sb-auto-teams'); } catch (_) {}
    if (auto === '1') {
      setInterval(() => {
        try {
          const SB = window.SB;
          if (!SB || !SB.NET || SB.NET.modo !== 'host' || SB.NET.jogando || SB.UI.jogo) return;
          const n = t => { let c = 0; for (const r of SB.NET.conns.values()) if (r.time === t) c++; return c; };
          let mudou = false;
          for (const r of SB.NET.conns.values()) if (r.time === -1) { r.time = n(0) <= n(1) ? 0 : 1; mudou = true; }
          if (mudou) { SB.netRoster(); SB.renderSala(); }
        } catch (_) {}
      }, 1500);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
