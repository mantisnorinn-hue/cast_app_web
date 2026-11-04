// Serverless signaling: uses a public PeerJS broker (0.peerjs.com by default)
// only to pass connection set-up messages. The video still goes peer-to-peer.
// Same interface and message names as Signal in common.js, so host and viewer
// code does not care which one is used.
//
// PeerJS wire protocol: connect to wss://HOST/peerjs?key=&id=&token=, receive
// {type:"OPEN"}, then send {type:"OFFER", dst, payload}; the broker forwards it
// with "src" set. A message to a peer that is not connected comes back as
// {type:"EXPIRE"} after a few seconds.

export const ID_PREFIX = 'castapp-v1-';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;
const HEARTBEAT_MS = 5000;

export const DEFAULT_BROKER = { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs' };

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomToken() {
  return Math.random().toString(36).slice(2);
}

export class PeerSignal extends EventTarget {
  constructor(broker = DEFAULT_BROKER, { maxViewers = 8 } = {}) {
    super();
    this.broker = broker;
    this.maxViewers = maxViewers;
    this.ws = null;
    this.role = null;
    this.room = null;
    this.hostId = null;
    this.viewers = new Set();
    this.closedByUser = false;
    // Nothing to wait for until "host" or "join" is sent.
    this.ready = Promise.resolve();
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  url(id) {
    const b = this.broker;
    const proto = b.secure ? 'wss' : 'ws';
    const path = b.path.endsWith('/') ? b.path : `${b.path}/`;
    const q = new URLSearchParams({ key: b.key, id, token: randomToken() });
    return `${proto}://${b.host}:${b.port}${path}peerjs?${q}`;
  }

  open(id) {
    const ws = (this.ws = new WebSocket(this.url(id)));
    ws.onmessage = (e) => this.onBrokerMessage(JSON.parse(e.data));
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.ws === ws && !this.closedByUser) this.emit('close');
    };
    this.heartbeat = setInterval(() => this.raw({ type: 'HEARTBEAT' }), HEARTBEAT_MS);
  }

  raw(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  to(dst, payload) {
    this.raw({ type: 'OFFER', dst, payload });
  }

  // Messages from host.js / ViewerSession, in the same shape Signal uses.
  send(msg) {
    switch (msg.type) {
      case 'host': {
        this.role = 'host';
        this.room = /^[A-Z0-9]{6}$/.test(msg.room || '') ? msg.room : randomCode();
        this.open(ID_PREFIX + this.room);
        break;
      }
      case 'join': {
        this.role = 'viewer';
        this.room = String(msg.room || '').toUpperCase();
        this.hostId = ID_PREFIX + this.room;
        this.open(`${ID_PREFIX}v-${crypto.randomUUID()}`);
        break;
      }
      case 'signal':
        this.to(this.role === 'host' ? msg.to : this.hostId, { t: 'signal', data: msg.data });
        break;
      case 'leave':
        if (this.role === 'host') {
          for (const v of this.viewers) this.to(v, { t: 'host-left', reason: 'stopped' });
        } else if (this.hostId) {
          this.to(this.hostId, { t: 'leave' });
        }
        break;
      default:
        break;
    }
  }

  onBrokerMessage(m) {
    switch (m.type) {
      case 'OPEN':
        if (this.role === 'host') this.emit('hosted', { room: this.room });
        else this.to(this.hostId, { t: 'join' });
        break;
      case 'ID-TAKEN':
        if (this.role === 'host') {
          // Someone already uses this code: take a fresh one.
          this.ws.onclose = null;
          this.ws.close();
          this.room = randomCode();
          this.open(ID_PREFIX + this.room);
        }
        break;
      case 'EXPIRE':
        // The other side is not connected to the broker.
        if (this.role === 'viewer') this.emit('error', { reason: 'no-room' });
        else if (this.viewers.delete(m.src)) this.emit('viewer-left', { id: m.src });
        break;
      case 'LEAVE':
        if (this.role === 'host' && this.viewers.delete(m.src)) this.emit('viewer-left', { id: m.src });
        if (this.role === 'viewer' && m.src === this.hostId) this.emit('host-left', { reason: 'lost' });
        break;
      case 'OFFER':
        this.onPeerMessage(m.src, m.payload || {});
        break;
      case 'ERROR':
        this.emit('close');
        break;
      default:
        break;
    }
  }

  onPeerMessage(src, p) {
    if (this.role === 'host') {
      if (p.t === 'join') {
        if (!this.viewers.has(src) && this.viewers.size >= this.maxViewers) {
          this.to(src, { t: 'error', reason: 'room-full' });
          return;
        }
        this.viewers.add(src);
        this.to(src, { t: 'joined' });
        this.emit('viewer-joined', { id: src });
      } else if (p.t === 'leave') {
        if (this.viewers.delete(src)) this.emit('viewer-left', { id: src });
      } else if (p.t === 'signal' && this.viewers.has(src)) {
        this.emit('signal', { from: src, data: p.data });
      }
      return;
    }
    if (src !== this.hostId) return; // viewers only listen to their host
    if (p.t === 'joined') this.emit('joined', { room: this.room });
    else if (p.t === 'error') this.emit('error', { reason: p.reason });
    else if (p.t === 'host-left') this.emit('host-left', { reason: p.reason });
    else if (p.t === 'signal') this.emit('signal', { data: p.data });
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.heartbeat);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      // Tell the broker we are gone so our id is freed right away.
      this.raw({ type: 'LEAVE' });
      this.ws.close();
    }
  }
}
