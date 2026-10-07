// M3 scenarios for tests/browser/stress.mjs: masks, filters, text, particles.
// Installed into globalThis.stress by stress-page.js, which passes its shared
// helpers in (the page keeps one context registry for every scenario).
// Every function returns plain JSON; the Node side decides pass/fail.
import * as GPU from 'cozygpu';

export function installM3(h) {
  const { createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase, swarmSupported } = h;

  // ─── Shared bits ──────────────────────────────────────────────────────────
  const W = 640;
  const H = 480;
  const mulberry = seed => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tex = { white: null };
  const white = () => (tex.white ??= GPU.Texture.fromPixels(1, 1, new Uint8Array([255, 255, 255, 255])));
  const rect = (x, y, w, hh, tint, extra) => new GPU.Sprite({ texture: white(), x, y, width: w, height: hh, tint, ...extra });
  const tryCall = (out, label, f) => {
    try {
      return f();
    } catch (e) {
      if (out.length < 20) out.push(`${label}: ${errText(e)}`);
      return undefined;
    }
  };

  /** Per-rect colour stats of a PNG (rects in CSS px, scaled by `scale`). */
  async function regionColors(b64, rects, scale = 0) {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    // 0: derive from the image (the canvas is 640 CSS px wide).
    if (!scale) scale = bmp.width / W;
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const g = oc.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = {};
    for (const [name, r] of Object.entries(rects)) {
      const [rx, ry, rw, rh] = r.map(v => Math.round(v * scale));
      let n = 0;
      let lit = 0;
      let blue = 0;
      let red = 0;
      let green = 0;
      let gray = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      const x1 = Math.min(bmp.width, rx + rw);
      const y1 = Math.min(bmp.height, ry + rh);
      for (let y = Math.max(0, ry); y < y1; y++) {
        for (let x = Math.max(0, rx); x < x1; x++) {
          const i = (y * bmp.width + x) * 4;
          const R = d[i];
          const G = d[i + 1];
          const B = d[i + 2];
          n++;
          sr += R;
          sg += G;
          sb += B;
          if (R + G + B > 90) {
            lit++;
            if (Math.abs(R - G) < 28 && Math.abs(G - B) < 28) gray++;
          }
          if (B > 150 && R < 160) blue++;
          if (R > 150 && G < 100 && B < 100) red++;
          if (G > 150 && R < 120 && B < 120) green++;
        }
      }
      const f = v => (n ? +(v / n).toFixed(3) : 0);
      out[name] = { n, scale: +scale.toFixed(3), lit: f(lit), blue: f(blue), red: f(red), green: f(green), gray: f(gray), mean: n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null };
    }
    return { w: bmp.width, h: bmp.height, regions: out };
  }

  /** Realm-agnostic probe of the filter/mask target pool (debug core only). */
  const poolProbeSource = `(() => {
    const core = globalThis.__COZYGPU_CORE__;
    if (!core) return null;
    const out = { systems: [] };
    for (const w of core.systemsByRange || []) {
      if (!w) continue;
      const s = w.inner || w;
      out.systems.push(s.name);
      if ((s.name === 'filter' || s.name === 'mask') && s.pool && out.bytes === undefined) {
        out.bytes = s.pool.bytes;
        out.entries = s.pool.entries ? s.pool.entries.length : null;
        out.held = s.pool.held ?? null;
      }
    }
    return out;
  })()`;

  function loopInfo(ctx) {
    const r = ctx.renderer;
    return {
      frameId: r.stats.frameId,
      drawCalls: r.stats.drawCalls,
      packetBytes: r.stats.packetBytes,
      cpuMs: +r.stats.cpuMs.toFixed(3),
      loopFrames: ctx.loop?.frames ?? null,
      loopThrows: ctx.loop?.throws ?? [],
      lost: ctx.events.lost.length,
      restored: ctx.events.restored,
      destroyed: r.destroyed,
      width: r.width,
      height: r.height,
      resolution: r.resolution,
    };
  }

  // ─── Masks ────────────────────────────────────────────────────────────────
  // Panel i (0 scissor, 1 stencil, 2 alpha) at px = 20 + 210·i, py = 20, 180².
  // Outer group G1: mask covers x ∈ [px, px+120]. Inner G2 (child of G1):
  // mask covers y ∈ [py+60, py+180]. Content: a blue 180² sprite inside G2.
  const MASK_MODES = ['scissor', 'stencil', 'alpha'];
  const panelX = i => 20 + 210 * i;
  const PY = 20;

  function maskRegions() {
    const r = {};
    for (let i = 0; i < 3; i++) {
      const px = panelX(i);
      r[`p${i}.in`] = [px + 10, PY + 70, 100, 100];
      r[`p${i}.top`] = [px + 10, PY + 5, 100, 45];
      r[`p${i}.right`] = [px + 130, PY + 70, 40, 100];
    }
    r.ctrlBefore = [20, 300, 80, 80];
    r.ctrlAfter = [120, 300, 80, 80];
    r.ctrlGroup = [220, 300, 80, 80];
    return r;
  }

  function buildMaskPanel(ctx, i) {
    const px = panelX(i);
    const mode = MASK_MODES[i];
    const outerSrc = i === 0 ? { x: px, y: PY, width: 120, height: 180 } : rect(px, PY, 120, 180, 0xffffff);
    const innerSrc = i === 0 ? { x: px, y: PY + 60, width: 180, height: 120 } : rect(px, PY + 60, 180, 120, 0xffffff);
    const g1 = new GPU.Group();
    const g2 = new GPU.Group();
    const content = rect(px, PY, 180, 180, 0x3366ff);
    g2.addChild(content);
    g1.addChild(g2);
    return { i, px, mode, g1, g2, content, outerSrc, innerSrc };
  }

  /** Puts a panel back into a known state (after churn). */
  function applyMaskConfig(P, cfg) {
    const { px } = P;
    if (P.outerSrc instanceof GPU.Sprite) {
      P.outerSrc.x = px;
      P.outerSrc.y = PY;
      P.outerSrc.rotation = 0;
      P.outerSrc.width = 120;
      P.outerSrc.height = 180;
      P.innerSrc.x = px;
      P.innerSrc.y = PY + 60;
      P.innerSrc.rotation = 0;
      P.innerSrc.width = 180;
      P.innerSrc.height = 120;
    }
    if (P.g2.destroyed || P.g2._destroyed) {
      P.g2 = new GPU.Group();
      P.content = rect(px, PY, 180, 180, 0x3366ff);
      P.g2.addChild(P.content);
    }
    if (P.g2.parent !== P.g1) P.g1.addChild(P.g2);
    if (P.content.parent !== P.g2) P.g2.addChild(P.content);
    P.content.visible = true;
    P.content.x = px;
    P.content.y = PY;
    P.g1.visible = true;
    P.g2.visible = true;
    P.g1.mask = { source: P.outerSrc, mode: P.mode, invert: !!cfg.outerInvert };
    P.g2.mask = { source: P.innerSrc, mode: P.mode, invert: !!cfg.innerInvert };
  }

  async function maskInit({ worker, backend, debug = true }) {
    phase('maskInit');
    const ctx = await createCtx({ worker, backend, debug });
    await GPU.loadEffects();
    const stage = ctx.renderer.stage;
    stage.addChild(rect(20, 300, 80, 80, 0xff2020)); // control before
    ctx.panels = [];
    for (let i = 0; i < 3; i++) {
      const P = buildMaskPanel(ctx, i);
      stage.addChild(P.g1);
      ctx.panels.push(P);
      applyMaskConfig(P, {});
    }
    stage.addChild(rect(120, 300, 80, 80, 0xff2020)); // control after
    const plain = new GPU.Group();
    plain.addChild(rect(220, 300, 80, 80, 0x20ff20));
    stage.addChild(plain);
    ctx.deepRoot = new GPU.Container();
    stage.addChild(ctx.deepRoot);
    ctx.churnErrors = [];
    startLoop(ctx);
    await Promise.all(ctx.panels.map(P => P.g1.ready));
    await sleep(300);
    return { ctxId: registerCtx(ctx), regions: maskRegions(), stencilCap: !!ctx.renderer.info.capabilities.stencil, backend: ctx.renderer.info.backend };
  }

  function maskModes(id) {
    const ctx = getCtx(id);
    return ctx.panels.map(P => ({ outer: P.g1._maskBinding?.mode ?? null, inner: P.g2._maskBinding?.mode ?? null }));
  }

  async function maskSet(id, cfg) {
    const ctx = getCtx(id);
    const errs = [];
    for (const P of ctx.panels) tryCall(errs, `apply p${P.i}`, () => applyMaskConfig(P, cfg));
    await sleep(250);
    return { errs, modes: maskModes(id), ...loopInfo(ctx) };
  }

  /** Random mask churn for `seconds`: invert, mode swaps, null, reparent, destroy. */
  async function maskChurn(id, { seconds = 6, seed = 7 }) {
    const ctx = getCtx(id);
    const rnd = mulberry(seed);
    const errs = ctx.churnErrors;
    const ops = {};
    const modes = ['auto', 'scissor', 'stencil', 'alpha'];
    const op = f => {
      const P = ctx.panels[Math.floor(rnd() * 3)];
      const k = Math.floor(rnd() * 11);
      ops[k] = (ops[k] ?? 0) + 1;
      tryCall(errs, `op${k}`, () => {
        switch (k) {
          case 0:
            P.g1.mask = { source: P.outerSrc, mode: modes[Math.floor(rnd() * 4)], invert: rnd() < 0.5 };
            break;
          case 1:
            P.g2.mask = { source: P.innerSrc, mode: modes[Math.floor(rnd() * 4)], invert: rnd() < 0.5 };
            break;
          case 2:
            P.g2.mask = null;
            break;
          case 3:
            P.g1.mask = null;
            break;
          case 4:
            if (P.g2.parent) P.g1.removeChild(P.g2);
            else P.g1.addChild(P.g2);
            break;
          case 5: {
            // Destroy the inner group (and its content) and build a new one.
            P.g2.destroy({ children: true });
            P.g2 = new GPU.Group();
            P.content = rect(P.px, PY, 180, 180, 0x3366ff);
            P.g2.addChild(P.content);
            P.g1.addChild(P.g2);
            P.g2.mask = { source: P.innerSrc, mode: modes[Math.floor(rnd() * 4)], invert: rnd() < 0.5 };
            break;
          }
          case 6:
            if (P.outerSrc instanceof GPU.Sprite) {
              P.outerSrc.rotation = rnd() * 6.28;
              P.innerSrc.x = P.px + (rnd() - 0.5) * 60;
            } else {
              P.g1.mask = { source: { x: P.px + rnd() * 60, y: PY, width: rnd() * 200, height: rnd() * 200 }, mode: 'scissor' };
            }
            break;
          case 7:
            P.content.visible = !P.content.visible;
            break;
          case 8:
            // A mask whose source is a group containing another masked group.
            P.g1.mask = { source: P.g2, mode: 'alpha' };
            break;
          case 9:
            // Zero-sized and off-screen rect masks.
            P.g2.mask = rnd() < 0.5 ? { x: -500, y: -500, width: 10, height: 10 } : { x: P.px, y: PY, width: 0, height: 0 };
            break;
          case 10:
            // Filters on a masked group (combined effects).
            P.g2.filters = rnd() < 0.5 ? [GPU.filters.blur({ strength: 2 })] : null;
            break;
        }
      });
      if (f % 60 === 59) {
        // Restore every second, so the steady path runs in between.
        for (const Q of ctx.panels) tryCall(errs, 'restore', () => { Q.g2.filters = null; applyMaskConfig(Q, {}); });
      }
    };
    startLoop(ctx, f => {
      for (let n = 0; n < 4; n++) op(f);
    });
    await sleep(seconds * 1000);
    const throws = ctx.loop?.throws ?? [];
    stopLoop(ctx);
    for (const P of ctx.panels) tryCall(errs, 'final restore', () => { P.g2.filters = null; applyMaskConfig(P, {}); });
    startLoop(ctx);
    await sleep(400);
    return { ops, errs: errs.slice(0, 10), throws, ...loopInfo(ctx) };
  }

  /** 9 nested masked groups (one past MASK_MAX_DEPTH) in `mode`. */
  async function maskDeep(id, { mode = 'scissor', levels = 9 }) {
    const ctx = getCtx(id);
    const errs = [];
    deepClear(id);
    let parent = ctx.deepRoot;
    for (let k = 0; k < levels; k++) {
      const g = new GPU.Group();
      const x = 320 + 8 * k;
      const y = 230 + 8 * k;
      const w = 300 - 16 * k;
      const hh = 240 - 16 * k;
      tryCall(errs, `level ${k}`, () => {
        g.mask = mode === 'scissor' ? { x, y, width: w, height: hh } : { source: rect(x, y, w, hh, 0xffffff), mode };
      });
      parent.addChild(g);
      parent = g;
    }
    parent.addChild(rect(300, 210, 340, 270, 0x3366ff));
    await sleep(400);
    return {
      errs,
      ...loopInfo(ctx),
      regions: {
        // inside level 0, outside level 1: level 1 must clip it
        ring1: [322, 232, 5, 230],
        // between level 7 and level 8 (the 9th, one past the limit)
        ring8: [320 + 8 * 7 + 1, 300, 6, 40],
        center: [440, 320, 60, 60],
        outside: [300, 212, 15, 260],
      },
    };
  }

  function deepClear(id) {
    const ctx = getCtx(id);
    while (ctx.deepRoot._children?.length) {
      const c = ctx.deepRoot._children[0];
      ctx.deepRoot.removeChild(c);
      c.destroy?.({ children: true });
    }
  }

  // ─── Filters ──────────────────────────────────────────────────────────────
  const pixelate = GPU.defineFilter({
    name: 'stressPixelate',
    params: { block: 'f32' },
    defaults: { block: 6 },
    wgsl: `@fragment
fn fs_main(in: FilterIn) -> @location(0) vec4f {
  let s = max($params.block, 1.0) * fpass.texel;
  return cozySample((floor(in.uv / s) + 0.5) * s);
}`,
    glsl: `void main() {
  vec2 s = max($params.block, 1.0) * fpass.texel;
  fragColor = cozySample((floor(vUv / s) + 0.5) * s);
}`,
  });

  function filterRegions() {
    return {
      gray: [30, 30, 80, 80], // red sprite in a grayscale (cheap) group
      ctrlAfter: [150, 30, 80, 80], // red sprite right after it, no group
      ctrlGroup: [270, 30, 80, 80], // red sprite in a plain group after it
      blurCenter: [425, 45, 50, 50], // white sprite [400,20,100,100] with blur
      blurHalo: [392, 50, 8, 40], // just outside its left edge
      chain: [40, 180, 100, 60], // long chain content
      nested: [240, 180, 80, 60], // nested filter groups (gray, blurred)
      maskedIn: [430, 180, 40, 60], // masked + filtered: inside the mask
      maskedOut: [520, 180, 60, 60], // outside the mask
      ctrlLast: [510, 390, 60, 60], // red sprite drawn last
    };
  }

  async function filtersInit({ worker, backend, debug = true }) {
    phase('filtersInit');
    const ctx = await createCtx({ worker, backend, debug });
    await GPU.loadEffects();
    const stage = ctx.renderer.stage;
    const F = (ctx.filt = {});
    F.gray = GPU.filters.colorMatrix().grayscale();
    F.ga = new GPU.Group({ filters: [F.gray] });
    F.ga.addChild(rect(20, 20, 100, 100, 0xff2020));
    stage.addChild(F.ga);
    stage.addChild(rect(140, 20, 100, 100, 0xff2020));
    const plain = new GPU.Group();
    plain.addChild(rect(260, 20, 100, 100, 0xff2020));
    stage.addChild(plain);
    F.blur = GPU.filters.blur({ strength: 8, quality: 'good' });
    F.gb = new GPU.Group({ filters: [F.blur] });
    F.blurSprite = rect(400, 20, 100, 100, 0xffffff);
    F.gb.addChild(F.blurSprite);
    stage.addChild(F.gb);
    F.gc = new GPU.Group({ filters: [GPU.filters.colorMatrix().hue(90), GPU.filters.blur({ strength: 3 }), GPU.filters.glow({ strength: 6, color: 0x66ccff }), pixelate(), GPU.filters.outline({ width: 2, color: 0xffffff })] });
    F.gc.addChild(rect(20, 160, 140, 100, 0x20ff20));
    stage.addChild(F.gc);
    F.gd = new GPU.Group({ filters: [GPU.filters.blur({ strength: 2 })] });
    F.ge = new GPU.Group({ filters: [GPU.filters.colorMatrix().grayscale(), GPU.filters.blur({ strength: 1 })] });
    F.ge.addChild(rect(220, 160, 120, 100, 0xff2020));
    F.gd.addChild(F.ge);
    stage.addChild(F.gd);
    F.gf = new GPU.Group({ filters: [GPU.filters.blur({ strength: 1 })] });
    F.gf.mask = { x: 400, y: 160, width: 100, height: 100 };
    F.gf.addChild(rect(400, 160, 200, 100, 0x3366ff));
    stage.addChild(F.gf);
    stage.addChild(rect(500, 380, 80, 80, 0xff2020));
    startLoop(ctx);
    await Promise.all([F.ga.ready, F.gb.ready, F.gc.ready, F.gd.ready, F.gf.ready]);
    await sleep(400);
    return { ctxId: registerCtx(ctx), regions: filterRegions() };
  }

  /** Toggles cheap/target filters and masks on alternate frames, ends in `end`. */
  async function filtersToggle(id, { frames = 240, end = 'off' }) {
    const ctx = getCtx(id);
    const F = ctx.filt;
    const errs = [];
    const set = on =>
      tryCall(errs, 'toggle', () => {
        F.ga.filters = on ? [F.gray] : null;
        F.gb.filters = on ? [F.blur] : null;
        F.gf.mask = on ? { x: 400, y: 160, width: 100, height: 100 } : null;
      });
    let done = false;
    startLoop(ctx, f => {
      if (f < frames) set(f % 2 === 0);
      else if (!done) {
        done = true;
        set(end === 'on');
      }
    });
    while (!done) await sleep(50);
    await sleep(300);
    return { errs, ...loopInfo(ctx) };
  }

  /** Cheap filter disabled through `enabled = false` (the effect uniform must reset). */
  async function filtersEnabled(id, { enabled }) {
    const ctx = getCtx(id);
    const F = ctx.filt;
    F.ga.filters = [F.gray];
    F.gray.enabled = enabled;
    F.blur.enabled = enabled;
    F.gb.filters = [F.blur];
    await sleep(300);
    return loopInfo(ctx);
  }

  /** Grows the blur group's capture from 10 px to 3000 px over resolutions, then shrinks. */
  async function filtersGrow(id, { frames = 240 }) {
    const ctx = getCtx(id);
    const F = ctx.filt;
    const errs = [];
    const res = [0.25, 0.5, 1, 2];
    let done = false;
    startLoop(ctx, f => {
      if (f >= frames) {
        if (!done) {
          done = true;
          tryCall(errs, 'reset', () => {
            F.blurSprite.width = 100;
            F.blurSprite.height = 100;
            F.blurSprite.x = 400;
            F.blurSprite.y = 20;
            F.gb.filterOptions = {};
          });
        }
        return;
      }
      tryCall(errs, 'grow', () => {
        const s = 10 + (3000 * f) / frames;
        F.blurSprite.width = s;
        F.blurSprite.height = s * 0.75;
        F.blurSprite.x = 400 - s / 2;
        F.blurSprite.y = 20 - s / 4;
        F.gb.filterOptions = { resolution: res[f % 4], area: f % 3 === 0 ? { x: 0, y: 0, width: s, height: s } : undefined };
        F.blur.set('strength', 1 + (f % 32));
      });
    });
    while (!done) await sleep(50);
    await sleep(200);
    return { errs, ...loopInfo(ctx) };
  }

  /** Resize storm (CSS) with filters active; settles back at 640×480. */
  async function filtersResizeStorm(id, { steps = 300, seed = 3 }) {
    const ctx = getCtx(id);
    const rnd = mulberry(seed);
    const c = ctx.canvas;
    for (let i = 0; i < steps; i++) {
      const k = rnd();
      const w = k < 0.05 ? 0 : k < 0.1 ? 1 : k < 0.15 ? 5000 : Math.floor(50 + rnd() * 1200);
      const hh = k < 0.05 ? 0 : k < 0.1 ? 1 : k < 0.15 ? 5000 : Math.floor(50 + rnd() * 900);
      c.style.width = `${w}px`;
      c.style.height = `${hh}px`;
      await raf();
    }
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    await sleep(600);
    return loopInfo(ctx);
  }

  // ─── Text ─────────────────────────────────────────────────────────────────
  const ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const randomAscii = (rnd, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += rnd() < 0.03 ? '\n' : ASCII[Math.floor(rnd() * ASCII.length)];
    return s;
  };
  const randomCjk = (rnd, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCodePoint(0x4e00 + Math.floor(rnd() * 20000));
    return s;
  };
  const nonSpace = s => [...s].filter(ch => !/\s/.test(ch)).length;

  async function textInit({ worker, backend, debug = true, count = 40 }) {
    phase('textInit');
    const ctx = await createCtx({ worker, backend, debug, assets: { baseUrl: `${location.origin}/font/` } });
    const r = ctx.renderer;
    const T = (ctx.text = { msdf: [], canvas: [] });
    T.handle = await r.assets.load({ url: 'cozy.json', kind: 'font' });
    T.font = T.handle.value;
    for (let i = 0; i < count; i++) {
      const t = new GPU.Text('init', { font: T.font, size: 14, fill: 0xffffff });
      t.x = 10 + (i % 4) * 160;
      t.y = 10 + Math.floor(i / 4) * 24;
      r.stage.addChild(t);
      T.msdf.push(t);
    }
    for (let i = 0; i < 4; i++) {
      const t = new GPU.Text('init', { font: { family: 'monospace', atlasSize: 48 }, size: 18, fill: 0xffffff });
      t.x = 10 + i * 160;
      t.y = 260;
      r.stage.addChild(t);
      T.canvas.push(t);
    }
    // Probes for pixel checks (bottom band, kept static).
    T.probeMsdf = new GPU.Text('MSDF 42', { font: T.font, size: 56, fill: 0xffffff });
    T.probeMsdf.x = 20;
    T.probeMsdf.y = 380;
    r.stage.addChild(T.probeMsdf);
    T.probeCanvas = new GPU.Text('CANVAS 42', { font: { family: 'monospace', atlasSize: 64 }, size: 48, fill: 0xffffff });
    T.probeCanvas.x = 330;
    T.probeCanvas.y = 380;
    r.stage.addChild(T.probeCanvas);
    startLoop(ctx);
    await Promise.all([...T.msdf, ...T.canvas, T.probeMsdf, T.probeCanvas].map(t => t.ready));
    await sleep(300);
    return {
      ctxId: registerCtx(ctx),
      regions: { msdf: [20, 380, 290, 80], canvas: [330, 380, 300, 80] },
      probe: { msdfGlyphs: T.probeMsdf.metrics.glyphs, canvasGlyphs: T.probeCanvas.metrics.glyphs, expect: nonSpace('MSDF 42') },
    };
  }

  /** Every text gets a new random string each frame; styles change now and then. */
  async function textChurn(id, { seconds = 6, seed = 11, cjk = 2000 }) {
    const ctx = getCtx(id);
    const T = ctx.text;
    const rnd = mulberry(seed);
    const errs = [];
    let cjkSent = 0;
    const aligns = ['left', 'center', 'right', 'justify'];
    const wraps = ['word', 'char', 'none'];
    startLoop(ctx, f => {
      for (let i = 0; i < T.msdf.length; i++) {
        const t = T.msdf[i];
        tryCall(errs, 'text', () => {
          t.text = rnd() < 0.1 ? '' : randomAscii(rnd, Math.floor(rnd() * 80));
          if (rnd() < 0.05) t.setStyle({ size: 6 + rnd() * 40, maxWidth: rnd() < 0.5 ? 50 + rnd() * 200 : undefined, wrap: wraps[Math.floor(rnd() * 3)], align: aligns[Math.floor(rnd() * 4)], letterSpacing: rnd() * 4, maxLines: rnd() < 0.3 ? 1 + Math.floor(rnd() * 3) : undefined, ellipsis: rnd() < 0.5 });
        });
      }
      for (let i = 0; i < T.canvas.length; i++) {
        const t = T.canvas[i];
        tryCall(errs, 'canvas text', () => {
          if (cjkSent < cjk) {
            const n = 12;
            t.text = randomCjk(rnd, n);
            cjkSent += n;
          } else {
            t.text = randomAscii(rnd, 20);
          }
        });
      }
    });
    await sleep(seconds * 1000);
    const throws = ctx.loop?.throws ?? [];
    stopLoop(ctx);
    startLoop(ctx);
    // Final known state.
    for (const t of T.msdf) t.text = 'ok';
    T.canvas.forEach(t => (t.text = 'ok'));
    await Promise.all([...T.msdf, ...T.canvas].map(t => Promise.race([t.ready, sleep(5000)])));
    const pages = [];
    // Canvas atlas pages are internal: count them through the glyph source if reachable.
    for (const t of T.canvas) {
      const pg = t._source?.font?.pages?.length ?? null;
      if (pg !== null) pages.push(pg);
    }
    await sleep(300);
    return {
      errs: errs.slice(0, 10),
      throws,
      cjkSent,
      pages,
      metricsOk: T.msdf.every(t => t.metrics.glyphs === 2),
      metricsBad: T.msdf.filter(t => t.metrics.glyphs !== 2).slice(0, 3).map(t => ({ glyphs: t.metrics.glyphs, lines: t.metrics.lines })),
      ...loopInfo(ctx),
    };
  }

  /**
   * Font eviction: trim while referenced (must keep), unload while referenced
   * (must throw), release + trim (evicts) while texts still use the font,
   * then reload and re-style.
   */
  async function textEvict(id, { step }) {
    const ctx = getCtx(id);
    const T = ctx.text;
    const a = ctx.renderer.assets;
    const out = { step };
    try {
      switch (step) {
        case 'trimReferenced':
          a.trim(0);
          break;
        case 'unloadReferenced':
          try {
            a.unload('cozy.json');
            out.unload = 'no throw';
          } catch (e) {
            out.unload = e.code ?? errText(e);
          }
          break;
        case 'releaseTrim':
          T.handle.release();
          a.trim(0);
          break;
        case 'reload': {
          T.handle = await a.load({ url: 'cozy.json', kind: 'font' });
          T.font = T.handle.value;
          for (const t of [...T.msdf, T.probeMsdf]) t.setStyle({ font: T.font });
          await Promise.all([...T.msdf, T.probeMsdf].map(t => Promise.race([t.ready, sleep(5000)])));
          break;
        }
      }
    } catch (e) {
      out.error = errText(e);
    }
    await sleep(400);
    const s = a.stats;
    out.stats = { entries: s.entries, referenced: s.referenced, gpuBytes: s.gpuBytes, evictions: s.evictions };
    out.has = a.has('cozy.json');
    Object.assign(out, loopInfo(ctx));
    return out;
  }

  // ─── Particles ────────────────────────────────────────────────────────────
  async function particlesInit({ worker, backend, debug = true, scale = 9, big = 1_000_000 }) {
    phase('particlesInit');
    const ctx = await createCtx({ worker, backend, debug });
    const r = ctx.renderer;
    const caps = r.info.capabilities;
    if (!caps.compute && !caps.transformFeedback) return { unsupported: true };
    await GPU.loadParticles();
    const P = (ctx.parts = { nodes: [] });
    const presets = GPU.particlePresets;
    const sc = o => ({ ...o, capacity: Math.round(o.capacity * scale), emitter: o.emitter && !Array.isArray(o.emitter) ? { ...o.emitter, rate: Math.round((o.emitter.rate ?? 0) * scale) } : o.emitter });
    const spots = { fire: [120, 400], smoke: [120, 380], sparks: [320, 240], rain: [0, -20], confetti: [520, 240] };
    for (const name of ['smoke', 'fire', 'sparks', 'rain', 'confetti']) {
      const node = new GPU.Particles(sc(presets[name]()));
      node.emitter().moveTo(...spots[name]);
      r.stage.addChild(node);
      P.nodes.push({ name, node });
    }
    // One big burst system (1M by default), long lives so the count is stable.
    P.big = new GPU.Particles({ capacity: big, emitter: { rate: 0, shape: { rect: { width: 600, height: 440 } }, speed: [0, 20], size: [1, 2], life: [30, 40], color: '#66ccff' } });
    P.big.emitter().moveTo(320, 240);
    r.stage.addChild(P.big);
    P.capacity = P.nodes.reduce((s, n) => s + n.node.swarm.capacity, 0) + big;
    startLoop(ctx);
    await sleep(500);
    return { ctxId: registerCtx(ctx), capacity: P.capacity, presetCapacity: P.nodes.map(n => [n.name, n.node.swarm.capacity]) };
  }

  async function aliveOf(ctx, node, ms = 8000) {
    try {
      return await Promise.race([node.swarm.aliveCount(), sleep(ms).then(() => 'timeout')]);
    } catch (e) {
      return `error ${errText(e)}`;
    }
  }

  /** Bursts into the big system, then emitter moves / play-pause / clear churn. */
  async function particlesBursts(id, { seconds = 6, seed = 5, burst = 250_000 }) {
    const ctx = getCtx(id);
    const P = ctx.parts;
    const rnd = mulberry(seed);
    const errs = [];
    // Fill the big system in 4 bursts on consecutive frames.
    let sent = 0;
    const cap = P.big.swarm.capacity;
    const fill = [];
    startLoop(ctx, () => {
      if (sent < cap) {
        const n = Math.min(burst, cap - sent);
        tryCall(errs, 'emit big', () => P.big.emit(n));
        sent += n;
      }
    });
    await sleep(800);
    fill.push(await aliveOf(ctx, P.big));
    const packets = [];
    startLoop(ctx, f => {
      const { node } = P.nodes[Math.floor(rnd() * P.nodes.length)];
      const k = Math.floor(rnd() * 7);
      tryCall(errs, `op${k}`, () => {
        if (k === 0) node.emitter().moveTo(rnd() * W, rnd() * H);
        else if (k === 1) node.emitter().burst(Math.floor(rnd() * 5000));
        else if (k === 2) (node.playing ? node.pause() : node.play());
        else if (k === 3 && rnd() < 0.1) node.clear();
        else if (k === 4) node.emit(Math.floor(rnd() * 20000));
        else if (k === 5) node.setOverLife({ color: ['#ffffff', '#ff8800'], alpha: [1, 0], size: [1, rnd()] });
        else node.emitter().set({ speed: [10, 50 + rnd() * 300] });
      });
      if (f % 30 === 0 && packets.length < 64) packets.push(ctx.renderer.stats.packetBytes);
    });
    await sleep(seconds * 1000);
    const throws = ctx.loop?.throws ?? [];
    // Everything back to playing.
    for (const { node } of P.nodes) tryCall(errs, 'play', () => node.play());
    startLoop(ctx);
    await sleep(500);
    const alive = {};
    for (const { name, node } of P.nodes) alive[name] = await aliveOf(ctx, node);
    alive.big = await aliveOf(ctx, P.big);
    const caps = Object.fromEntries([...P.nodes.map(n => [n.name, n.node.swarm.capacity]), ['big', P.big.swarm.capacity]]);
    packets.sort((x, y) => x - y);
    return { errs: errs.slice(0, 10), throws, fill, alive, caps, packetP50: packets[packets.length >> 1] ?? null, packetMax: packets[packets.length - 1] ?? null, ...loopInfo(ctx) };
  }

  async function particlesAlive(id) {
    const ctx = getCtx(id);
    const P = ctx.parts;
    const alive = {};
    for (const { name, node } of P.nodes) alive[name] = await aliveOf(ctx, node);
    alive.big = await aliveOf(ctx, P.big);
    return { alive, ...loopInfo(ctx) };
  }

  /** Re-emits into the big system (after a loss the app re-spawns, as with Swarm). */
  async function particlesRefill(id) {
    const ctx = getCtx(id);
    ctx.parts.big.emit(ctx.parts.big.swarm.capacity);
    await sleep(500);
    return aliveOf(ctx, ctx.parts.big);
  }

  // ─── Combined scene (device loss for every feature) ───────────────────────
  function lossRegions() {
    return {
      maskIn: [30, 80, 100, 100], // p0 inner: blue
      maskTop: [30, 25, 100, 45], // p0 above inner mask: dark
      maskStencilIn: [240, 80, 100, 100],
      maskStencilTop: [240, 25, 100, 45],
      gray: [30, 240, 40, 40], // grayscale cheap filter on red
      ctrl: [110, 240, 40, 40], // red control
      blurHalo: [172, 240, 8, 40], // blur spreads past x = 180
      msdf: [260, 230, 200, 60],
      canvasText: [260, 300, 200, 50],
      particles: [470, 260, 160, 200],
    };
  }

  async function comboInit({ worker, backend }) {
    phase('comboInit');
    const ctx = await createCtx({ worker, backend, debug: true, assets: { baseUrl: `${location.origin}/font/` } });
    const r = ctx.renderer;
    await GPU.loadEffects();
    const stage = r.stage;
    // Masks: panel 0 (scissor) and panel 1 (stencil) at y 20..200, x < 420.
    ctx.panels = [];
    // Single-level masks here (nesting has its own scenario): only the inner
    // group is masked.
    for (let i = 0; i < 2; i++) {
      const P = buildMaskPanel(ctx, i);
      stage.addChild(P.g1);
      ctx.panels.push(P);
      applyMaskConfig(P, {});
      P.g1.mask = null;
    }
    const gray = new GPU.Group({ filters: [GPU.filters.colorMatrix().grayscale()] });
    gray.addChild(rect(20, 230, 60, 60, 0xff2020));
    stage.addChild(gray);
    stage.addChild(rect(100, 230, 60, 60, 0xff2020));
    const blur = new GPU.Group({ filters: [GPU.filters.blur({ strength: 8 })] });
    blur.addChild(rect(180, 230, 60, 60, 0xffffff));
    stage.addChild(blur);
    const handle = await r.assets.load({ url: 'cozy.json', kind: 'font' });
    const t1 = new GPU.Text('LOSS 42', { font: handle.value, size: 48, fill: 0xffffff });
    t1.x = 260;
    t1.y = 230;
    stage.addChild(t1);
    const t2 = new GPU.Text('CANVAS', { font: { family: 'monospace', atlasSize: 64 }, size: 40, fill: 0xffffff });
    t2.x = 260;
    t2.y = 300;
    stage.addChild(t2);
    let fire = null;
    const caps = r.info.capabilities;
    if (caps.compute || caps.transformFeedback) {
      await GPU.loadParticles();
      fire = new GPU.Particles(GPU.particlePresets.fire({ capacity: 50_000 }));
      fire.emitter().moveTo(550, 440);
      stage.addChild(fire);
    }
    ctx.combo = { gray, blur, t1, t2, fire };
    startLoop(ctx, f => {
      t1.text = f % 2 ? 'LOSS 42' : 'LOSS 24';
    });
    await Promise.all([gray.ready, blur.ready, t1.ready, t2.ready, ...ctx.panels.map(P => P.g1.ready)]);
    await sleep(800);
    return { ctxId: registerCtx(ctx), regions: lossRegions(), particles: !!fire };
  }

  async function comboState(id) {
    const ctx = getCtx(id);
    const fire = ctx.combo.fire;
    const alive = fire ? await aliveOf(ctx, fire) : null;
    return { alive, modes: ctx.panels.map(P => P.g2._maskBinding?.mode ?? null), ...loopInfo(ctx) };
  }

  return {
    // Exploration handles (repro scripts drive the library directly).
    GPU,
    newCtx: async o => {
      const ctx = await createCtx(o);
      startLoop(ctx);
      return registerCtx(ctx);
    },
    ctxOf: getCtx,
    regionColors,
    poolProbeSource,
    poolProbeHere: () => (0, eval)(poolProbeSource),
    m3LoopInfo: id => loopInfo(getCtx(id)),
    maskInit,
    maskSet,
    maskModes,
    maskChurn,
    maskDeep,
    deepClear,
    filtersInit,
    filtersToggle,
    filtersEnabled,
    filtersGrow,
    filtersResizeStorm,
    textInit,
    textChurn,
    textEvict,
    particlesInit,
    particlesBursts,
    particlesAlive,
    particlesRefill,
    comboInit,
    comboState,
    m3Supported: id => swarmSupported(getCtx(id).renderer, 1),
  };
}
