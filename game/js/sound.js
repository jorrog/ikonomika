// Прости звукови ефекти с Web Audio — без външни файлове.
window.Sound = (function () {
  'use strict';
  let ctx = null;
  let enabled = true;

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, type = 'sine', gain = 0.18) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const effects = {
    correct() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.35, 'triangle')); },
    wrong() { tone(196, 0, 0.3, 'sawtooth', 0.1); tone(147, 0.2, 0.5, 'sawtooth', 0.1); },
    timeout() { tone(330, 0, 0.2, 'square', 0.08); tone(220, 0.22, 0.6, 'square', 0.08); },
    claim() { tone(392, 0, 0.15, 'square', 0.06); tone(587.33, 0.1, 0.35, 'triangle', 0.2); },
    tick() { tone(1250, 0, 0.05, 'square', 0.04); },
    fanfare() {
      [392, 523.25, 659.25, 783.99, 659.25, 783.99, 1046.5]
        .forEach((f, i) => tone(f, i * 0.15, i === 6 ? 1 : 0.24, 'triangle', 0.2));
    }
  };

  return {
    play(name) {
      if (!enabled || !effects[name]) return;
      try { effects[name](); } catch (e) { /* звукът не е критичен */ }
    },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; }
  };
})();
