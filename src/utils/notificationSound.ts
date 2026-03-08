let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function playTones(frequencies: number[]) {
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume();
  }

  const now = ctx.currentTime;
  const noteDuration = 0.12;
  const gap = 0.05;

  frequencies.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = freq;

    const start = now + i * (noteDuration + gap);
    gain.gain.setValueAtTime(0.3, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + noteDuration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + noteDuration);
  });
}

/** Descending chime (E5 → C5) — agent finished */
export function playDoneSound() {
  playTones([659.25, 523.25]);
}

/** Rising chime (C5 → E5) — needs attention */
export function playQuestionSound() {
  playTones([523.25, 659.25]);
}
