/** Voice memo recorder (ATT-019, ATT-020): wraps MediaRecorder, stops and saves by itself at 30 minutes. */

export const VOICE_MEMO_MAX_MS = 30 * 60_000;

export interface RecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  state: string;
  mimeType?: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class VoiceRecorder {
  private rec: RecorderLike;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private cap: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  durationMs = 0;

  constructor(
    make: (stream: MediaStream) => RecorderLike,
    stream: MediaStream,
    private opts: { onTick?: (ms: number) => void; onDone: (blob: Blob, durationMs: number) => void; maxMs?: number; now?: () => number },
  ) {
    this.rec = make(stream);
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.onstop = () => this.finish();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    this.startedAt = this.now();
    this.rec.start(1000);
    this.tick = setInterval(() => this.opts.onTick?.(this.now() - this.startedAt), 500);
    this.cap = setTimeout(() => this.stop(), this.opts.maxMs ?? VOICE_MEMO_MAX_MS);
  }

  stop(): void {
    if (this.rec.state !== "inactive") this.rec.stop();
  }

  cancel(): void {
    this.cancelled = true;
    this.stop();
    this.clear();
  }

  private clear(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.cap) clearTimeout(this.cap);
    this.tick = this.cap = null;
  }

  private finish(): void {
    this.clear();
    this.durationMs = Math.min(this.now() - this.startedAt, this.opts.maxMs ?? VOICE_MEMO_MAX_MS);
    if (this.cancelled) return;
    this.opts.onDone(new Blob(this.chunks, { type: this.rec.mimeType || "audio/webm" }), this.durationMs);
  }
}
