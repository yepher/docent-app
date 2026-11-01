const ASR_RATE = 16000;

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return buffer;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
    this.recorder.start();
  }

  /** Stops recording and returns 16 kHz mono WAV, the format the model listens to. */
  async stop(): Promise<ArrayBuffer> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Not recording');
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    this.stream?.getTracks().forEach((t) => t.stop());
    const encoded = await new Blob(this.chunks).arrayBuffer();
    const decoder = new AudioContext();
    const decoded = await decoder.decodeAudioData(encoded);
    await decoder.close();
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * ASR_RATE), ASR_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), ASR_RATE);
  }
}

/** Plays speech chunks back to back, in the order they arrive. */
export class Player {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private idle = new Set<() => void>();

  /** Resolves after the queued audio has actually played, or playback is stopped. */
  whenIdle(): Promise<void> {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private finishIdle() {
    if (this.sources.size) return;
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }

  /** Queues audio and returns the seconds until it starts playing. */
  enqueue(samples: ArrayBuffer, sampleRate: number): number {
    this.context ??= new AudioContext();
    const data = new Float32Array(samples);
    if (data.length === 0) return this.remaining();
    const buffer = this.context.createBuffer(1, data.length, sampleRate);
    buffer.copyToChannel(data, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      this.finishIdle();
    };
    this.nextTime = Math.max(this.nextTime, this.context.currentTime + 0.05);
    const startsIn = this.nextTime - this.context.currentTime;
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(source);
    return startsIn;
  }

  /** Seconds of queued audio left to play. */
  remaining(): number {
    return this.context ? Math.max(0, this.nextTime - this.context.currentTime) : 0;
  }

  stop() {
    this.sources.forEach((s) => s.stop());
    this.sources.clear();
    this.nextTime = 0;
    this.finishIdle();
  }
}

/** Runs callbacks in order at given delays. Text uses it to stay in step with the speech it belongs to. */
export class Pacer {
  private lastAt = 0;
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();

  after(seconds: number, fn: () => void) {
    const at = Math.max(performance.now() + seconds * 1000, this.lastAt);
    this.lastAt = at;
    const wait = at - performance.now();
    if (wait <= 0 && this.timers.size === 0) return fn();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, wait);
    this.timers.set(timer, fn);
  }

  /** Runs everything still waiting, right now and in order, so stopping never loses text. */
  flush() {
    const waiting = [...this.timers.entries()];
    this.timers.clear();
    this.lastAt = 0;
    for (const [timer, fn] of waiting) {
      clearTimeout(timer);
      fn();
    }
  }
}
