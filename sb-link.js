/* =====================================================================
   STREETBALL · v63 — sb-link.js
   Transporte das salas online pelo SERVIDOR DEDICADO (WebSocket), no lugar do PeerJS.
   - No navegador (servido pelo servidor do jogo): define window.Peer (compatível com a
     interface do PeerJS que o jogo usa) e window.SB_DEDICADO = true.
   - No servidor (Node, dentro do jsdom): a fábrica SB_MAKE_PEER é reutilizada com um
     transporte direto em memória.
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

  // No navegador, servido pelo servidor do jogo (http/https): liga o WebSocket e substitui o PeerJS.
  // (window.SB_LOCAL = dentro do servidor: a anfitriã usa o transporte em memória, não WebSocket)
  if (typeof window !== 'undefined' && !window.SB_LOCAL && typeof WebSocket !== 'undefined' &&
      window.location && /^https?:$/.test(window.location.protocol)) {
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
})(typeof window !== 'undefined' ? window : globalThis);
