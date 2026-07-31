/**
 * Ceremony sound for the lottery machine (#216): a real drum roll through the beat window, a
 * snare hit on the drop, a fanfare on the finale. Everything is synthesized with WebAudio —
 * filtered noise and a handful of oscillators — so there are no audio assets, nothing added to
 * the bundle beyond this module, and no CSP question (the Activity proxy never sees a request).
 *
 * Autoplay policy shapes the whole design: browsers refuse sound without a user gesture in the
 * iframe, so the ceremony starts silent and a 🔊 toggle arms it — that click is the gesture that
 * creates/resumes the AudioContext. The choice persists (localStorage); a returning viewer who
 * had sound on gets re-armed by their first interaction with the page, per the same policy.
 * Silence stays a first-class experience — nothing visual ever waits on audio.
 *
 * League members watch from a Discord voice channel, so cues are short and the master gain is
 * conservative: percussion and a five-note flourish, not a soundtrack.
 */

import { rollPlan } from './rollPlan.js';

/** localStorage key for the remembered sound preference. */
const PREF_KEY = 'lottery-sound';

/** Master output level — deliberately quiet under voice chat. */
const MASTER_GAIN = 0.28;

/** The drum roll's gain envelope, from a whisper to the reveal. */
const ROLL_START_GAIN = 0.05;
const ROLL_END_GAIN = 0.4;

export interface CeremonyAudio {
  /** Flip sound on/off. Returns the new enabled state. The enabling click is the autoplay gesture. */
  toggle(): boolean;
  isEnabled(): boolean;
  /** Start (or restart) the drum roll for one beat window. */
  drumRoll(windowMs: number): void;
  /** The reveal landed early or the ceremony left the drum-roll — ramp the roll out fast. */
  stopRoll(): void;
  /** Snare + thump for the ball drop. */
  hit(): void;
  /** The finale flourish — five ascending notes. Caller gates it one-shot (like confetti). */
  fanfare(): void;
}

/**
 * `onChange` fires whenever the enabled state flips — including the stored-preference re-arm on
 * the viewer's first interaction, which happens outside any toggle click the UI could observe.
 */
export function createCeremonyAudio(onChange?: (enabled: boolean) => void): CeremonyAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let enabled = false;
  let roll: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  let storedPref = false;
  try {
    storedPref = localStorage.getItem(PREF_KEY) === '1';
  } catch {
    /* storage can be unavailable in an embedded context — sound just starts off */
  }

  function ensureContext(): AudioContext | null {
    if (!ctx) {
      try {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(ctx.destination);
      } catch {
        return null; // no WebAudio — the toggle stays a no-op and the ceremony stays visual
      }
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  /** Two seconds of looped white noise — the raw material for the roll and the snare. */
  function noiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** The stored-preference bootstrap listener, retired by the first explicit state change. */
  let rearm: ((event: PointerEvent) => void) | null = null;

  function setEnabled(on: boolean): void {
    // Any explicit choice supersedes the stored-preference bootstrap — without this, a viewer
    // who toggled sound OFF could have a later stray click silently re-enable it.
    if (rearm) {
      document.removeEventListener('pointerdown', rearm);
      rearm = null;
    }
    enabled = on;
    try {
      localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {
      /* fine — the preference just won't persist */
    }
    if (!on) {
      stopRollNow(0.05);
      // Suspend rather than close: everything silences instantly and re-enabling is cheap.
      if (ctx && ctx.state === 'running') void ctx.suspend();
    } else {
      ensureContext();
    }
    onChange?.(on);
  }

  // A viewer who had sound on last time can't be un-muted without a gesture — so their first
  // interaction anywhere on the page re-arms it. One shot, removed either way. The sound button
  // itself is exempt: its own click handler toggles, and re-arming on the same gesture's
  // pointerdown would make that toggle flip the just-enabled sound straight back off.
  if (storedPref) {
    rearm = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('#sound-btn')) return;
      setEnabled(true); // removes and clears the listener itself
    };
    document.addEventListener('pointerdown', rearm);
  }

  function stopRollNow(rampSeconds: number): void {
    if (!roll || !ctx) return;
    const { source, gain } = roll;
    roll = null;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + rampSeconds);
    source.stop(now + rampSeconds + 0.05);
  }

  return {
    toggle(): boolean {
      setEnabled(!enabled);
      return enabled;
    },
    isEnabled: () => enabled,

    drumRoll(windowMs: number): void {
      if (!enabled) return;
      const audioCtx = ensureContext();
      if (!audioCtx || !master) return;
      stopRollNow(0.03); // a re-beat replaces the previous roll rather than layering on it
      const plan = rollPlan(windowMs);
      const now = audioCtx.currentTime;

      // Sticks-on-a-snare texture: looped noise through a tight bandpass, with a fast tremolo on
      // the gain so it flutters instead of hissing.
      const source = audioCtx.createBufferSource();
      source.buffer = noiseBuffer(audioCtx);
      source.loop = true;
      const band = audioCtx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 220;
      band.Q.value = 0.9;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(ROLL_START_GAIN, now + plan.attackMs / 1000);
      gain.gain.linearRampToValueAtTime(ROLL_END_GAIN, now + plan.crescendoEndMs / 1000);

      // The tremolo multiplies the envelope through its own stage (base 1 ± depth) instead of
      // adding to it: a bipolar wobble summed onto a near-zero envelope swings the gain negative,
      // which inverts the noise at full flutter amplitude rather than silencing it — the whisper
      // opening would start loud and the crescendo would be defeated.
      const tremolo = audioCtx.createOscillator();
      tremolo.frequency.setValueAtTime(14, now);
      // The flutter quickens as the crescendo builds — 14Hz sticks becoming a 26Hz blur.
      tremolo.frequency.linearRampToValueAtTime(26, now + plan.crescendoEndMs / 1000);
      const flutter = audioCtx.createGain();
      flutter.gain.value = 1; // offset; the oscillator wobbles ±0.45 around it, staying positive
      const tremoloDepth = audioCtx.createGain();
      tremoloDepth.gain.value = 0.45;
      tremolo.connect(tremoloDepth);
      tremoloDepth.connect(flutter.gain);

      source.connect(band);
      band.connect(gain);
      gain.connect(flutter);
      flutter.connect(master);
      source.start(now);
      tremolo.start(now);
      source.stop(now + plan.autoStopMs / 1000); // failsafe: an abandoned roll ends itself
      tremolo.stop(now + plan.autoStopMs / 1000);
      roll = { source, gain };
    },

    stopRoll(): void {
      stopRollNow(0.08);
    },

    hit(): void {
      if (!enabled) return;
      const audioCtx = ensureContext();
      if (!audioCtx || !master) return;
      const now = audioCtx.currentTime;
      // Snare: a sharp high-passed noise burst…
      const burst = audioCtx.createBufferSource();
      burst.buffer = noiseBuffer(audioCtx);
      const high = audioCtx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = 1600;
      const burstGain = audioCtx.createGain();
      burstGain.gain.setValueAtTime(0.6, now);
      burstGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      burst.connect(high);
      high.connect(burstGain);
      burstGain.connect(master);
      burst.start(now);
      burst.stop(now + 0.16);
      // …over a low thump so the drop has weight.
      const thump = audioCtx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(190, now);
      thump.frequency.exponentialRampToValueAtTime(70, now + 0.12);
      const thumpGain = audioCtx.createGain();
      thumpGain.gain.setValueAtTime(0.5, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      thump.connect(thumpGain);
      thumpGain.connect(master);
      thump.start(now);
      thump.stop(now + 0.18);
    },

    fanfare(): void {
      if (!enabled) return;
      const audioCtx = ensureContext();
      if (!audioCtx || !master) return;
      const out = master; // narrow once — the closure below can't see the guard on a mutable let
      const now = audioCtx.currentTime;
      // C major flourish, two detuned saws per note for a little brass shimmer.
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5 E5 G5 C6 E6
      notes.forEach((freq, i) => {
        const at = now + i * 0.14;
        const hold = i === notes.length - 1 ? 0.7 : 0.16;
        for (const detune of [-6, 6]) {
          const osc = audioCtx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = freq;
          osc.detune.value = detune;
          const soft = audioCtx.createBiquadFilter();
          soft.type = 'lowpass';
          soft.frequency.value = 2600;
          const gain = audioCtx.createGain();
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(0.22, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, at + hold);
          osc.connect(soft);
          soft.connect(gain);
          gain.connect(out);
          osc.start(at);
          osc.stop(at + hold + 0.05);
        }
      });
    },
  };
}
