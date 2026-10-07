// Rendering-at-scale scenarios for tests/browser/stress.mjs: retained
// rendering under random edits, container.static toggling, SpriteLayer at
// millions of instances, layer column churn with partial commits, texture
// slot growth, GPU culling while panning, device loss. Installed into
// globalThis.stress by stress-page.js. Every function returns plain JSON; the
// Node side screenshots and decides pass/fail.
//
// Pixel comparisons use a pair of renderers drawing the same scene: the
// reference (created first, no debug, retained off or culling off) on the
// lower canvas, the renderer under test (created second, debug on so a
// device loss can be simulated in its realm) on the upper one.
import * as GPU from 'cozygpu';

export function installM5(h) {
  const { createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase } = h;

  const W = 480;
  const H = 300;
  const GAP = 20;
  const states = new Map();
  let nextKey = 1;

  const mulberry = seed => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** 32 well separated, bright colours (0xRRGGBB). */
  const COLORS = Array.from({ length: 32 }, (_, i) => {
    const hue = (i * 137.508) % 360;
    const l = i & 1 ? 0.62 : 0.5;
    const f = n => {
      const k = (n + hue / 30) % 12;
      const a = 0.9 * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return (f(0) << 16) | (f(8) << 8) | f(4);
  });
  const solid = (c, n = 8) => {
    const px = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      px[i * 4] = (c >> 16) & 255;
      px[i * 4 + 1] = (c >> 8) & 255;
      px[i * 4 + 2] = c & 255;
      px[i * 4 + 3] = 255;
    }
    return GPU.Texture.fromPixels(n, n, px);
  };
  const tryCall = (out, label, f) => {
    try {
      return f();
    } catch (e) {
      if (out.length < 20) out.push(`${label}: ${errText(e)}`);
      return undefined;
    }
  };
  const canvasAt = (top, w = W, hh = H) => {
    const c = document.createElement('canvas');
    c.style.cssText = `display:block;position:absolute;left:0;top:${top}px;width:${w}px;height:${hh}px`;
    document.body.appendChild(c);
    return c;
  };
  /** Reference renderer first (lower canvas), test renderer second (upper). */
  async function pair({ worker, backend, ref = {}, test = {}, w = W, hh = H }) {
    const refCtx = await createCtx({ worker, backend, canvas: canvasAt(hh + GAP, w, hh), ...ref });
    const testCtx = await createCtx({ worker, backend, canvas: canvasAt(0, w, hh), debug: true, ...test });
    return { ref: refCtx, test: testCtx, refId: registerCtx(refCtx), testId: registerCtx(testCtx) };
  }
  const renderBoth = P => {
    P.ref.renderer.render();
    P.test.renderer.render();
  };
  async function settleBoth(P, n = 8) {
    for (let i = 0; i < n; i++) {
      renderBoth(P);
      await raf();
    }
    // Worker mode: give both cores time to present the last frame.
    if (P.worker) {
      await sleep(60);
      for (let i = 0; i < 3; i++) {
        renderBoth(P);
        await raf();
      }
    }
  }
  const shotRect = (w = W, hh = H) => ({ x: 0, y: 0, width: w, height: 2 * hh + GAP });

  async function decode(b64) {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const g = oc.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
  }

  /**
   * Compares the upper canvas (test) with the lower one (reference) of a
   * pair screenshot. A pixel differs when a channel differs by more than
   * `tol`. Returns counts, the bounding box of differing pixels (css px) and
   * how much of each canvas is lit (so two black canvases do not pass).
   */
  async function m5Diff(b64, { w = W, hh = H, tol = 40 } = {}) {
    const img = await decode(b64);
    const s = img.w / w;
    const cw = Math.round(w * s);
    const ch = Math.round(hh * s);
    const dy = Math.round((hh + GAP) * s);
    const d = img.d;
    let bad = 0;
    let max = 0;
    let litA = 0;
    let litB = 0;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const a = (y * img.w + x) * 4;
        const b = ((y + dy) * img.w + x) * 4;
        if (d[a] + d[a + 1] + d[a + 2] > 60) litA++;
        if (d[b] + d[b + 1] + d[b + 2] > 60) litB++;
        const m = Math.max(Math.abs(d[a] - d[b]), Math.abs(d[a + 1] - d[b + 1]), Math.abs(d[a + 2] - d[b + 2]));
        if (m > max) max = m;
        if (m > tol) {
          bad++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    const n = cw * ch;
    return {
      scale: s,
      bad,
      badRatio: +(bad / n).toFixed(5),
      max,
      litTest: +(litA / n).toFixed(4),
      litRef: +(litB / n).toFixed(4),
      bbox: bad ? [x0 / s, y0 / s, (x1 - x0 + 1) / s, (y1 - y0 + 1) / s].map(v => Math.round(v)) : null,
    };
  }

  /** RGB at css points of a screenshot (scale: image px per css px, 0 = from width `w`). */
  async function m5Sample(b64, pts, w = 640) {
    const img = await decode(b64);
    const s = img.w / w;
    return pts.map(([x, y]) => {
      const i = (Math.round(y * s) * img.w + Math.round(x * s)) * 4;
      return [img.d[i], img.d[i + 1], img.d[i + 2]];
    });
  }

  const statsOf = r => ({
    drawCalls: r.stats.drawCalls,
    packetBytes: r.stats.packetBytes,
    cpuMs: +r.stats.cpuMs.toFixed(3),
    segments: r.stats.retainedSegments ? { ...r.stats.retainedSegments } : null,
  });

  // ─── Mixed scene (sprites + Graphics + mask group + small layer) ──────────

  /**
   * Builds the same scene in renderer `r` from a list of creation params.
   * `opts.static`: container 0 is made static (test side only).
   */
  function buildMixed(r, spec, opts = {}) {
    const S = { r, tex: spec.texColors.map(c => solid(c)), conts: [], nodes: [], extras: [], throws: [] };
    const root = r.stage;
    const c0 = new GPU.Container();
    const c1 = new GPU.Container();
    const c2 = new GPU.Container({ x: 12, y: 6 });
    root.addChild(c0);
    root.addChild(c1);
    c1.addChild(c2);
    S.conts.push(c0, c1, c2);
    for (const p of spec.nodes) S.nodes.push(mkNode(S, p));
    if (spec.extras) {
      // A masked group in container 1 (drawn fresh, splits segments).
      const g = new GPU.Group({ mask: { x: 300, y: 180, width: 120, height: 80 } });
      for (let i = 0; i < 6; i++) g.addChild(new GPU.Sprite({ texture: S.tex[i % S.tex.length], x: 280 + i * 22, y: 170 + (i % 3) * 30, width: 40, height: 40 }));
      c1.addChildAt(g, Math.min(c1.children.length, 20));
      // A small SpriteLayer in container 0 (volatile draw between segments).
      const L = new GPU.SpriteLayer({ capacity: 400, frames: [S.tex[2], S.tex[5]] });
      for (let i = 0; i < 400; i++) L.setInstance(i, 20 + (i % 40) * 4, 250 + Math.floor(i / 40) * 4, 0, 0.4, i & 1);
      L.count = 400;
      c0.addChildAt(L, Math.min(c0.children.length, 30));
      // A Graphics with a texture fill (keeps its own draw).
      const tg = new GPU.Graphics();
      tg.rect(400, 20, 60, 60).fill({ texture: S.tex[7] });
      c2.addChild(tg);
      S.extras.push(g, L, tg);
    }
    if (opts.static) c0.static = true;
    return S;
  }

  function genNodeParams(rnd, ntex) {
    const isSprite = rnd() < 0.65;
    if (isSprite) {
      return { s: 1, c: (rnd() * 3) | 0, t: (rnd() * ntex) | 0, x: rnd() * (W - 30), y: rnd() * (H - 30), w: 8 + rnd() * 40, h: 8 + rnd() * 40, rot: rnd() < 0.3 ? rnd() * 6 : 0, tint: rnd() < 0.3 ? COLORS[(rnd() * 32) | 0] : 0xffffff, a: rnd() < 0.2 ? 0.5 : 1 };
    }
    return { s: 0, c: (rnd() * 3) | 0, k: (rnd() * 4) | 0, x: rnd() * (W - 40), y: rnd() * (H - 40), r: 6 + rnd() * 20, col: COLORS[(rnd() * 32) | 0] };
  }
  function drawGfx(g, p) {
    switch (p.k) {
      case 0:
        g.circle(p.x, p.y, p.r).fill(p.col);
        break;
      case 1:
        g.roundRect(p.x, p.y, p.r * 2, p.r * 1.4, 4).fill(p.col).stroke({ width: 2, color: 0xffffff });
        break;
      case 2:
        g.star(p.x, p.y, 5, p.r, p.r / 2).fill(p.col);
        break;
      default:
        g.moveTo(p.x, p.y).lineTo(p.x + p.r * 2, p.y + p.r).lineTo(p.x, p.y + p.r * 2).closePath().fill(p.col);
    }
  }
  function mkNode(S, p, at = -1) {
    let n;
    if (p.s) {
      n = new GPU.Sprite({ texture: S.tex[p.t % S.tex.length], x: p.x, y: p.y, width: p.w, height: p.h, rotation: p.rot, tint: p.tint, alpha: p.a });
    } else {
      n = new GPU.Graphics();
      drawGfx(n, p);
    }
    const c = S.conts[p.c];
    if (at < 0) c.addChild(n);
    else c.addChildAt(n, Math.min(c.children.length, Math.floor(at * (c.children.length + 1))));
    return n;
  }

  const OPS = ['tint', 'move', 'visible', 'texture', 'reparent', 'reorder', 'add', 'destroy', 'gfx', 'alpha', 'cmove', 'blend', 'scale', 'calpha'];
  function genOp(rnd, ntex, ops = OPS) {
    const op = ops[(rnd() * ops.length) | 0];
    return { op, u: rnd(), v: rnd(), c: (rnd() * 3) | 0, x: rnd() * (W - 30), y: rnd() * (H - 30), col: COLORS[(rnd() * 32) | 0], k: (rnd() * ntex) | 0, p: genNodeParams(rnd, ntex) };
  }
  /** Applies one op descriptor to scene S (identically on both sides). */
  function applyOp(S, o) {
    const N = S.nodes;
    const i = Math.floor(o.u * N.length);
    const n = N[i];
    const t = S.throws;
    switch (o.op) {
      case 'tint':
        if (n) tryCall(t, 'tint', () => (n.tint = o.col));
        break;
      case 'move':
        if (n) {
          n.x = o.x * (n.kind === 'graphics' ? 0.2 : 1);
          n.y = o.y * (n.kind === 'graphics' ? 0.2 : 1);
        }
        break;
      case 'visible':
        if (n) n.visible = !n.visible;
        break;
      case 'texture':
        if (n && n.kind === 'sprite') n.texture = S.tex[o.k % S.tex.length];
        break;
      case 'reparent':
        if (n) {
          const c = S.conts[o.c];
          tryCall(t, 'reparent', () => c.addChildAt(n, Math.min(c.children.length, Math.floor(o.v * (c.children.length + 1)))));
        }
        break;
      case 'reorder':
        if (n && n.parent) {
          const c = n.parent;
          tryCall(t, 'reorder', () => c.setChildIndex(n, Math.min(c.children.length - 1, Math.floor(o.v * c.children.length))));
        }
        break;
      case 'add':
        N.push(mkNode(S, o.p, o.v));
        break;
      case 'destroy':
        if (n && N.length > 40) {
          N.splice(i, 1);
          n.destroy();
        }
        break;
      case 'gfx':
        if (n && n.kind === 'graphics') {
          n.clear();
          drawGfx(n, { ...o.p, k: o.k & 3, x: o.x, y: o.y, r: 6 + o.v * 20, col: o.col });
        }
        break;
      case 'alpha':
        if (n) n.alpha = o.v < 0.3 ? 0 : o.v < 0.6 ? 0.5 : 1;
        break;
      case 'cmove': {
        const c = S.conts[o.c];
        c.x = (o.v - 0.5) * 40;
        c.y = (o.u - 0.5) * 30;
        break;
      }
      case 'blend':
        if (n) tryCall(t, 'blend', () => (n.blendMode = o.v < 0.5 ? 'add' : 'normal'));
        break;
      case 'scale':
        if (n && n.kind === 'sprite') {
          n.width = 8 + o.v * 50;
          n.rotation = o.u * 3;
        }
        break;
      case 'calpha':
        S.conts[o.c].alpha = o.v < 0.5 ? 0.6 : 1;
        break;
      default:
    }
  }

  function makeSpec(seed, count, ntex, extras = true) {
    const rnd = mulberry(seed);
    const texColors = COLORS.slice(0, ntex);
    const nodes = [];
    for (let i = 0; i < count; i++) nodes.push(genNodeParams(rnd, ntex));
    return { rnd, texColors, nodes, extras };
  }

  // ─── Retained vs immediate under random edits ──────────────────────────────

  async function m5RetInit({ worker, backend, seed = 7, count = 260, ntex = 10, extras = true }) {
    phase('m5RetInit');
    const P = await pair({ worker, backend, ref: { retained: false }, test: { retained: true } });
    P.worker = worker;
    const spec = makeSpec(seed, count, ntex, extras);
    P.A = buildMixed(P.test.renderer, spec);
    P.B = buildMixed(P.ref.renderer, spec);
    P.spec = spec;
    P.ntex = ntex;
    P.maxSeen = { replayed: 0, recorded: 0 };
    await Promise.all(P.A.extras.concat(P.B.extras).map(n => n.ready).filter(Boolean)).catch(() => {});
    await settleBoth(P, 12);
    const key = nextKey++;
    states.set(key, P);
    return { key, refId: P.refId, testId: P.testId, rect: shotRect(), test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer), throws: P.A.throws };
  }

  /**
   * `rounds` rounds of `edits` ops, one render of both per round (so
   * recordings and replays interleave with edits), then `idle` clean frames.
   */
  async function m5RetStep(key, { rounds = 3, edits = 4, idle = 8, ops } = {}) {
    const P = states.get(key);
    const opsDone = [];
    const segs = [];
    const throws = [];
    for (let r = 0; r < rounds; r++) {
      for (let e = 0; e < edits; e++) {
        const o = genOp(P.spec.rnd, P.ntex, ops);
        opsDone.push(o.op);
        applyOp(P.A, o);
        applyOp(P.B, o);
      }
      tryCall(throws, 'render', () => renderBoth(P));
      const s = P.test.renderer.stats.retainedSegments;
      if (s) segs.push(`${s.replayed}/${s.recorded}`);
      await raf();
    }
    for (let i = 0; i < idle; i++) {
      tryCall(throws, 'render', () => renderBoth(P));
      const s = P.test.renderer.stats.retainedSegments;
      if (s) {
        P.maxSeen.replayed = Math.max(P.maxSeen.replayed, s.replayed);
        P.maxSeen.recorded = Math.max(P.maxSeen.recorded, s.recorded);
      }
      await raf();
    }
    await settleBoth(P, 2);
    return { ops: opsDone, segs, test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer), maxSeen: P.maxSeen, nodes: P.A.nodes.length, throws: throws.concat(P.A.throws.splice(0), P.B.throws.splice(0)) };
  }

  // ─── container.static toggling ─────────────────────────────────────────────

  async function m5StaticInit({ worker, backend, seed = 21, count = 220, ntex = 12, retainedTest = true }) {
    phase('m5StaticInit');
    const P = await pair({ worker, backend, ref: { retained: false }, test: { retained: retainedTest } });
    P.worker = worker;
    const spec = makeSpec(seed, count, ntex, false);
    P.A = buildMixed(P.test.renderer, spec, { static: true });
    P.B = buildMixed(P.ref.renderer, spec);
    // A nested static container inside container 0 (test side) with its own content.
    for (const [S, st] of [[P.A, true], [P.B, false]]) {
      const inner = new GPU.Container({ static: st, x: 30, y: 30 });
      for (let i = 0; i < 30; i++) inner.addChild(new GPU.Sprite({ texture: S.tex[i % S.tex.length], x: (i % 10) * 18, y: Math.floor(i / 10) * 18, width: 14, height: 14 }));
      S.conts[0].addChild(inner);
      S.inner = inner;
    }
    P.spec = spec;
    P.ntex = ntex;
    P.texAdded = 0;
    await settleBoth(P, 12);
    const key = nextKey++;
    states.set(key, P);
    return { key, refId: P.refId, testId: P.testId, rect: shotRect(), test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer) };
  }

  /**
   * One step: random edits (inside and outside the static container),
   * toggles of `static` (test side), a temporary mask Group inside it,
   * texture-source growth inside it (a sprite with a brand-new texture).
   */
  async function m5StaticStep(key, { edits = 6, kind = 'mixed' } = {}) {
    const P = states.get(key);
    const rnd = P.spec.rnd;
    const done = [];
    const throws = [];
    const warnsBefore = (globalThis.__m5Warn ??= 0);
    if (kind === 'toggle' || (kind === 'mixed' && rnd() < 0.35)) {
      const c = P.A.conts[0];
      c.static = !c.static;
      done.push(`static=${c.static}`);
      if (rnd() < 0.5) {
        P.A.inner.static = !P.A.inner.static;
        done.push(`inner.static=${P.A.inner.static}`);
      }
    }
    if (kind === 'group' || (kind === 'mixed' && rnd() < 0.15)) {
      for (const S of [P.A, P.B]) {
        if (S.group) {
          S.group.destroy({ children: true });
          S.group = null;
        } else {
          const g = new GPU.Group({ mask: { x: 60, y: 60, width: 140, height: 90 } });
          g.addChild(new GPU.Sprite({ texture: S.tex[3], x: 40, y: 40, width: 200, height: 140 }));
          S.conts[0].addChild(g);
          S.group = g;
        }
      }
      done.push(P.A.group ? 'group+' : 'group-');
    }
    if (kind === 'texgrow' || (kind === 'mixed' && rnd() < 0.3)) {
      // A new texture source each time (32 colours, then reuse).
      const col = COLORS[(P.ntex + P.texAdded++) % 32];
      const x = (P.texAdded % 12) * 36 + 6;
      const y = 4 + Math.floor(P.texAdded / 12) * 36;
      for (const S of [P.A, P.B]) S.inner.addChild(new GPU.Sprite({ texture: solid(col), x: x - 30, y: y + 120, width: 30, height: 30 }));
      done.push(`tex#${P.texAdded}`);
    }
    const inside = ['tint', 'move', 'visible', 'texture', 'reorder', 'add', 'destroy', 'gfx', 'alpha', 'cmove', 'calpha', 'scale'];
    for (let e = 0; e < edits; e++) {
      const o = genOp(rnd, P.ntex, inside);
      if (rnd() < 0.6) o.p.c = o.c = 0; // mostly inside the static container
      done.push(o.op);
      applyOp(P.A, o);
      applyOp(P.B, o);
    }
    for (let i = 0; i < 3; i++) {
      tryCall(throws, 'render', () => renderBoth(P));
      await raf();
    }
    // Transform-only frames on the static container (should be free).
    const c0a = P.A.conts[0];
    const c0b = P.B.conts[0];
    for (let i = 0; i < 4; i++) {
      c0a.x = c0b.x = Math.round((rnd() - 0.5) * 30);
      tryCall(throws, 'render', () => renderBoth(P));
      await raf();
    }
    await settleBoth(P, 8);
    return { done, test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer), static: c0a.static, inner: P.A.inner.static, warns: (globalThis.__m5Warn ?? 0) - warnsBefore, throws: throws.concat(P.A.throws.splice(0), P.B.throws.splice(0)) };
  }

  /** Steady cost of a static container that only moves (test side). */
  async function m5StaticMeasure(key, n = 90) {
    const P = states.get(key);
    const c = P.A.conts[0];
    if (P.A.group) {
      for (const S of [P.A, P.B]) {
        S.group.destroy({ children: true });
        S.group = null;
      }
    }
    c.static = true;
    P.A.inner.static = true;
    await settleBoth(P, 12);
    const cpu = [];
    const packet = [];
    for (let i = 0; i < n; i++) {
      c.x = P.B.conts[0].x = Math.sin(i * 0.1) * 10;
      P.ref.renderer.render();
      P.test.renderer.render();
      cpu.push(P.test.renderer.stats.cpuMs);
      packet.push(P.test.renderer.stats.packetBytes);
      await raf();
    }
    const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
    return { cpuAvg: avg(cpu), cpuMax: +Math.max(...cpu).toFixed(3), packetAvg: avg(packet), packetMax: Math.max(...packet), static: c.static };
  }

  // ─── SpriteLayer at scale ─────────────────────────────────────────────────

  const sab = n => (globalThis.crossOriginIsolated ? new SharedArrayBuffer(n) : new ArrayBuffer(n));

  /**
   * One layer of `capacity` instances on a 640 × 480 canvas: x < 320 draws
   * frame 0 (red), the rest frame 1 (blue). Measures a static phase and a
   * phase that commits every position each frame through an `xy` column.
   */
  async function m5LayerScale({ worker, backend, capacity, limits = 'default', xform = true, color = true, frames = 120 }) {
    phase(`m5LayerScale ${capacity}`);
    const out = { capacity, ok: false, error: null, throws: [] };
    const ctx = await createCtx({ worker, backend, limits });
    out.ctxId = registerCtx(ctx);
    const r = ctx.renderer;
    out.backend = r.info.backend;
    out.caps = { maxStorageBufferBindingSize: r.info.capabilities.maxStorageBufferBindingSize, maxBufferSize: r.info.capabilities.maxBufferSize, compute: r.info.capabilities.compute };
    const red = solid(0xff0000, 2);
    const blue = solid(0x0000ff, 2);
    let L;
    const t0 = performance.now();
    try {
      L = new GPU.SpriteLayer({ capacity, frames: [red, blue], streams: { xform, color } });
    } catch (e) {
      out.error = errText(e);
      return out;
    }
    out.allocMs = +(performance.now() - t0).toFixed(1);
    const t1 = performance.now();
    const P = L.data.position;
    const X = L.data.xform;
    for (let i = 0; i < capacity; i++) {
      const x = (i % 640) + 0.5;
      const y = (Math.floor(i / 640) % 480) + 0.5;
      P[2 * i] = x;
      P[2 * i + 1] = y;
      if (xform && x >= 320) X[4 * i + 3] = 1;
    }
    if (!xform) {
      // Positions only: blue half via a second layer is out of scope; frame 0 everywhere.
    }
    L.markDirty(0, capacity);
    L.count = capacity;
    out.fillMs = +(performance.now() - t1).toFixed(1);
    r.stage.addChild(L);
    ctx.layer = L;
    try {
      await L.ready;
    } catch (e) {
      out.error = `ready: ${errText(e)}`;
    }
    const meter = async (n, each) => {
      const cpu = [];
      const dt = [];
      const pk = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        if (each) each(i);
        tryCall(out.throws, 'render', () => r.render());
        cpu.push(r.stats.cpuMs);
        pk.push(r.stats.packetBytes);
        await raf();
        const now = performance.now();
        dt.push(now - last);
        last = now;
      }
      const s = a => {
        const b = Float64Array.from(a).sort();
        return { avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p50: +b[b.length >> 1].toFixed(3), max: +b[b.length - 1].toFixed(3) };
      };
      return { cpuMs: s(cpu.slice(5)), frameMs: s(dt.slice(5)), packetBytes: s(pk.slice(5)), drawCalls: r.stats.drawCalls };
    };
    const tf = performance.now();
    tryCall(out.throws, 'first render', () => r.render());
    out.firstRenderCpuMs = +(performance.now() - tf).toFixed(1);
    await settle(ctx, 10);
    out.static = await meter(frames);
    // Moving phase: every position committed each frame through a direct column.
    const xy = new Float32Array(sab(capacity * 8));
    xy.set(P.subarray(0, capacity * 2));
    const binding = tryCall(out.throws, 'bindColumns', () => L.bindColumns({ xy }));
    if (binding) out.moving = await meter(frames, () => binding.commit(capacity));
    await settle(ctx, 6);
    out.ok = true;
    return out;
  }

  // ─── Column churn with partial commits ────────────────────────────────────

  const PACKED_KEYS = ['x', 'y', 'rotation', 'scale', 'frame', 'tint', 'alpha'];
  function makeCols(n, interleaved) {
    const c = {
      x: new Float32Array(sab(n * 4)),
      y: new Float32Array(sab(n * 4)),
      xy: new Float32Array(sab(n * 8)),
      rotation: new Float32Array(sab(n * 4)),
      scale: new Float32Array(sab(n * 4)).fill(1),
      frame: new Uint32Array(sab(n * 4)),
      tint: new Uint32Array(sab(n * 4)).fill(0xffffff),
      alpha: new Float32Array(sab(n * 4)).fill(1),
      userId: new Uint32Array(sab(n * 4)),
      n,
      interleaved,
    };
    return c;
  }
  function copyCols(from, n, interleaved) {
    const c = makeCols(n, interleaved);
    for (const k of [...PACKED_KEYS, 'xy', 'userId']) c[k].set(from[k].subarray(0, Math.min(from[k].length, c[k].length)));
    return c;
  }
  const bindSet = c => {
    const o = { rotation: c.rotation, scale: c.scale, frame: c.frame, tint: c.tint, alpha: c.alpha, userId: c.userId };
    if (c.interleaved) o.xy = c.xy;
    else {
      o.x = c.x;
      o.y = c.y;
    }
    return o;
  };
  const setXY = (c, i, x, y) => {
    c.x[i] = x;
    c.y[i] = y;
    c.xy[2 * i] = x;
    c.xy[2 * i + 1] = y;
  };

  async function m5ColInit({ worker, backend, n = 100_000 }) {
    phase('m5ColInit');
    const ctx = await createCtx({ worker, backend });
    const id = registerCtx(ctx);
    const r = ctx.renderer;
    const frames = [];
    for (let s = 0; s < 4; s++) frames.push(solid(COLORS[s * 3], 4));
    const L = new GPU.SpriteLayer({ capacity: n, frames, pickable: true, streams: { xform: true, color: true, user: true } });
    const C = makeCols(n, false);
    const rnd = mulberry(99);
    for (let i = 0; i < n; i++) {
      setXY(C, i, rnd() * 640, rnd() * 480);
      C.frame[i] = i & 3;
      C.userId[i] = i + 1;
    }
    const B = L.bindColumns(bindSet(C));
    B.commit(n);
    r.stage.addChild(L);
    await L.ready;
    await settle(ctx, 8);
    Object.assign(ctx, { layer: L, cols: C, binding: B, rnd, frames });
    return { ctxId: id, count: L.count, capacity: L.capacity };
  }

  async function m5ColChurn(id, { seconds = 8 }) {
    phase('m5ColChurn');
    const ctx = getCtx(id);
    const r = ctx.renderer;
    const L = ctx.layer;
    const rnd = ctx.rnd;
    const out = { frames: 0, commits: 0, partial: 0, full: 0, grows: 0, rebinds: 0, setInstance: 0, markDirty: 0, throws: [], cpu: [] };
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      let C = ctx.cols;
      const k = rnd();
      if (k < 0.02) {
        // Capacity growth with new (copied) columns, then rebind.
        const n2 = Math.min(400_000, Math.floor(L.capacity * 1.3));
        tryCall(out.throws, 'capacity', () => (L.capacity = n2));
        C = ctx.cols = copyCols(C, n2, C.interleaved);
        tryCall(out.throws, 'rebind', () => ctx.binding.rebind(bindSet(C)));
        out.grows++;
      } else if (k < 0.05) {
        // Switch between x/y packed and xy direct.
        C.interleaved = !C.interleaved;
        tryCall(out.throws, 'rebind', () => ctx.binding.rebind(bindSet(C)));
        out.rebinds++;
      } else if (k < 0.08) {
        // Full commit with a new count.
        const cnt = Math.max(1, Math.floor(L.capacity * (0.5 + rnd() * 0.5)));
        tryCall(out.throws, 'commit', () => ctx.binding.commit(cnt));
        out.full++;
      } else if (k < 0.1) {
        // Own-store write while columns are bound (later commits win).
        const i = Math.floor(rnd() * L.count);
        tryCall(out.throws, 'setInstance', () => L.setInstance(i, rnd() * 640, rnd() * 480, 0, 2, 1, 0xff00ffff));
        out.setInstance++;
      } else if (k < 0.12) {
        const i = Math.floor(rnd() * (L.capacity - 100));
        tryCall(out.throws, 'markDirty', () => L.markDirty(i, 100));
        out.markDirty++;
      }
      // A handful of partial commits per frame.
      const parts = 1 + Math.floor(rnd() * 6);
      for (let p = 0; p < parts; p++) {
        const len = 1 + Math.floor(rnd() * (rnd() < 0.8 ? 64 : 5000));
        const a = Math.floor(rnd() * Math.max(1, L.capacity - len));
        for (let i = a; i < a + len; i++) {
          setXY(C, i, rnd() * 640, rnd() * 480);
          C.rotation[i] = rnd() * 6;
          C.scale[i] = 0.5 + rnd() * 2;
          C.frame[i] = (rnd() * 4) | 0;
          C.tint[i] = COLORS[(rnd() * 32) | 0];
          C.alpha[i] = rnd() < 0.1 ? 0 : 1;
          C.userId[i] = i + 1;
        }
        tryCall(out.throws, 'partial commit', () => ctx.binding.commit(len, a));
        out.partial++;
      }
      tryCall(out.throws, 'render', () => r.render());
      out.cpu.push(r.stats.cpuMs);
      out.frames++;
      await raf();
    }
    out.capacity = L.capacity;
    out.count = L.count;
    const cpu = out.cpu;
    out.cpu = { avg: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(3), max: +Math.max(...cpu).toFixed(3) };
    return out;
  }

  /**
   * Final state through partial commits only: every row off screen (chunks),
   * then 24 probe rows at known spots with a known tint and userId.
   */
  async function m5ColFinal(id, { chunk = 7919 } = {}) {
    const ctx = getCtx(id);
    const r = ctx.renderer;
    const L = ctx.layer;
    const C = ctx.cols;
    const count = L.count;
    for (let a = 0; a < count; a += chunk) {
      const len = Math.min(chunk, count - a);
      for (let i = a; i < a + len; i++) {
        setXY(C, i, -5000, -5000);
        C.alpha[i] = 1;
        C.scale[i] = 1;
        C.rotation[i] = 0;
        C.tint[i] = 0xffffff;
        C.userId[i] = i + 1;
      }
      ctx.binding.commit(len, a);
      if ((a / chunk) % 4 === 0) {
        r.render();
        await raf();
      }
    }
    const probes = [];
    const rnd = mulberry(5);
    for (let k = 0; k < 24; k++) {
      const row = Math.floor(rnd() * count);
      if (probes.some(p => p.row === row)) continue;
      const x = 40 + (k % 6) * 100;
      const y = 50 + Math.floor(k / 6) * 110;
      const tint = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00][k & 3];
      setXY(C, row, x, y);
      C.scale[row] = 6; // 4 px frame → 24 px square
      C.frame[row] = 0;
      C.tint[row] = tint;
      C.alpha[row] = 1;
      C.userId[row] = 0x10000 + k;
      ctx.binding.commit(1, row);
      probes.push({ row, x, y, tint, userId: 0x10000 + k });
    }
    // Frame 0's texture is COLORS[0]; tint multiplies it — use white frames for exact colours.
    L.frames = [solid(0xffffff, 4), ...ctx.frames.slice(1)];
    await settle(ctx, 10);
    const picks = [];
    for (const p of probes) {
      let hit = null;
      try {
        const pr = r.pick(p.x, p.y);
        for (let i = 0; i < 6; i++) {
          r.render();
          await raf();
        }
        hit = await pr;
      } catch (e) {
        hit = { error: errText(e) };
      }
      picks.push(hit ? { isLayer: hit.node === L, instance: hit.instance, userId: hit.userId, error: hit.error } : null);
    }
    return { count, capacity: L.capacity, probes, picks };
  }

  // ─── Texture slots (frames) growth ─────────────────────────────────────────

  async function m5FramesInit({ worker, backend }) {
    phase('m5FramesInit');
    const ctx = await createCtx({ worker, backend });
    const id = registerCtx(ctx);
    const r = ctx.renderer;
    const sources = [];
    for (let s = 0; s < 9; s++) sources.push(solid(COLORS[s * 3 + 1], 64));
    const L = new GPU.SpriteLayer({ capacity: 64, frames: [sources[0]], anchor: 0 });
    for (let i = 0; i < 64; i++) L.setInstance(i, 20 + (i % 8) * 76, 20 + Math.floor(i / 8) * 56, 0, 0.6, 0);
    L.count = 64;
    r.stage.addChild(L);
    await L.ready;
    await settle(ctx, 8);
    Object.assign(ctx, { layer: L, sources });
    return { ctxId: id, colors: sources.map((_, s) => COLORS[s * 3 + 1]), points: Array.from({ length: 64 }, (_, i) => [20 + (i % 8) * 76 + 9, 20 + Math.floor(i / 8) * 56 + 9]) };
  }

  /**
   * step 'eight'   : 8 sources, instance i uses frame i % 8
   * step 'many'    : 4096 frames (sub-rects) over 8 sources, instance i → frame 8·(i·37 % 512) + i % 8
   * step 'nine'    : 9 sources → must throw INVALID_ARGUMENT, drawing unchanged
   * step 'replace' : source 3 destroyed and replaced by source 8 (new colour)
   * step 'shrink'  : back to 1 frame while instances still name frames up to 4095
   * Returns the expected source index per instance.
   */
  async function m5FramesStep(id, step) {
    const ctx = getCtx(id);
    const L = ctx.layer;
    const src = ctx.sources;
    const out = { step, throws: [], expect: null };
    const setFrames = (f, label) => tryCall(out.throws, label, () => (L.frames = f));
    const setFrameIdx = fi => {
      for (let i = 0; i < 64; i++) {
        L.data.xform[4 * i + 3] = fi(i);
      }
      L.markDirty(0, 64);
    };
    switch (step) {
      case 'eight':
        setFrames(src.slice(0, 8), 'frames=8');
        setFrameIdx(i => i % 8);
        out.expect = Array.from({ length: 64 }, (_, i) => i % 8);
        ctx.map = src.slice(0, 8).map((_, s) => s);
        break;
      case 'many': {
        const f = [];
        for (let j = 0; j < 4096; j++) {
          const s = j % 8;
          const k = j >> 3;
          f.push(src[s].sub((k % 2) * 32, (Math.floor(k / 2) % 2) * 32, 32, 32));
        }
        ctx.manyFrames = f;
        setFrames(f, 'frames=4096');
        setFrameIdx(i => 8 * ((i * 37) % 512) + (i % 8));
        out.expect = Array.from({ length: 64 }, (_, i) => i % 8);
        break;
      }
      case 'nine': {
        const before = L.frames;
        setFrames(src.slice(0, 9), 'frames=9');
        out.code = out.throws.length ? out.throws[0] : 'no throw';
        out.throws.length = 0;
        out.unchanged = L.frames === before || L.frames.length === before.length;
        out.expect = Array.from({ length: 64 }, (_, i) => i % 8);
        break;
      }
      case 'replace': {
        const f = ctx.manyFrames.map(t => (t.sourceId === src[3].sourceId ? src[8].sub(t.frame.x, t.frame.y, 32, 32) : t));
        setFrames(f, 'frames replace');
        tryCall(out.throws, 'destroy src3', () => src[3].destroy());
        out.expect = Array.from({ length: 64 }, (_, i) => (i % 8 === 3 ? 8 : i % 8));
        break;
      }
      case 'shrink':
        setFrames([src[0]], 'frames=1');
        out.expect = null; // defined behaviour only: no errors
        break;
      default:
    }
    await settle(ctx, 10);
    out.drawCalls = ctx.renderer.stats.drawCalls;
    return out;
  }

  // ─── Culling while panning ────────────────────────────────────────────────

  function fillCullLayer(L, n, seed) {
    const rnd = mulberry(seed);
    for (let i = 0; i < n; i++) {
      // A world of 6 × 6 canvases around the origin, big sprites near the
      // canvas edges (centres off screen, extent on screen).
      const big = rnd() < 0.02;
      const x = (rnd() - 0.4) * W * 6;
      const y = (rnd() - 0.4) * H * 6;
      const sc = big ? 8 + rnd() * 20 : 0.5 + rnd() * 2;
      const color = rnd() < 0.05 ? 0x00ffffff : ((0xff << 24) | COLORS[(rnd() * 32) | 0]) >>> 0;
      L.setInstance(i, x, y, rnd() * 6, sc, (rnd() * 2) | 0, color);
    }
    L.count = n;
  }

  async function m5CullInit({ worker, backend, n = 200_000, margin = 0, filtered = false, inStatic = false, cullTest = true }) {
    phase('m5CullInit');
    const P = await pair({ worker, backend, ref: { retained: false } });
    P.worker = worker;
    const mk = (r, cull, test) => {
      const frames = [solid(0xffffff, 4), solid(0xffaa00, 6)];
      const L = new GPU.SpriteLayer({ capacity: n, frames, cull, cullMargin: margin, pickable: true, streams: { xform: true, color: true, user: true } });
      fillCullLayer(L, n, 3);
      for (let i = 0; i < n; i++) L.data.user[i] = i + 1;
      L.markDirty(0, n);
      let parent = r.stage;
      if (filtered) {
        const g = new GPU.Group({ filters: [GPU.filters.blur({ strength: 2 })] });
        r.stage.addChild(g);
        parent = g;
      } else if (inStatic) {
        const c = new GPU.Container({ static: test });
        c.addChild(new GPU.Sprite({ texture: frames[1], x: 5, y: 5, width: 20, height: 20 }));
        r.stage.addChild(c);
        parent = c;
      }
      parent.addChild(L);
      return L;
    };
    P.LA = mk(P.test.renderer, cullTest, true);
    P.LB = mk(P.ref.renderer, false, false);
    await Promise.all([P.LA.ready, P.LB.ready]);
    await settleBoth(P, 10);
    const key = nextKey++;
    states.set(key, P);
    return { key, rect: shotRect(), test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer), dpr: devicePixelRatio, cullOn: P.LA.cull, resolution: P.test.renderer.resolution };
  }

  /** Pans/zooms/rotates both layers to pose `k` of a deterministic path. */
  async function m5CullStep(key, k, { pick = false } = {}) {
    const P = states.get(key);
    const t = k * 0.37;
    for (const L of [P.LA, P.LB]) {
      L.x = Math.sin(t) * W * 1.8;
      L.y = Math.cos(t * 1.3) * H * 1.8;
      L.rotation = k % 3 === 2 ? Math.sin(t) * 0.6 : 0;
      const s = k % 4 === 3 ? 0.35 : k % 4 === 1 ? 1.8 : 1;
      L.setScale(s, s);
    }
    await settleBoth(P, 8);
    const out = { k, pose: { x: +P.LA.x.toFixed(1), y: +P.LA.y.toFixed(1), rot: +P.LA.rotation.toFixed(2), s: P.LA.scaleX }, test: statsOf(P.test.renderer) };
    if (pick) {
      const pts = [];
      const rnd = mulberry(1000 + k);
      for (let i = 0; i < 8; i++) pts.push([rnd() * W, rnd() * H]);
      out.picks = [];
      for (const [x, y] of pts) {
        const a = P.test.renderer.pick(x, y);
        const b = P.ref.renderer.pick(x, y);
        for (let i = 0; i < 6; i++) {
          renderBoth(P);
          await raf();
        }
        const [ha, hb] = await Promise.all([a, b]);
        out.picks.push({ x: Math.round(x), y: Math.round(y), test: ha ? ha.userId : 0, ref: hb ? hb.userId : 0 });
      }
    }
    return out;
  }

  // ─── Device loss with retained segments, static containers and layers ─────

  async function m5LossInit({ worker, backend, seed = 33 }) {
    phase('m5LossInit');
    const P = await pair({ worker, backend, ref: { retained: false } });
    P.worker = worker;
    const spec = makeSpec(seed, 200, 10, true);
    P.A = buildMixed(P.test.renderer, spec, { static: false });
    P.B = buildMixed(P.ref.renderer, spec);
    // Static container (test side static) with content.
    for (const [S, st] of [[P.A, true], [P.B, false]]) {
      const c = new GPU.Container({ static: st, x: 250, y: 10 });
      for (let i = 0; i < 40; i++) c.addChild(new GPU.Sprite({ texture: S.tex[i % 10], x: (i % 8) * 24, y: Math.floor(i / 8) * 24, width: 20, height: 20 }));
      const g = new GPU.Graphics();
      g.circle(100, 140, 30).fill(0xffffff);
      c.addChild(g);
      S.r.stage.addChild(c);
      S.staticC = c;
    }
    // A column-bound layer (direct xy + packed tint) and a culled own-store layer.
    for (const S of [P.A, P.B]) {
      const n = 20000;
      const L = new GPU.SpriteLayer({ capacity: n, frames: [solid(0xffffff, 2)] });
      const xy = new Float32Array(sab(n * 8));
      const tint = new Uint32Array(sab(n * 4));
      const rnd = mulberry(8);
      for (let i = 0; i < n; i++) {
        xy[2 * i] = 10 + rnd() * 200;
        xy[2 * i + 1] = 200 + rnd() * 90;
        tint[i] = COLORS[i % 32];
      }
      const B = L.bindColumns({ xy, tint });
      B.commit(n);
      S.r.stage.addChild(L);
      const L2 = new GPU.SpriteLayer({ capacity: 50000, frames: [solid(0x80ff80, 2)], cull: true });
      fillCullLayer(L2, 50000, 4);
      L2.setScale(0.3, 0.3);
      L2.setPosition(300, 180);
      S.r.stage.addChild(L2);
      Object.assign(S, { colLayer: L, xy, tint, binding: B, cullLayer: L2 });
    }
    await Promise.all([P.A.colLayer.ready, P.A.cullLayer.ready, P.B.colLayer.ready, P.B.cullLayer.ready]);
    await settleBoth(P, 12);
    P.spec = spec;
    P.ntex = 10;
    const key = nextKey++;
    states.set(key, P);
    return { key, rect: shotRect(), test: statsOf(P.test.renderer), ref: statsOf(P.ref.renderer), testId: P.testId };
  }

  function m5LossInfo(key) {
    const P = states.get(key);
    return { lost: P.test.events.lost.length, restored: P.test.events.restored, refLost: P.ref.events.lost.length, test: statsOf(P.test.renderer) };
  }
  /** Loses the test renderer's device (needs debug: true). */
  function m5Lose(key) {
    const P = states.get(key);
    const r = P.test.renderer;
    if (typeof r._debug === 'function') {
      r._debug('loseDevice');
      return 'ok';
    }
    const core = globalThis.__COZYGPU_CORE__;
    if (!core) return 'no core handle';
    core.backend.simulateDeviceLoss();
    return 'ok';
  }
  /** Keeps both rendering while waiting for the test side to restore. */
  async function m5LossWait(key, { timeoutMs = 15000 } = {}) {
    const P = states.get(key);
    const before = P.test.events.restored;
    const end = performance.now() + timeoutMs;
    const throws = [];
    while (performance.now() < end && P.test.events.restored === before) {
      tryCall(throws, 'render', () => renderBoth(P));
      await raf();
    }
    await settleBoth(P, 20);
    return { restored: P.test.events.restored > before, throws, ...m5LossInfo(key) };
  }
  /** Edits after a restore: column commit, a Graphics edit, a static child tint. */
  async function m5LossEdit(key) {
    const P = states.get(key);
    for (const S of [P.A, P.B]) {
      for (let i = 0; i < 5000; i++) S.xy[2 * i] += 30;
      S.binding.commit(5000, 0);
      S.staticC.children[3].tint = 0xff0000;
      S.cullLayer.x += 40;
    }
    for (let e = 0; e < 8; e++) {
      const o = genOp(P.spec.rnd, P.ntex);
      applyOp(P.A, o);
      applyOp(P.B, o);
    }
    await settleBoth(P, 10);
    return { test: statsOf(P.test.renderer) };
  }

  function m5Drop(key) {
    const P = states.get(key);
    if (!P) return;
    states.delete(key);
    for (const id of [P.testId, P.refId]) {
      const ctx = getCtx(id);
      if (ctx) {
        stopLoop(ctx);
        try {
          ctx.renderer.destroy();
        } catch {}
        ctx.canvas.remove();
      }
    }
  }


  // ─── Shared-memory registrations of layer stores (leaks) ───────────────────

  async function m5LeakInit({ worker, backend }) {
    phase('m5LeakInit');
    const ctx = await createCtx({ worker, backend, debug: true });
    const id = registerCtx(ctx);
    ctx.refs = [];
    ctx.tex = solid(0xffffff, 2);
    await settle(ctx, 4);
    return { ctxId: id };
  }
  /**
   * 'create': a 1M layer (all streams), drawn; 'grow': capacity + 250k;
   * 'rebind': new xy column; 'destroy': the layer destroyed. Keeps WeakRefs
   * to every store or column it drops (main thread: they must be collectable).
   */
  async function m5LeakStep(id, step) {
    const ctx = getCtx(id);
    const r = ctx.renderer;
    const out = { step, throws: [] };
    const L = ctx.layer;
    const keep = buf => ctx.refs.push(new WeakRef(buf));
    if (step === 'create') {
      const n = 1_000_000;
      const l = new GPU.SpriteLayer({ capacity: n, frames: [ctx.tex], streams: { xform: true, color: true, user: true } });
      for (let i = 0; i < n; i += 997) l.setInstance(i, (i % 640) + 0.5, (i / 640) % 480, 0, 1, 0);
      l.markDirty(0, n);
      l.count = n;
      r.stage.addChild(l);
      await l.ready;
      ctx.layer = l;
    } else if (step === 'grow') {
      for (const k of ['position', 'xform', 'color', 'user']) keep(L.data[k].buffer);
      tryCall(out.throws, 'grow', () => (L.capacity = L.capacity + 250_000));
    } else if (step === 'rebind') {
      if (ctx.xy) keep(ctx.xy.buffer);
      ctx.xy = new Float32Array(sab(L.capacity * 8));
      ctx.xy.set(L.data.position);
      if (!ctx.binding) ctx.binding = L.bindColumns({ xy: ctx.xy });
      else ctx.binding.rebind({ xy: ctx.xy });
      ctx.binding.commit(L.count);
    } else if (step === 'destroy') {
      for (const k of ['position', 'xform', 'color', 'user']) keep(L.data[k].buffer);
      if (ctx.xy) keep(ctx.xy.buffer);
      ctx.xy = null;
      ctx.binding = null;
      L.destroy();
      ctx.layer = null;
    }
    await settle(ctx, 6);
    out.drawCalls = r.stats.drawCalls;
    return out;
  }
  /** Main thread only: how many dropped buffers are still reachable (after a GC). */
  function m5LeakAlive(id) {
    const ctx = getCtx(id);
    let alive = 0;
    let bytes = 0;
    for (const w of ctx.refs) {
      const b = w.deref();
      if (b) {
        alive++;
        bytes += b.byteLength;
      }
    }
    return { dropped: ctx.refs.length, alive, aliveMB: +(bytes / 1048576).toFixed(1) };
  }

  // console.warn counter (static container + Group warning).
  if (!globalThis.__m5WarnHooked) {
    globalThis.__m5WarnHooked = true;
    const ow = console.warn;
    console.warn = function (...a) {
      globalThis.__m5Warn = (globalThis.__m5Warn ?? 0) + 1;
      return ow.apply(this, a);
    };
  }

  return {
    m5Diff,
    m5Sample,
    m5RetInit,
    m5RetStep,
    m5StaticInit,
    m5StaticStep,
    m5StaticMeasure,
    m5LayerScale,
    m5ColInit,
    m5ColChurn,
    m5ColFinal,
    m5FramesInit,
    m5FramesStep,
    m5CullInit,
    m5CullStep,
    m5LossInit,
    m5LossInfo,
    m5Lose,
    m5LossWait,
    m5LossEdit,
    m5Drop,
    m5LeakInit,
    m5LeakStep,
    m5LeakAlive,
    m5Shot: shotRect,
  };
}
