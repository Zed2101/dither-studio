/* Dither Studio — https://github.com/Zed2101/dither-studio
 * Everything runs locally in the browser: no uploads, no dependencies. */
(() => {
  'use strict';

  /* ========================================================== algorithms */

  const ALGOS = [
    { id: 'fs', name: 'Floyd–Steinberg', desc: 'error diffusion' },
    { id: 'atk', name: 'Atkinson', desc: 'higher contrast' },
    { id: 'jjn', name: 'Jarvis', desc: 'softer grain' },
    { id: 'bayer', name: 'Bayer 8×8', desc: 'ordered grid' },
    { id: 'thr', name: 'Threshold', desc: 'hard cut' },
    { id: 'rnd', name: 'Noise', desc: 'threshold + noise' },
    { id: 'half', name: 'Halftone', desc: 'dot grid' },
  ];

  // Error-diffusion kernels: [dx, dy, weight], normalised by div.
  const KERNELS = {
    fs: { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
    atk: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
    jjn: {
      div: 48,
      taps: [
        [1, 0, 7], [2, 0, 5],
        [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
        [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
      ],
    },
  };

  const HAS_STRENGTH = new Set(['fs', 'atk', 'jjn', 'bayer', 'rnd']);

  /* ============================================================ palettes */

  const hex2rgb = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const rgb2hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** Interpolates a list of [position 0..1, [r,g,b]] stops at t. */
  function sampleStops(stops, t) {
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      const [p1, c1] = stops[i];
      if (t <= p1) {
        const [p0, c0] = stops[i - 1];
        const k = (t - p0) / (p1 - p0);
        return [
          Math.round(c0[0] + (c1[0] - c0[0]) * k),
          Math.round(c0[1] + (c1[1] - c0[1]) * k),
          Math.round(c0[2] + (c1[2] - c0[2]) * k),
        ];
      }
    }
    return stops[stops.length - 1][1];
  }

  /** Samples a continuous ramp into n evenly spaced steps. */
  const ramp = (stops, n) =>
    Array.from({ length: n }, (_, i) => sampleStops(stops, n === 1 ? 0 : i / (n - 1)));

  const GREY_STOPS = [[0, [0, 0, 0]], [1, [255, 255, 255]]];

  // Chocolate shadows, leather midtones, cream highlights.
  const BROWN_STOPS = [
    [0.00, [22, 13, 7]],
    [0.25, [74, 44, 22]],
    [0.50, [131, 87, 46]],
    [0.75, [193, 148, 96]],
    [1.00, [247, 233, 211]],
  ];

  const EGA_16 = [
    '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
    '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff',
  ];

  /* `mono` marks palettes whose colours sit on a single tonal ramp. Those get
   * dithered in luminance space, which keeps the tone clean instead of letting
   * per-channel error introduce colour noise.
   *   'luminance' — each colour is worth its real luminance, so the perceived
   *                 brightness of the original survives (sepia print look).
   *   'index'     — the ramp is treated as N evenly spaced steps and the whole
   *                 0..255 range is remapped onto it. Needed for hardware
   *                 palettes that do not span the full scale: the Game Boy
   *                 greens stop at ~169, so in 'luminance' mode every highlight
   *                 would collapse onto the lightest tone.                    */
  const PALETTES = [
    { id: 'bw', name: 'Black & white', mono: 'luminance', colors: ramp(GREY_STOPS, 2) },
    { id: 'gray4', name: '4 grays', mono: 'luminance', colors: ramp(GREY_STOPS, 4) },
    { id: 'gray16', name: '16 grays', mono: 'luminance', colors: ramp(GREY_STOPS, 16) },
    { id: 'gb', name: 'Game Boy', mono: 'index', colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'].map(hex2rgb) },
    { id: 'sepia', name: 'Sepia', mono: 'luminance', colors: ['#2b1d0e', '#6b4a2b', '#c49a6c', '#f4e9d8'].map(hex2rgb) },
    { id: 'brown', name: '16 browns', mono: 'luminance', colors: ramp(BROWN_STOPS, 16) },
    { id: 'cga', name: 'CGA', colors: ['#000000', '#55ffff', '#ff55ff', '#ffffff'].map(hex2rgb) },
    { id: 'ega', name: 'EGA 16', colors: EGA_16.map(hex2rgb) },
    { id: 'rgb', name: '8 colors', colors: ['#000000', '#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ff00ff', '#ffff00', '#ffffff'].map(hex2rgb) },
    { id: 'custom', name: 'Custom', colors: null },
  ];

  /** Turns a colour list into the lookup tables the dither loops need. */
  function preparePalette(colors, mono) {
    // A custom palette of pure grays behaves like a tonal ramp too.
    if (mono === undefined) {
      mono = colors.every((c) => c[0] === c[1] && c[1] === c[2]) ? 'luminance' : null;
    }
    if (!mono) return { mono: null, colors };

    const sorted = [...colors].sort((a, b) => lum(a) - lum(b));
    const n = sorted.length;
    const levels =
      mono === 'index'
        ? sorted.map((_, i) => (n === 1 ? 0 : (i * 255) / (n - 1)))
        : sorted.map(lum);
    return {
      mono,
      colors: sorted,
      levels,
      lo: levels[0],
      hi: levels[n - 1],
      spread: n > 1 ? (levels[n - 1] - levels[0]) / (n - 1) : 255,
    };
  }

  /* =============================================================== bayer */

  function bayerMatrix(n) {
    if (n === 1) return [[0]];
    const half = bayerMatrix(n / 2);
    const h = n / 2;
    const m = Array.from({ length: n }, () => new Array(n));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const v = half[y][x] * 4;
        m[y][x] = v;
        m[y][x + h] = v + 2;
        m[y + h][x] = v + 3;
        m[y + h][x + h] = v + 1;
      }
    }
    return m;
  }

  const BAYER_N = 8;
  // Normalised to (-0.5, +0.5) so it can be scaled by the palette step.
  const BAYER = bayerMatrix(BAYER_N).map((row) => row.map((v) => (v + 0.5) / (BAYER_N * BAYER_N) - 0.5));

  /* ============================================================== dither */

  function nearestIndex(levels, v) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < levels.length; i++) {
      const d = Math.abs(levels[i] - v);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  function nearestColor(colors, r, g, b) {
    let best = colors[0];
    let bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      // Weighted distance: a cheap perceptual approximation.
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** Single-channel dithering for palettes that live on one tonal ramp. */
  function ditherMono(data, w, h, pal, algo, bias, strength) {
    const { colors, levels, lo, hi, spread } = pal;
    const n = w * h;
    // Float buffer: quantisation error must accumulate untruncated, otherwise
    // half the diffusion is lost to integer rounding on smooth gradients.
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      buf[i] = clamp(0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2] + bias, lo, hi);
    }

    const kernel = KERNELS[algo];
    const noise = strength * 160;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = buf[i];
        if (algo === 'rnd') v += (Math.random() - 0.5) * noise;
        else if (algo === 'bayer') v += BAYER[y % BAYER_N][x % BAYER_N] * spread * strength;

        const k = nearestIndex(levels, v);
        const c = colors[k];
        const j = i * 4;
        data[j] = c[0]; data[j + 1] = c[1]; data[j + 2] = c[2]; data[j + 3] = 255;

        if (kernel) {
          const err = (buf[i] - levels[k]) * strength;
          for (const [dx, dy, wt] of kernel.taps) {
            const nx = x + dx, ny = y + dy;
            // Explicit bounds check: without it the error from the rightmost
            // pixel would wrap back into the left edge of the next row.
            if (nx < 0 || nx >= w || ny >= h) continue;
            const t = ny * w + nx;
            buf[t] = clamp(buf[t] + (err * wt) / kernel.div, lo, hi);
          }
        }
      }
    }
  }

  /** Full RGB dithering, one error plane per channel. */
  function ditherColor(data, w, h, pal, algo, bias, strength) {
    const { colors } = pal;
    const n = w * h;
    const buf = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      buf[i * 3] = clamp(data[j] + bias, 0, 255);
      buf[i * 3 + 1] = clamp(data[j + 1] + bias, 0, 255);
      buf[i * 3 + 2] = clamp(data[j + 2] + bias, 0, 255);
    }

    const kernel = KERNELS[algo];
    const noise = strength * 160;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];

        if (algo === 'rnd') {
          const nz = (Math.random() - 0.5) * noise;
          r += nz; g += nz; b += nz;
        } else if (algo === 'bayer') {
          const nz = BAYER[y % BAYER_N][x % BAYER_N] * 110 * strength;
          r += nz; g += nz; b += nz;
        }

        const c = nearestColor(colors, r, g, b);
        const j = i * 4;
        data[j] = c[0]; data[j + 1] = c[1]; data[j + 2] = c[2]; data[j + 3] = 255;

        if (kernel) {
          const er = (buf[i * 3] - c[0]) * strength;
          const eg = (buf[i * 3 + 1] - c[1]) * strength;
          const eb = (buf[i * 3 + 2] - c[2]) * strength;
          for (const [dx, dy, wt] of kernel.taps) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny >= h) continue;
            const t = (ny * w + nx) * 3;
            const f = wt / kernel.div;
            buf[t] = clamp(buf[t] + er * f, 0, 255);
            buf[t + 1] = clamp(buf[t + 1] + eg * f, 0, 255);
            buf[t + 2] = clamp(buf[t + 2] + eb * f, 0, 255);
          }
        }
      }
    }
  }

  const mk = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  /** Variable-radius dots on a fixed grid, the way a newspaper screen works. */
  function halftone(img, ctx, ow, oh, colors, cellPx, bias) {
    const sorted = [...colors].sort((a, b) => lum(a) - lum(b));
    const dark = sorted[0];
    const light = sorted[sorted.length - 1];
    const cw = Math.ceil(ow / cellPx);
    const ch = Math.ceil(oh / cellPx);

    const small = mk(cw, ch);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, cw, ch);
    const d = sctx.getImageData(0, 0, cw, ch).data;

    ctx.fillStyle = `rgb(${light.join(',')})`;
    ctx.fillRect(0, 0, ow, oh);
    ctx.fillStyle = `rgb(${dark.join(',')})`;

    const R = cellPx * 0.72;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const l = clamp(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] + bias, 0, 255);
        const r = R * Math.sqrt(1 - l / 255);
        if (r < 0.3) continue;
        ctx.beginPath();
        ctx.arc(x * cellPx + cellPx / 2, y * cellPx + cellPx / 2, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ================================================================ zip */
  /* A minimal store-only ZIP writer. PNG bytes are already compressed, so
   * there is nothing to gain from deflate and nothing to depend on. */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    const items = entries.map((e) => {
      const name = enc.encode(e.name);
      return { name, data: e.data, crc: crc32(e.data) };
    });

    const localSize = items.reduce((s, it) => s + 30 + it.name.length + it.data.length, 0);
    const centralSize = items.reduce((s, it) => s + 46 + it.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let off = 0;

    for (const it of items) {
      it.offset = off;
      view.setUint32(off, 0x04034b50, true);
      view.setUint16(off + 4, 20, true);
      view.setUint16(off + 6, 0x0800, true); // UTF-8 file names
      view.setUint16(off + 8, 0, true);      // stored, no compression
      view.setUint16(off + 10, time, true);
      view.setUint16(off + 12, date, true);
      view.setUint32(off + 14, it.crc, true);
      view.setUint32(off + 18, it.data.length, true);
      view.setUint32(off + 22, it.data.length, true);
      view.setUint16(off + 26, it.name.length, true);
      view.setUint16(off + 28, 0, true);
      out.set(it.name, off + 30);
      out.set(it.data, off + 30 + it.name.length);
      off += 30 + it.name.length + it.data.length;
    }

    const cdStart = off;
    for (const it of items) {
      view.setUint32(off, 0x02014b50, true);
      view.setUint16(off + 4, 20, true);
      view.setUint16(off + 6, 20, true);
      view.setUint16(off + 8, 0x0800, true);
      view.setUint16(off + 10, 0, true);
      view.setUint16(off + 12, time, true);
      view.setUint16(off + 14, date, true);
      view.setUint32(off + 16, it.crc, true);
      view.setUint32(off + 20, it.data.length, true);
      view.setUint32(off + 24, it.data.length, true);
      view.setUint16(off + 28, it.name.length, true);
      view.setUint16(off + 30, 0, true);
      view.setUint16(off + 32, 0, true);
      view.setUint16(off + 34, 0, true);
      view.setUint16(off + 36, 0, true);
      view.setUint32(off + 38, 0, true);
      view.setUint32(off + 42, it.offset, true);
      out.set(it.name, off + 46);
      off += 46 + it.name.length;
    }

    view.setUint32(off, 0x06054b50, true);
    view.setUint16(off + 4, 0, true);
    view.setUint16(off + 6, 0, true);
    view.setUint16(off + 8, items.length, true);
    view.setUint16(off + 10, items.length, true);
    view.setUint32(off + 12, off - cdStart, true);
    view.setUint32(off + 16, cdStart, true);
    view.setUint16(off + 20, 0, true);

    return new Blob([out], { type: 'application/zip' });
  }

  /* =============================================================== state */

  const PREVIEW_MAX = 1400;

  const state = {
    images: [],
    active: 0,
    algo: 'fs',
    pixel: 2,
    bias: 0,
    strength: 100,
    cell: 8,
    paletteId: 'bw',
    custom: ['#1a1a2e', '#e94560', '#f5f5f5'],
    split: 50,
    zoom: 1,
    panX: 0,
    panY: 0,
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    root: $('root'), file: $('file'), status: $('status'), theme: $('theme'),
    stage: $('stage'), viewer: $('viewer'), orig: $('orig'), dith: $('dith'), clip: $('clip'),
    divider: $('divider'), dropzone: $('dropzone'), dropCard: $('dropCard'), overlay: $('overlay'),
    demo: $('demo'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'),
    algoTag: $('algoTag'), thumbs: $('thumbs'), noImages: $('noImages'), add: $('add'),
    algos: $('algos'), palettes: $('palettes'), customRow: $('customRow'),
    pixel: $('pixel'), bias: $('bias'), strength: $('strength'), cell: $('cell'),
    pixelVal: $('pixelVal'), biasVal: $('biasVal'), strengthVal: $('strengthVal'), cellVal: $('cellVal'),
    strengthField: $('strengthField'), cellField: $('cellField'),
    exportInfo: $('exportInfo'), png: $('png'), copy: $('copy'), zip: $('zip'),
    toast: $('toast'),
  };

  const current = () => state.images[state.active];
  const paletteColors = () => {
    const p = PALETTES.find((x) => x.id === state.paletteId);
    if (p.id !== 'custom') return { colors: p.colors, mono: p.mono ?? null };
    const cols = state.custom.length ? state.custom : ['#000000', '#ffffff'];
    return { colors: cols.map(hex2rgb), mono: undefined }; // undefined = auto-detect
  };

  /* ============================================================ pipeline */

  function compute(entry, full) {
    const { pixel, algo, bias, strength } = state;
    const spec = paletteColors();
    const pal = preparePalette(spec.colors, spec.mono);

    let W = entry.w, H = entry.h;
    if (!full) {
      const m = Math.max(W, H);
      if (m > PREVIEW_MAX) {
        const s = PREVIEW_MAX / m;
        W = Math.round(W * s);
        H = Math.round(H * s);
      }
    }

    const sw = Math.max(1, Math.floor(W / pixel));
    const sh = Math.max(1, Math.floor(H / pixel));
    const ow = sw * pixel, oh = sh * pixel;

    const orig = mk(ow, oh);
    orig.getContext('2d').drawImage(entry.img, 0, 0, ow, oh);

    const dith = mk(ow, oh);
    const dctx = dith.getContext('2d');

    if (algo === 'half') {
      halftone(entry.img, dctx, ow, oh, pal.colors, state.cell * pixel, bias);
    } else {
      const small = mk(sw, sh);
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(entry.img, 0, 0, sw, sh);
      const id = sctx.getImageData(0, 0, sw, sh);
      const fn = pal.mono ? ditherMono : ditherColor;
      fn(id.data, sw, sh, pal, algo, bias, strength / 100);
      sctx.putImageData(id, 0, 0);
      dctx.imageSmoothingEnabled = false;
      dctx.drawImage(small, 0, 0, ow, oh);
    }

    return { orig, dith, ow, oh };
  }

  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  };

  let outW = 0, outH = 0;

  function draw() {
    const entry = current();
    if (!entry) return;
    const { orig, dith, ow, oh } = compute(entry, false);
    el.orig.width = ow; el.orig.height = oh;
    el.orig.getContext('2d').drawImage(orig, 0, 0);
    el.dith.width = ow; el.dith.height = oh;
    el.dith.getContext('2d').drawImage(dith, 0, 0);
    outW = ow; outH = oh;
    fit();
  }

  /** Sizes both canvases so the image fits the stage, then applies pan/zoom. */
  function fit() {
    if (!outW) return;
    const pad = 32;
    const s = Math.min((el.stage.clientWidth - pad) / outW, (el.stage.clientHeight - pad) / outH);
    const w = Math.round(outW * s) + 'px';
    const h = Math.round(outH * s) + 'px';
    for (const c of [el.orig, el.dith]) {
      c.style.width = w;
      c.style.height = h;
    }
    applyView();
  }

  function applyView() {
    const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    el.orig.style.transform = t;
    el.dith.style.transform = t;
    el.clip.style.clipPath = `inset(0 0 0 ${state.split}%)`;
    el.divider.style.left = state.split + '%';
    el.zoomReset.textContent = Math.round(state.zoom * 100) + '%';
    el.stage.classList.toggle('panning', state.zoom > 1);
  }

  /* ================================================================= ui */

  function renderAlgos() {
    el.algos.replaceChildren(...ALGOS.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'algo';
      b.role = 'radio';
      b.setAttribute('aria-checked', String(a.id === state.algo));
      b.setAttribute('aria-label', `${a.name} — ${a.desc}`);
      b.innerHTML = `<b></b><span></span>`;
      b.firstChild.textContent = a.name;
      b.lastChild.textContent = a.desc;
      b.onclick = () => {
        state.algo = a.id;
        renderAlgos();
        syncParams();
        schedule();
      };
      return b;
    }));
    el.algoTag.textContent = ALGOS.find((a) => a.id === state.algo).name;
  }

  function renderPalettes() {
    el.palettes.replaceChildren(...PALETTES.map((p) => {
      const cols = p.colors
        ? p.colors.map(rgb2hex)
        : (state.custom.length ? state.custom : ['#000000', '#ffffff']);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'palette';
      b.role = 'radio';
      b.setAttribute('aria-checked', String(p.id === state.paletteId));
      b.setAttribute('aria-label', p.name);
      const name = document.createElement('b');
      name.textContent = p.name;
      const sw = document.createElement('span');
      sw.className = 'swatch';
      for (const c of cols) {
        const i = document.createElement('i');
        i.style.background = c;
        sw.append(i);
      }
      b.append(name, sw);
      b.onclick = () => {
        state.paletteId = p.id;
        renderPalettes();
        schedule();
      };
      return b;
    }));
    el.customRow.hidden = state.paletteId !== 'custom';
    if (!el.customRow.hidden) renderCustom();
  }

  function renderCustom() {
    const nodes = state.custom.map((hex, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'chip';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = hex;
      input.oninput = () => {
        state.custom[i] = input.value;
        renderPalettes();
        schedule();
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove colour';
      del.onclick = () => {
        if (state.custom.length > 1) state.custom.splice(i, 1);
        renderPalettes();
        schedule();
      };
      wrap.append(input, del);
      return wrap;
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip-add';
    add.textContent = '+';
    add.title = 'Add colour';
    add.onclick = () => {
      state.custom.push('#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'));
      renderPalettes();
      schedule();
    };
    el.customRow.replaceChildren(...nodes, add);
  }

  function renderThumbs() {
    const has = state.images.length > 0;
    el.thumbs.hidden = !has;
    el.noImages.hidden = has;
    el.viewer.hidden = !has;
    el.dropzone.hidden = has;
    el.stage.classList.toggle('empty', !has);
    for (const b of [el.png, el.copy, el.zip]) b.disabled = !has;

    el.thumbs.replaceChildren(...state.images.map((it, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'thumb-pick';
      pick.role = 'radio';
      pick.setAttribute('aria-checked', String(i === state.active));
      pick.title = it.name;
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = it.name;
      pick.append(img);
      pick.onclick = () => {
        state.active = i;
        resetView();
        renderThumbs();
        syncStatus();
        schedule();
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'thumb-del';
      del.textContent = '×';
      del.title = 'Remove';
      del.onclick = () => removeImage(i);
      wrap.append(pick, del);
      return wrap;
    }));
  }

  function removeImage(i) {
    const [gone] = state.images.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    state.active = clamp(state.active >= i ? state.active - 1 : state.active, 0, Math.max(0, state.images.length - 1));
    renderThumbs();
    syncStatus();
    if (state.images.length) schedule();
  }

  function syncParams() {
    el.pixelVal.textContent = state.pixel + 'px';
    el.biasVal.textContent = state.bias;
    el.strengthVal.textContent = state.strength + '%';
    el.cellVal.textContent = state.cell + 'px';
    el.strengthField.hidden = !HAS_STRENGTH.has(state.algo);
    el.cellField.hidden = state.algo !== 'half';
  }

  function syncStatus() {
    const e = current();
    const n = state.images.length;
    el.status.textContent = e ? `${e.name} · ${e.w}×${e.h}` : '';
    el.exportInfo.textContent = e
      ? `${e.w}×${e.h} px · ${n} image${n === 1 ? '' : 's'}`
      : 'Load an image to export';
    el.zip.textContent = state.busy ? '…' : `ZIP (${n})`;
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
  }

  /* ============================================================== import */

  function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    Promise.all(list.map((f) => new Promise((res) => {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => res({ name: f.name.replace(/\.[^.]+$/, ''), img, url, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    }))).then((items) => {
      const ok = items.filter(Boolean);
      if (!ok.length) return;
      state.active = state.images.length;
      state.images.push(...ok);
      resetView();
      renderThumbs();
      syncStatus();
      schedule();
    });
  }

  function loadDemo() {
    const c = mk(900, 600);
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 900, 600);
    g.addColorStop(0, '#1e3a5f');
    g.addColorStop(0.5, '#c9a227');
    g.addColorStop(1, '#f2e9dc');
    x.fillStyle = g;
    x.fillRect(0, 0, 900, 600);

    const rg = x.createRadialGradient(620, 240, 20, 620, 240, 260);
    rg.addColorStop(0, '#ffffff');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = rg;
    x.fillRect(0, 0, 900, 600);

    x.fillStyle = '#0b0f14';
    x.beginPath(); x.arc(260, 330, 150, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#7aa6c2';
    x.beginPath(); x.arc(300, 290, 70, 0, Math.PI * 2); x.fill();
    for (let i = 0; i < 12; i++) {
      x.fillStyle = `rgba(255,255,255,${0.15 + i * 0.06})`;
      x.fillRect(40 + i * 68, 480, 50, 90);
    }

    const img = new Image();
    img.onload = () => {
      state.active = state.images.length;
      state.images.push({ name: 'demo', img, url: img.src, w: 900, h: 600 });
      resetView();
      renderThumbs();
      syncStatus();
      schedule();
    };
    img.src = c.toDataURL();
  }

  /* ============================================================== export */

  const blobOf = (entry) => new Promise((res) => compute(entry, true).dith.toBlob(res, 'image/png'));

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function exportPng() {
    const e = current();
    if (!e) return;
    download(await blobOf(e), `${e.name}-${state.algo}.png`);
  }

  async function copyPng() {
    const e = current();
    if (!e) return;
    try {
      const blob = await blobOf(e);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied to clipboard');
    } catch {
      toast('Clipboard not available here');
    }
  }

  async function exportZip() {
    if (!state.images.length || state.busy) return;
    state.busy = true;
    syncStatus();
    try {
      const used = new Map();
      const entries = [];
      for (const e of state.images) {
        let name = `${e.name}-${state.algo}.png`;
        const seen = used.get(name) || 0;
        used.set(name, seen + 1);
        if (seen) name = `${e.name}-${state.algo}-${seen + 1}.png`;
        const blob = await blobOf(e);
        entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
        await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
      }
      download(zipStore(entries), 'dither-studio.zip');
      toast(`${entries.length} image${entries.length === 1 ? '' : 's'} zipped`);
    } finally {
      state.busy = false;
      syncStatus();
    }
  }

  /* ============================================================== viewer */

  function resetView() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyView();
  }

  function zoomBy(f) {
    state.zoom = clamp(state.zoom * f, 1, 16);
    if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
    applyView();
  }

  const pointers = new Map();
  let mode = null;
  let pinch = 0;

  function moveSplit(cx) {
    const r = el.stage.getBoundingClientRect();
    state.split = clamp(((cx - r.left) / r.width) * 100, 0, 100);
    applyView();
  }

  el.stage.addEventListener('pointerdown', (e) => {
    if (!state.images.length || e.target.closest('.zoombar')) return;
    el.stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) { mode = 'pinch'; pinch = 0; return; }
    mode = e.target.closest('.handle') || state.zoom === 1 ? 'split' : 'pan';
    if (mode === 'split') moveSplit(e.clientX);
  });

  el.stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomBy(d / pinch);
      pinch = d;
      return;
    }
    if (mode === 'split') moveSplit(e.clientX);
    else if (mode === 'pan') {
      state.panX += (e.clientX - prev.x) / state.zoom;
      state.panY += (e.clientY - prev.y) / state.zoom;
      applyView();
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) mode = null;
  };
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);
  el.stage.addEventListener('dblclick', resetView);

  el.stage.addEventListener('wheel', (e) => {
    if (!state.images.length) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  /* ============================================================ wiring */

  el.add.onclick = () => el.file.click();
  el.dropCard.onclick = () => el.file.click();
  el.demo.onclick = (e) => { e.stopPropagation(); loadDemo(); };
  el.file.onchange = () => { addFiles(el.file.files); el.file.value = ''; };

  el.zoomIn.onclick = () => zoomBy(1.25);
  el.zoomOut.onclick = () => zoomBy(1 / 1.25);
  el.zoomReset.onclick = resetView;

  el.png.onclick = exportPng;
  el.copy.onclick = copyPng;
  el.zip.onclick = exportZip;

  for (const key of ['pixel', 'bias', 'strength', 'cell']) {
    el[key].oninput = () => {
      state[key] = +el[key].value;
      syncParams();
      schedule();
    };
  }

  let dragDepth = 0;
  el.root.addEventListener('dragover', (e) => e.preventDefault());
  el.root.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    el.overlay.hidden = false;
  });
  el.root.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.overlay.hidden = true;
  });
  el.root.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.overlay.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  /* =============================================================== theme */

  function setTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    el.theme.textContent = dark ? 'Light' : 'Dark';
    try { localStorage.setItem('dither.theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  }

  const saved = (() => {
    try { return localStorage.getItem('dither.theme'); } catch { return null; }
  })();
  setTheme(saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  el.theme.onclick = () => setTheme(!document.documentElement.classList.contains('dark'));

  /* ================================================================ boot */

  new ResizeObserver(fit).observe(el.stage);

  el.pixel.value = state.pixel;
  el.bias.value = state.bias;
  el.strength.value = state.strength;
  el.cell.value = state.cell;

  renderAlgos();
  renderPalettes();
  renderThumbs();
  syncParams();
  syncStatus();
  applyView();
})();
