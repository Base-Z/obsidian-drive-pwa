// ============================================================
// viz.js — canvas chart primitives (project 0002)
//
// Every function takes a <canvas> plus data and redraws it.
// The app runs one requestAnimationFrame loop and calls these
// each frame, so resizing and redraws need no extra plumbing.
// Colours follow the shared theme in /shared/app.css.
// ============================================================
const Viz = (() => {
  'use strict';

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const AXIS = 'rgba(255,255,255,.14)';
  const TEXT = '#8fa0c0';
  const FAINT = '#6d7ea0';
  const SERIES = ['#4cc2ff', '#4ade80', '#fb7185', '#fbbf24'];

  function fit(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * DPR || canvas.height !== h * DPR) {
      canvas.width = w * DPR;
      canvas.height = h * DPR;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function fmtNum(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 100000 || a < 0.001) return v.toExponential(1).replace('e+', 'e');
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function rangeOf(values, pad = 0.15) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) return [-1, 1];
    if (lo === hi) { lo -= 1; hi += 1; }
    const s = hi - lo;
    return [lo - s * pad, hi + s * pad];
  }

  function text(ctx, str, x, y, align = 'left', colour = TEXT, size = 10) {
    ctx.font = `${size}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  // ---------------------------------------------------------
  // Multi-series time-series line chart.
  // series: [{ label, colour, points: [{t, v}] }]
  // opts:   { yMin, yMax, yLog, unit }
  // ---------------------------------------------------------
  function line(canvas, { series, yMin, yMax, yLog = false, unit = '' }) {
    const { ctx, w, h } = fit(canvas);
    const pad = { l: 46, r: 12, t: 14, b: 18 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    if (iw <= 8 || ih <= 8) return;

    const all = [];
    for (const s of series) for (const p of s.points) all.push(p.v);

    let lo, hi;
    if (yMin !== undefined && yMax !== undefined) { lo = yMin; hi = yMax; }
    else if (yLog) {
      const pos = all.filter((v) => Number.isFinite(v) && v > 0);
      if (pos.length) { lo = Math.min(...pos) / 1.5; hi = Math.max(...pos) * 1.5; }
      else { lo = 1; hi = 100; }
    } else {
      [lo, hi] = rangeOf(all);
    }

    const isLog = yLog || (lo > 0 && hi / Math.max(lo, 1e-9) > 500);
    const l0 = Math.log10(Math.max(lo, 1e-6)), l1 = Math.log10(Math.max(hi, 1e-5));

    const yOf = (v) => {
      if (isLog) {
        const t = (Math.log10(Math.max(v, 1e-6)) - l0) / Math.max(l1 - l0, 1e-6);
        return pad.t + ih - Math.min(Math.max(t, 0), 1) * ih;
      }
      return pad.t + ih - ((v - lo) / Math.max(hi - lo, 1e-6)) * ih;
    };

    // grid + y axis labels
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ih * i) / 4;
      ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(pad.l + iw, y + .5); ctx.stroke();
      const frac = 1 - i / 4;
      const val = isLog ? Math.pow(10, l0 + (l1 - l0) * frac) : lo + (hi - lo) * frac;
      text(ctx, fmtNum(val), pad.l - 6, y, 'right');
    }

    // series
    series.forEach((s, si) => {
      const pts = s.points;
      if (pts.length < 2) return;
      ctx.strokeStyle = s.colour || SERIES[si % SERIES.length];
      ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = pad.l + (iw * i) / (pts.length - 1);
        const y = yOf(pts[i].v);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // legend (top-right)
    let lx = pad.l + iw - 4;
    ctx.textAlign = 'right';
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      const last = s.points.length ? s.points[s.points.length - 1].v : NaN;
      const label = `${s.label} ${fmtNum(last)}${unit ? ' ' + unit : ''}`;
      const cw = ctx.measureText(label).width + 16;
      ctx.fillStyle = s.colour || SERIES[i % SERIES.length];
      ctx.fillRect(lx - cw + 8, pad.t + 1, 7, 7);
      text(ctx, label, lx, pad.t + 5, 'right', TEXT, 10);
      lx -= cw + 8;
    }
  }

  // ---------------------------------------------------------
  // Polar compass. Angles are cyclic, so a linear axis would
  // misrepresent the 359°→0° wrap — hence a polar encoding.
  // ---------------------------------------------------------
  function polar(canvas, { heading, label = 'Heading' }) {
    const { ctx, w, h } = fit(canvas);
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 16;
    if (r <= 4) return;

    ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2); ctx.stroke();

    for (let d = 0; d < 360; d += 30) {
      const a = (d - 90) * Math.PI / 180;
      const inner = d % 90 === 0 ? r * 0.82 : r * 0.92;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, d]) => {
      const a = (d - 90) * Math.PI / 180;
      text(ctx, t, cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10), 'center', TEXT, 10);
    });

    if (Number.isFinite(heading)) {
      const a = (heading - 90) * Math.PI / 180;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * r * 0.28, cy - Math.sin(a) * r * 0.28);
      ctx.lineTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
      ctx.stroke();
      ctx.fillStyle = '#4cc2ff';
      ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
      text(ctx, `${Math.round(heading)}°`, cx, cy + r * 0.5, 'center', '#e8ecf5', 15);
    } else {
      text(ctx, 'no heading', cx, cy, 'center', FAINT, 11);
    }
  }

  // ---------------------------------------------------------
  // Vertical bars. Used for the audio spectrum: an FFT is a
  // distribution over frequency, not a trend, so bars over
  // log-spaced bins are the honest encoding.
  // ---------------------------------------------------------
  function bars(canvas, { values, labels = [], colour = '#4cc2ff', max = 255, yMaxLabel = '' }) {
    const { ctx, w, h } = fit(canvas);
    const pad = { l: 26, r: 6, t: 10, b: 16 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    if (iw <= 4 || ih <= 4) return;

    for (let i = 0; i <= 3; i++) {
      const y = pad.t + (ih * i) / 3;
      ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(pad.l + iw, y + .5); ctx.stroke();
    }
    text(ctx, String(max), pad.l - 4, pad.t, 'right', FAINT, 9);
    text(ctx, '0', pad.l - 4, pad.t + ih, 'right', FAINT, 9);
    if (yMaxLabel) text(ctx, yMaxLabel, pad.l - 4, pad.t + ih / 2, 'right', FAINT, 9);

    const n = values.length;
    if (!n) return;
    const bw = iw / n;
    for (let i = 0; i < n; i++) {
      const v = Math.min(Math.max(values[i], 0), max) / max;
      const bh = v * ih;
      const x = pad.l + i * bw;
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.35 + 0.65 * v;
      ctx.fillRect(x, pad.t + ih - bh, Math.max(bw - 1, 1), bh);
      ctx.globalAlpha = 1;
    }

    ctx.textAlign = 'center';
    labels.forEach((l) => {
      const x = pad.l + (l.at / max) * iw;
      ctx.strokeStyle = AXIS;
      ctx.beginPath(); ctx.moveTo(x, pad.t + ih); ctx.lineTo(x, pad.t + ih + 3); ctx.stroke();
      text(ctx, l.text, x, pad.t + ih + 8, 'center', FAINT, 9);
    });
  }

  // ---------------------------------------------------------
  // Spectrogram: joint time+frequency. Keeps an offscreen
  // history image and scrolls one column per frame.
  // ---------------------------------------------------------
  class Spectrogram {
    constructor(canvas) {
      this.canvas = canvas;
      this.cols = 220;
      this.rows = 64;
      this.off = document.createElement('canvas');
      this.off.width = this.cols;
      this.off.height = this.rows;
      this.octx = this.off.getContext('2d');
      this.octx.fillStyle = '#0b1020';
      this.octx.fillRect(0, 0, this.cols, this.rows);
      this.tmp = document.createElement('canvas');
      this.tmp.width = this.cols;
      this.tmp.height = this.rows;
    }
    push(bins) {
      // scroll left one column, draw the newest on the right
      this.octx.drawImage(this.off, -1, 0);
      const n = bins.length;
      for (let y = 0; y < this.rows; y++) {
        // sample the bins in log order (low freq at the bottom)
        const idx = Math.floor((1 - y / this.rows) * (n - 1));
        const v = (bins[idx] || 0) / 255;
        this.octx.fillStyle = `hsl(${200 - 160 * v}, 90%, ${8 + 55 * v}%)`;
        this.octx.fillRect(this.cols - 1, y, 1, 1);
      }
    }
    draw() {
      const { ctx, w, h } = fit(this.canvas);
      if (w < 4 || h < 4) return;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.off, 0, 0, this.cols, this.rows, 0, 0, w, h);
      text(ctx, 'freq ↑', 4, 8, 'left', 'rgba(255,255,255,.55)', 9);
      text(ctx, 'time →', w - 4, h - 8, 'right', 'rgba(255,255,255,.55)', 9);
    }
  }

  // ---------------------------------------------------------
  // Radial gauge for a bounded proportion with a natural
  // "full" reference (battery %, light level).
  // ---------------------------------------------------------
  function gauge(canvas, { value, min = 0, max = 100, unit = '', label = '', colour = '#4cc2ff' }) {
    const { ctx, w, h } = fit(canvas);
    const cx = w / 2, cy = h * 0.62;
    const r = Math.min(w / 2 - 12, h * 0.52);
    if (r <= 6) return;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(cx, cy, r, A0, A1); ctx.stroke();

    if (Number.isFinite(value)) {
      const t = Math.min(Math.max((value - min) / Math.max(max - min, 1e-9), 0), 1);
      ctx.strokeStyle = colour; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.arc(cx, cy, r, A0, A0 + (A1 - A0) * t); ctx.stroke();
      text(ctx, fmtNum(value) + (unit ? ' ' + unit : ''), cx, cy - 2, 'center', '#e8ecf5', 17);
    } else {
      text(ctx, '—', cx, cy - 2, 'center', FAINT, 17);
    }
    if (label) text(ctx, label, cx, cy + r * 0.60, 'center', TEXT, 10);
    text(ctx, fmtNum(min), cx - r * 0.70, cy + r * 0.36, 'center', FAINT, 9);
    text(ctx, fmtNum(max), cx + r * 0.70, cy + r * 0.36, 'center', FAINT, 9);
  }

  // ---------------------------------------------------------
  // Horizontal level meter with peak hold.
  // ---------------------------------------------------------
  function meter(canvas, { value, peak, min = 0, max = 1, label = '' }) {
    const { ctx, w, h } = fit(canvas);
    const bh = Math.min(h - 26, 16);
    const y = (h - bh) / 2 - 4;
    if (w < 20 || bh <= 2) return;

    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(0, y, w, bh);

    if (Number.isFinite(value)) {
      const t = Math.min(Math.max((value - min) / Math.max(max - min, 1e-9), 0), 1);
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#4ade80'); g.addColorStop(0.7, '#fbbf24'); g.addColorStop(1, '#fb7185');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, w * t, bh);
    }
    if (Number.isFinite(peak)) {
      const px = Math.min(Math.max((peak - min) / Math.max(max - min, 1e-9), 0), 1) * w;
      ctx.fillStyle = '#e8ecf5';
      ctx.fillRect(Math.min(px, w - 2), y - 3, 2, bh + 6);
    }
    if (label) text(ctx, label, 0, h - 8, 'left', TEXT, 10);
  }

  // ---------------------------------------------------------
  // Bubble level: tilt is inherently a 2-D direction, so a
  // crosshair + dot reads far better than three numbers.
  // ---------------------------------------------------------
  function level2d(canvas, { x, y }) {
    const { ctx, w, h } = fit(canvas);
    const cx = w / 2, cy = h / 2;
    // Leave room under the dial for the tilt caption.
    const r = Math.min(w, h) / 2 - 22;
    if (r <= 6) return;

    [0.33, 0.66, 1].forEach((f) => {
      ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * f, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    if (Number.isFinite(x) && Number.isFinite(y)) {
      const clamp = (v) => Math.min(Math.max(v, -1), 1);
      const px = cx + clamp(x) * r, py = cy + clamp(y) * r;
      const off = Math.hypot(clamp(x), clamp(y));
      const colour = off < 0.06 ? '#4ade80' : off < 0.25 ? '#fbbf24' : '#fb7185';
      ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
      text(ctx, off < 0.06 ? 'level' : `${(off * 90).toFixed(0)}° tilt`,
           cx, cy + r + 12, 'center', colour, 10);
    } else {
      text(ctx, 'no data', cx, cy, 'center', FAINT, 11);
    }
  }

  // ---------------------------------------------------------
  // Horizontal bar chart — ranked categorical values with
  // long labels (Bluetooth RSSI per device).
  // ---------------------------------------------------------
  function hbars(canvas, { items, min = -100, max = -30, unit = '' }) {
    const { ctx, w, h } = fit(canvas);
    if (!items.length) { text(ctx, 'no devices', w / 2, h / 2, 'center', FAINT, 11); return; }
    const rowH = Math.min(24, Math.max(14, h / items.length));
    const labelW = Math.min(120, w * 0.38);
    const barW = w - labelW - 52;

    items.forEach((it, i) => {
      const y = i * rowH + rowH / 2;
      if (y > h) return;
      text(ctx, String(it.label).slice(0, 18), 0, y, 'left', TEXT, 10);
      const t = Math.min(Math.max((it.value - min) / Math.max(max - min, 1e-9), 0), 1);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(labelW, y - 6, barW, 12);
      ctx.fillStyle = it.colour || '#4cc2ff';
      ctx.fillRect(labelW, y - 6, barW * t, 12);
      text(ctx, `${fmtNum(it.value)}${unit ? ' ' + unit : ''}`, w - 2, y, 'right', TEXT, 10);
    });
  }

  return { line, polar, bars, Spectrogram, gauge, meter, level2d, hbars, fmtNum, SERIES };
})();
