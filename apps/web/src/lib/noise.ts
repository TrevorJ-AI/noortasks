/**
 * White noise for focus sessions, synthesised with Web Audio (no bundled audio assets).
 * Sounds: white, pink and brown noise, rain (pink noise through a band-pass with soft random gusts), ocean (brown
 * noise with a slow swell) and fan (low-passed white noise with a steady hum). Starts only from a user gesture.
 */
export const NOISES: Array<{ id: string; label: string }> = [
  { id: "", label: "None" },
  { id: "rain", label: "Rain" },
  { id: "ocean", label: "Ocean" },
  { id: "fan", label: "Fan" },
  { id: "brown", label: "Brown noise" },
  { id: "pink", label: "Pink noise" },
  { id: "white", label: "White noise" },
];

let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;
let currentId = "";

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function noiseBuffer(ac: AudioContext, kind: "white" | "pink" | "brown"): AudioBuffer {
  const len = ac.sampleRate * 4;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") d[i] = w * 0.35;
    else if (kind === "pink") {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.09;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
  }
  return buf;
}

export function playNoise(id: string, volume = 0.5): void {
  if (id === currentId && stopCurrent) return;
  stopNoise();
  if (!id) return;
  const ac = audio();
  if (!ac) return;
  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(volume, ac.currentTime + 1.2);
  gain.connect(ac.destination);
  const src = ac.createBufferSource();
  src.loop = true;
  const nodes: AudioNode[] = [src, gain];
  const kind = id === "white" || id === "fan" ? "white" : id === "pink" || id === "rain" ? "pink" : "brown";
  src.buffer = noiseBuffer(ac, kind);
  let tail: AudioNode = src;
  if (id === "rain") {
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 0.6;
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    lfo.frequency.value = 0.13;
    lfoGain.gain.value = 600;
    lfo.connect(lfoGain).connect(bp.frequency);
    lfo.start();
    tail.connect(bp);
    tail = bp;
    nodes.push(bp, lfo, lfoGain);
  } else if (id === "ocean") {
    const swell = ac.createGain();
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 0.09;
    depth.gain.value = 0.45;
    swell.gain.value = 0.55;
    lfo.connect(depth).connect(swell.gain);
    lfo.start();
    tail.connect(swell);
    tail = swell;
    nodes.push(swell, lfo, depth);
  } else if (id === "fan") {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const hum = ac.createOscillator();
    const humGain = ac.createGain();
    hum.frequency.value = 96;
    humGain.gain.value = 0.03;
    hum.connect(humGain).connect(gain);
    hum.start();
    tail.connect(lp);
    tail = lp;
    nodes.push(lp, hum, humGain);
  }
  tail.connect(gain);
  src.start();
  currentId = id;
  stopCurrent = () => {
    const t = ac.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.5);
    setTimeout(() => {
      for (const n of nodes) {
        try {
          (n as AudioScheduledSourceNode).stop?.();
        } catch {
          /* already stopped */
        }
        n.disconnect();
      }
    }, 600);
  };
}

export function stopNoise(): void {
  stopCurrent?.();
  stopCurrent = null;
  currentId = "";
}

/** Short two-tone chime at the end of a session (soundsOn, FOC-010). */
export function chime(): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  for (const [i, f] of [660, 880].entries()) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.22);
    g.gain.linearRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.22 + 0.9);
    o.connect(g).connect(ac.destination);
    o.start(t + i * 0.22);
    o.stop(t + i * 0.22 + 1);
  }
}
