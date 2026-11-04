// Sender side: capture a window or the whole screen and send it to each viewer.
import { PRESETS, createSignal, loadConfig, applyCodecPreference, videoStats } from './common.js';

export class HostSession extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.signal = null;
    this.room = null;
    this.peers = new Map(); // viewerId -> { pc, sender, prev }
    this.preset = PRESETS.standard;
    this.codec = 'auto';
  }

  // Opens the browser's picker, where the user chooses a window, a tab or a whole screen.
  async capture({ audio = false } = {}) {
    const p = this.preset;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: p.fps, max: p.fps }, width: { max: p.maxWidth } },
      audio,
      // Chrome hints: offer windows first and do not let the page capture itself by default.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = p.hint;
    track.addEventListener('ended', () => this.emit('capture-ended'));

    const old = this.stream;
    this.stream = stream;
    // Switching to another window keeps viewers connected: just swap the track.
    for (const peer of this.peers.values()) {
      await peer.sender.replaceTrack(track);
      const audioTrack = stream.getAudioTracks()[0] || null;
      if (peer.audioSender) await peer.audioSender.replaceTrack(audioTrack);
    }
    if (old) old.getTracks().forEach((t) => t.stop());
    return stream;
  }

  surfaceLabel() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return '';
    const surface = track.getSettings().displaySurface;
    const kind = { monitor: '全画面', window: 'ウィンドウ', browser: 'タブ' }[surface] || '画面';
    return `${kind}: ${track.label || ''}`.trim();
  }

  async start() {
    this.config = await loadConfig();
    this.stopping = false;
    await this.connect();
  }

  // (Re)connects to the server. Viewers already watching stay connected
  // peer-to-peer; after a drop we ask for the same code back so they can rejoin.
  async connect() {
    const signal = (this.signal = createSignal(this.config));
    signal.on('hosted', ({ room }) => {
      this.room = room;
      this.emit('hosted', room);
      this.emit('status', '');
    });
    signal.on('viewer-joined', ({ id }) => this.addViewer(id));
    signal.on('viewer-left', ({ id }) => this.removeViewer(id));
    signal.on('signal', async ({ from, data }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (data.sdp) await peer.pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    });
    signal.on('close', () => {
      if (this.stopping || this.signal !== signal) return;
      this.emit('status', 'サーバーに再接続しています…');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), 3000);
    });
    try {
      await signal.ready;
    } catch {
      return; // the close handler retries
    }
    signal.send({ type: 'host', room: this.room });
  }

  async addViewer(id) {
    if (!this.stream) return;
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    const track = this.stream.getVideoTracks()[0];
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.stream],
      sendEncodings: [this.encoding()],
    });
    applyCodecPreference(transceiver, this.codec);

    let audioSender = null;
    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) {
      audioSender = pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [this.stream] }).sender;
    }

    const peer = { pc, sender: transceiver.sender, audioSender, prev: null };
    this.peers.set(id, peer);
    await this.tuneSender(peer.sender);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal.send({ type: 'signal', to: id, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.removeViewer(id);
      this.emit('viewers', this.peers.size);
    };

    await pc.setLocalDescription(await pc.createOffer());
    this.signal.send({ type: 'signal', to: id, data: { sdp: pc.localDescription } });
    this.emit('viewers', this.peers.size);
  }

  removeViewer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.emit('viewers', this.peers.size);
  }

  encoding() {
    return {
      maxBitrate: this.preset.kbps * 1000,
      maxFramerate: this.preset.fps,
      // Keep text readable: drop frames before dropping resolution.
      priority: 'high',
    };
  }

  async tuneSender(sender) {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    Object.assign(params.encodings[0], this.encoding());
    params.degradationPreference =
      this.preset.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    try {
      await sender.setParameters(params);
    } catch (e) {
      console.warn('setParameters failed', e);
    }
  }

  // Change quality while sharing, without reconnecting anyone.
  async setPreset(key) {
    this.preset = PRESETS[key] || PRESETS.standard;
    const track = this.stream?.getVideoTracks()[0];
    if (track) {
      track.contentHint = this.preset.hint;
      await track
        .applyConstraints({ frameRate: { max: this.preset.fps }, width: { max: this.preset.maxWidth } })
        .catch(() => {});
    }
    for (const peer of this.peers.values()) await this.tuneSender(peer.sender);
  }

  // Codec only applies to viewers who join after the change.
  setCodec(codec) {
    this.codec = codec;
  }

  async stats() {
    let total = 0;
    let line = '';
    for (const peer of this.peers.values()) {
      const r = await videoStats(peer.pc, peer.prev, 'out');
      peer.prev = r.prev;
      total += r.kbps || 0;
      line ||= r.text;
    }
    if (!this.peers.size) return '視聴者なし(送信していません)';
    return `${line} | 合計 ${Math.round(total)}kbps`;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    for (const id of [...this.peers.keys()]) this.removeViewer(id);
    this.signal?.send({ type: 'leave' });
    this.signal?.close();
    this.signal = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.room = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
