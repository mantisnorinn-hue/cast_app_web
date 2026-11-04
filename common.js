// Shared helpers for the host page, the viewer page and the TV receiver.
import { PeerSignal, DEFAULT_BROKER } from './peersignal.js';

// How long viewers and the sharer keep trying to reconnect after a drop.
export const RETRY_WINDOW_MS = 60000;

export const PRESETS = {
  // Text, slides, code: few frames, sharp text, very low bandwidth.
  saver: { label: '省データ(文字・資料向け)', fps: 5, maxWidth: 1280, kbps: 300, hint: 'detail' },
  standard: { label: '標準', fps: 15, maxWidth: 1920, kbps: 1000, hint: 'detail' },
  motion: { label: '動画・ゲーム', fps: 30, maxWidth: 1920, kbps: 2500, hint: 'motion' },
};

// Served by our own server (home PC / Raspberry Pi): use it for signaling.
// Opened from a static host such as GitHub Pages (no config.json): use the
// public PeerJS broker instead, so no server of our own is needed.
let configPromise;
export function loadConfig() {
  configPromise ??= fetch('config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no config'))))
    .then((c) => ({ ...c, mode: 'server' }))
    .catch(() => ({
      mode: 'broker',
      broker: window.CAST_BROKER || DEFAULT_BROKER,
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      castAppId: '',
      maxViewers: 8,
    }));
  return configPromise;
}

export function createSignal(config) {
  return config.mode === 'broker' ? new PeerSignal(config.broker, config) : new Signal();
}

// Small WebSocket wrapper. Reconnecting is left to the caller.
export class Signal extends EventTarget {
  constructor() {
    super();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ready.catch(() => {});
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    };
    this.ws.onclose = () => this.dispatchEvent(new Event('close'));
  }
  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
  }
  close() {
    this.ws.close();
  }
}

// Order the video codecs so the preferred one is negotiated first.
// "auto" prefers VP9 (good for screen content, decodes almost everywhere),
// then AV1 (smallest, but heavier to encode), then H.264 (hardware on most devices).
export function codecOrder(pref) {
  const orders = {
    auto: ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8'],
    av1: ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'],
    vp9: ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8'],
    h264: ['video/H264', 'video/VP9', 'video/AV1', 'video/VP8'],
  };
  return orders[pref] || orders.auto;
}

export function applyCodecPreference(transceiver, pref) {
  const caps = RTCRtpSender.getCapabilities?.('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const order = codecOrder(pref);
  const rank = (c) => {
    const i = order.indexOf(c.mimeType);
    return i < 0 ? order.length : i;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(sorted);
  } catch (e) {
    console.warn('setCodecPreferences failed', e);
  }
}

// Summarise inbound or outbound video stats into one line of text.
export async function videoStats(pc, prev, direction) {
  const report = await pc.getStats();
  const kind = direction === 'out' ? 'outbound-rtp' : 'inbound-rtp';
  let rtp;
  let codec;
  report.forEach((s) => {
    if (s.type === kind && s.kind === 'video') rtp = s;
  });
  if (!rtp) return { text: '', prev };
  if (rtp.codecId) codec = report.get(rtp.codecId);
  const bytes = direction === 'out' ? rtp.bytesSent : rtp.bytesReceived;
  const now = rtp.timestamp;
  let kbps = 0;
  if (prev && now > prev.t) kbps = ((bytes - prev.bytes) * 8) / (now - prev.t);
  const parts = [];
  if (codec) parts.push(codec.mimeType.replace('video/', ''));
  if (rtp.frameWidth) parts.push(`${rtp.frameWidth}x${rtp.frameHeight}`);
  if (rtp.framesPerSecond) parts.push(`${Math.round(rtp.framesPerSecond)}fps`);
  parts.push(`${Math.round(kbps)}kbps`);
  return { text: parts.join(' / '), prev: { t: now, bytes }, kbps };
}

// Viewer side of one peer connection. Used by both the viewer page and the TV receiver.
export class ViewerSession extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.pc = null;
    this.signal = null;
    this.prevStats = null;
    this.room = null;
    this.retryTimer = null;
    this.retryUntil = 0;
  }

  async join(room) {
    this.leave();
    this.room = room;
    this.retryUntil = 0;
    await this.connect();
  }

  // Keep trying for a while after the server or the sharer's connection drops.
  // The video itself is peer-to-peer, so it can keep playing meanwhile.
  scheduleRetry(message) {
    if (!this.room) return;
    if (!this.retryUntil) this.retryUntil = Date.now() + RETRY_WINDOW_MS;
    if (Date.now() > this.retryUntil) {
      this.emit('status', message);
      return;
    }
    this.emit('status', '再接続を待っています…');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), 3000);
  }

  async connect() {
    const config = await loadConfig();
    this.signal?.close();
    const signal = (this.signal = createSignal(config));
    try {
      await signal.ready;
    } catch {
      return; // the close handler schedules the retry
    }

    signal.on('joined', () => {
      this.retryUntil = 0;
      if (!this.pc || this.pc.connectionState !== 'connected') this.emit('status', '配信者に接続中…');
    });
    signal.on('error', (m) => {
      if (m.reason === 'room-full') return this.emit('status', '満員です');
      if (this.retryUntil) return this.scheduleRetry('配信が見つかりません');
      this.emit('status', 'コードが見つかりません');
    });
    signal.on('host-left', ({ reason }) => {
      if (reason === 'stopped') {
        this.emit('status', '配信が終了しました');
        this.closePc();
        this.room = null;
        return;
      }
      this.scheduleRetry('配信者との接続が切れました');
    });
    signal.on('close', () => {
      if (this.signal === signal) this.scheduleRetry('サーバーとの接続が切れました');
    });
    signal.on('signal', async ({ data }) => {
      if (data.sdp) {
        this.closePc();
        const pc = (this.pc = new RTCPeerConnection({ iceServers: config.iceServers }));
        pc.onicecandidate = (e) => {
          if (e.candidate) signal.send({ type: 'signal', data: { candidate: e.candidate } });
        };
        pc.ontrack = (e) => {
          this.video.srcObject = e.streams[0] || new MediaStream([e.track]);
          // Autoplay with sound can be blocked without a click: fall back to muted.
          this.video.play().catch(() => {
            this.video.muted = true;
            this.video.play().catch(() => {});
          });
        };
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          if (st === 'connected') this.emit('status', '視聴中');
          else if (st === 'failed') {
            // The sharer may have gone away and come back with the same code: try again.
            if (this.pc === pc) this.scheduleRetry('接続に失敗しました(TURN サーバーが必要な環境かもしれません)');
          }
          else if (st === 'disconnected') this.emit('status', '再接続を待っています…');
        };
        await pc.setRemoteDescription(data.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        signal.send({ type: 'signal', data: { sdp: pc.localDescription } });
      } else if (data.candidate && this.pc) {
        await this.pc.addIceCandidate(data.candidate).catch(() => {});
      }
    });

    signal.send({ type: 'join', room: this.room });
  }

  async stats() {
    if (!this.pc) return '';
    const r = await videoStats(this.pc, this.prevStats, 'in');
    this.prevStats = r.prev;
    return r.text;
  }

  closePc() {
    if (this.pc) this.pc.close();
    this.pc = null;
    this.prevStats = null;
  }

  leave() {
    clearTimeout(this.retryTimer);
    this.room = null;
    this.closePc();
    const signal = this.signal;
    this.signal = null;
    signal?.close();
    this.video.srcObject = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
