// Graphics scenarios for tests/browser/stress.mjs: animated SDF shapes, paths
// rebuilt every frame, shared contexts, Graphics as a mask, picking with
// userId, device loss, allocations of a static scene. Installed into
// globalThis.stress by stress-page.js. Every function returns plain JSON; the
// Node side decides pass/fail. Pixel checks reuse stress.regionColors
// (640 × 480 canvases).
import * as GPU from 'cozygpu';

export function installGfx(h) {
  const { createCtx, startLoop, stopLoop, registerCtx, getCtx, settle, sleep, raf, errText, phase } = h;

  const mulberry = seed => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const PALETTE = [0x22d3ee, 0xfacc15, 0xe879f9, 0xfb923c, 0xa3e635, 0xf8fafc];
  const checker = (n = 16) => {
    const px = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const on = ((x >> 2) + (y >> 2)) & 1;
        const i = (y * n + x) * 4;
        px[i] = on ? 255 : 40;
        px[i + 1] = on ? 255 : 40;
        px[i + 2] = on ? 255 : 40;
        px[i + 3] = 255;
      }
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

  // ─── Measured loop ────────────────────────────────────────────────────────
  function startMeasured(ctx, each) {
    const m = { dt: [], cpu: [], rec: [], packet: [], draws: [], last: 0 };
    const r = ctx.renderer;
    startLoop(ctx, f => {
      const now = performance.now();
      if (m.last) {
        m.dt.push(now - m.last);
        m.cpu.push(r.stats.cpuMs);
        m.packet.push(r.stats.packetBytes);
        m.draws.push(r.stats.drawCalls);
      }
      m.last = now;
      if (each) {
        const t0 = performance.now();
        each(f);
        m.rec.push(performance.now() - t0);
      }
    });
    ctx.meter = m;
    return m;
  }
  const stat = a => {
    if (!a.length) return null;
    const s = Float64Array.from(a).sort();
    let sum = 0;
    for (const v of a) sum += v;
    return { avg: +(sum / a.length).toFixed(3), p50: +s[Math.floor(s.length * 0.5)].toFixed(3), p99: +s[Math.min(s.length - 1, Math.floor(s.length * 0.99))].toFixed(3), max: +s[s.length - 1].toFixed(3) };
  };
  function meterSummary(m) {
    const dt = stat(m.dt);
    return {
      frames: m.dt.length,
      fps: dt ? +(1000 / dt.avg).toFixed(1) : 0,
      frameMs: dt,
      cpuMs: stat(m.cpu),
      recordMs: stat(m.rec),
      packetBytes: stat(m.packet),
      drawCalls: stat(m.draws),
    };
  }
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
    };
  }
  const infoOf = g => {
    const i = g.context.info;
    return { sdfShapes: i.sdfShapes, meshVertices: i.meshVertices, meshTriangles: i.meshTriangles, version: i.version };
  };

  // ─── Probe shapes (static, top band y < 180) ─────────────────────────────
  // Red circle, blue rounded rect, green ellipse, white stroke-only ring.
  function probeGraphics() {
    const g = new GPU.Graphics();
    g.circle(80, 90, 50).fill(0xff0000);
    g.roundRect(200, 40, 120, 100, 20).fill(0x0000ff);
    g.ellipse(450, 90, 80, 45).fill(0x00ff00);
    g.circle(580, 90, 40).stroke({ width: 8, color: 0xffffff });
    return g;
  }
  const PROBE_REGIONS = {
    red: [60, 70, 40, 40],
    blue: [220, 60, 80, 60],
    green: [420, 78, 60, 24],
    ringCenter: [570, 80, 20, 20],
    ringBand: [616, 86, 5, 8],
  };

  // ─── 1. Animated SDF shapes ───────────────────────────────────────────────
  // variant 'nodes':   `count` Graphics with one shape each, all moving.
  // variant 'redraw':  one Graphics, cleared and re-recorded with `count`
  //                    shapes at new positions every frame.
  // variant 'batched': 500 Graphics × count/500 shapes, nodes rotating.
  // Moving shapes stay in the band y ∈ [200, 480]; probes above it.
  function sdfShape(g, i, x, y) {
    const c = PALETTE[i % PALETTE.length];
    switch (i % 5) {
      case 0:
        g.circle(x, y, 3).fill(c);
        break;
      case 1:
        g.rect(x - 3, y - 3, 6, 6).fill(c);
        break;
      case 2:
        g.roundRect(x - 4, y - 3, 8, 6, 2).fill(c);
        break;
      case 3:
        g.ellipse(x, y, 4, 2.5).fill(c);
        break;
      default:
        g.circle(x, y, 3).fill(c).stroke({ width: 1, color: 0xffffff });
    }
  }

  async function gfxSdfInit({ worker, backend, count = 50_000, variant = 'nodes', seconds = 6 }) {
    phase(`gfxSdfInit ${variant}`);
    const ctx = await createCtx({ worker, backend });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const rand = mulberry(7);
    const N = count;
    const xs = new Float32Array(N);
    const ys = new Float32Array(N);
    const vx = new Float32Array(N);
    const vy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      xs[i] = 5 + rand() * 630;
      ys[i] = 205 + rand() * 270;
      vx[i] = (rand() - 0.5) * 3;
      vy[i] = (rand() - 0.5) * 3;
    }
    const step = () => {
      for (let i = 0; i < N; i++) {
        let x = xs[i] + vx[i];
        let y = ys[i] + vy[i];
        if (x < 5 || x > 635) (vx[i] = -vx[i]), (x = xs[i]);
        if (y < 205 || y > 475) (vy[i] = -vy[i]), (y = ys[i]);
        xs[i] = x;
        ys[i] = y;
      }
    };
    const nodes = [];
    let big = null;
    const t0 = performance.now();
    if (variant === 'nodes') {
      for (let i = 0; i < N; i++) {
        const g = new GPU.Graphics();
        sdfShape(g, i, 0, 0);
        g.x = xs[i];
        g.y = ys[i];
        stage.addChild(g);
        nodes.push(g);
      }
    } else if (variant === 'redraw') {
      big = new GPU.Graphics();
      stage.addChild(big);
      for (let i = 0; i < N; i++) sdfShape(big, i, xs[i], ys[i]);
      nodes.push(big);
    } else {
      const B = 500;
      const per = Math.ceil(N / B);
      for (let b = 0; b < B; b++) {
        const g = new GPU.Graphics();
        for (let k = 0; k < per && b * per + k < N; k++) sdfShape(g, b * per + k, (rand() - 0.5) * 60, (rand() - 0.5) * 60);
        g.x = 40 + (b % 25) * 23.3;
        g.y = 240 + Math.floor(b / 25) * 11;
        stage.addChild(g);
        nodes.push(g);
      }
    }
    const probe = probeGraphics();
    stage.addChild(probe);
    const buildMs = performance.now() - t0;
    await Promise.all([probe.ready, nodes[0].ready, nodes[nodes.length - 1].ready]);
    await settle(ctx, 4);
    const m = startMeasured(ctx, f => {
      if (variant === 'nodes') {
        step();
        for (let i = 0; i < N; i++) {
          const g = nodes[i];
          g.x = xs[i];
          g.y = ys[i];
        }
      } else if (variant === 'redraw') {
        step();
        big.clear();
        for (let i = 0; i < N; i++) sdfShape(big, i, xs[i], ys[i]);
      } else {
        for (let b = 0; b < nodes.length; b++) nodes[b].rotation = f * 0.02 + b;
      }
    });
    await sleep(seconds * 1000);
    const summary = meterSummary(m);
    ctx.gfx = { nodes, probe };
    return { ctxId: registerCtx(ctx), buildMs: +buildMs.toFixed(1), summary, nodeInfo: infoOf(nodes[0]), probeInfo: infoOf(probe), regions: { ...PROBE_REGIONS, band: [0, 210, 640, 260] }, ...loopInfo(ctx) };
  }

  // ─── 2. Complex paths rebuilt every frame ─────────────────────────────────
  // P0: red square path with a circular hole (cut) at 40..160 → hole r 30 at
  //     (100, 100). P1: 1000-point chart (green) y ≈ 300..420. Flip node: a
  //     blue SDF rect on odd frames, a blue mesh polygon on even ones (180..
  //     280 × 40..140). Eight blobs (beziers, stars, arcTo, quadratics, pies,
  //     holes, self-intersecting polygons) and a textured polygon. All of it
  //     is cleared and re-recorded every frame.
  function blob(g, k, cx, cy, t) {
    g.save();
    g.setTransform(Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), cx, cy);
    const c = PALETTE[k % PALETTE.length];
    switch (k) {
      case 0:
        g.moveTo(-40, 0).bezierCurveTo(-40, -50, 40, -50, 40, 0).bezierCurveTo(40, 30 + 10 * Math.sin(t * 3), -40, 40, -40, 0).closePath().fill(c).stroke({ width: 3, color: 0xffffff, join: 'round' });
        break;
      case 1:
        g.star(0, 0, 7, 40, 18 + 6 * Math.sin(t * 2)).fill(c).stroke({ width: 4, color: 0x2563eb, join: 'miter', miterLimit: 4 });
        break;
      case 2:
        g.moveTo(-40, 30).arcTo(0, -50, 40, 30, 12).arcTo(40, 30, -40, 30, 8).arcTo(-40, 30, 0, -50, 10).closePath().fill(c).stroke({ width: 2, color: 0xffffff, join: 'bevel' });
        break;
      case 3:
        g.moveTo(-40, 0);
        for (let i = 0; i < 8; i++) g.quadraticCurveTo(-35 + i * 10, (i & 1 ? -30 : 30) * Math.cos(t), -30 + i * 10, 0);
        g.lineTo(40, 40).lineTo(-40, 40).closePath().fill(c);
        break;
      case 4:
        g.moveTo(0, 0).arc(0, 0, 40, 0.3, 0.3 + 4 + Math.sin(t)).closePath().fill(c).stroke({ width: 2, color: 0xffffff, alignment: 1 });
        break;
      case 5:
        g.regularPoly(0, 0, 40, 6, t).fill(c).circle(0, 0, 15).cut().stroke({ width: 3, color: 0xffffff, cap: 'round' });
        break;
      case 6:
        g.ellipse(0, 0, 42, 30).fill(c);
        g.circle(-15, 0, 8).circle(15, 0, 8).cut();
        g.poly([-30, -30, 30, -30, 30, 30], false).stroke({ width: 3, color: 0xff00ff, cap: 'square', join: 'miter' });
        break;
      default:
        g.poly([-40, -40, 40, 40, 40, -40, -40, 40]).fill(c).stroke({ width: 2, color: 0xffffff });
    }
    g.restore();
  }

  async function gfxPathsInit({ worker, backend, seconds = 6 }) {
    phase('gfxPathsInit');
    const ctx = await createCtx({ worker, backend });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const tex = checker();
    const square = new GPU.Graphics();
    const chart = new GPU.Graphics();
    const flip = new GPU.Graphics();
    const textured = new GPU.Graphics();
    const blobs = [];
    for (const g of [square, chart, flip, textured]) stage.addChild(g);
    const centers = [
      [340, 90],
      [440, 90],
      [560, 90],
      [60, 240],
      [180, 240],
      [300, 240],
      [420, 240],
      [560, 240],
    ];
    for (let k = 0; k < 8; k++) {
      const g = new GPU.Graphics();
      stage.addChild(g);
      blobs.push(g);
    }
    const throws = [];
    const rebuild = f => {
      const t = f / 60;
      square.clear().moveTo(40, 40).lineTo(160, 40).lineTo(160, 160).lineTo(40, 160).closePath().fill(0xff0000).stroke({ width: 4, color: 0xffffff, join: 'round' }).circle(100, 100, 30).cut();
      chart.clear().moveTo(0, 360);
      for (let i = 0; i < 1000; i++) chart.lineTo(i * 0.64, 360 + 45 * Math.sin(i * 0.05 + t * 3) + 10 * Math.sin(i * 0.31 + t));
      chart.stroke({ width: 3, color: 0x00ff00, join: 'round', cap: 'round' });
      flip.clear();
      if (f & 1) flip.rect(180, 40, 100, 100).fill(0x0000ff);
      else flip.poly([180, 40, 230, 40, 280, 40, 280, 140, 180, 140]).fill(0x0000ff);
      textured.clear().poly([20, 430, 300, 430, 300, 470, 20, 470]).fill({ texture: tex, textureSpace: f & 2 ? 'global' : 'local' });
      for (let k = 0; k < 8; k++) {
        blobs[k].clear();
        blob(blobs[k], k, centers[k][0], centers[k][1], t + k);
      }
      // Every 90 frames zoom one blob up and back (forces a finer tessellation).
      const z = f % 90 < 45 ? 1 : 2.5;
      blobs[7].scaleX = blobs[7].scaleY = z;
      blobs[7].pivotX = blobs[7].pivotY = 0;
    };
    try {
      rebuild(0);
    } catch (e) {
      throws.push(errText(e));
    }
    await Promise.all([square.ready, chart.ready, flip.ready, textured.ready, ...blobs.map(b => b.ready)]);
    const m = startMeasured(ctx, f => rebuild(f + 1));
    await sleep(seconds * 1000);
    const summary = meterSummary(m);
    ctx.gfx = { square, chart, flip, textured, blobs, rebuild };
    return {
      ctxId: registerCtx(ctx),
      summary,
      throws,
      info: { square: infoOf(square), chart: infoOf(chart), flip: infoOf(flip), textured: infoOf(textured), blobs: blobs.map(infoOf) },
      regions: { squareFill: [46, 50, 18, 100], hole: [92, 92, 16, 16], flip: [195, 55, 70, 70], chart: [0, 300, 640, 125], textured: [30, 435, 260, 30], blobs: [300, 40, 300, 100] },
      ...loopInfo(ctx),
    };
  }

  // ─── 3. Shared contexts ───────────────────────────────────────────────────
  // ctxA (SDF circle) drawn by `perSide` nodes on the left half, ctxB (mesh
  // star) by `perSide` nodes on the right half, all jittering every frame.
  async function gfxSharedInit({ worker, backend, perSide = 4000 }) {
    phase('gfxSharedInit');
    const ctx = await createCtx({ worker, backend });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const A = new GPU.GraphicsContext();
    A.circle(0, 0, 8).fill(0xff0000);
    const B = new GPU.GraphicsContext();
    B.star(0, 0, 5, 10, 6).fill(0x0000ff);
    const rand = mulberry(11);
    const left = [];
    const right = [];
    const bx = new Float32Array(perSide * 2);
    const by = new Float32Array(perSide * 2);
    for (let i = 0; i < perSide * 2; i++) {
      const isLeft = i < perSide;
      const g = new GPU.Graphics(isLeft ? A : B);
      bx[i] = (isLeft ? 40 : 340) + rand() * 260;
      by[i] = 40 + rand() * 400;
      g.x = bx[i];
      g.y = by[i];
      stage.addChild(g);
      (isLeft ? left : right).push(g);
    }
    ctx.gfx = { A, B, left, right, bx, by, swap: false, throws: [] };
    const all = left.concat(right);
    startMeasured(ctx, f => {
      const s = ctx.gfx;
      for (let i = 0; i < all.length; i++) {
        const g = all[i];
        if (g.destroyed) continue;
        g.x = bx[i] + Math.sin(f * 0.1 + i) * 2;
        g.y = by[i] + Math.cos(f * 0.1 + i) * 2;
      }
      if (s.swap) {
        // Context swap + tint churn on 500 nodes per side, undone the next frame.
        for (let k = 0; k < 500; k++) {
          const a = left[(f * 37 + k) % left.length];
          const b = right[(f * 53 + k) % right.length];
          tryCall(s.throws, 'swap', () => {
            if (f & 1) {
              a.context = s.A;
              b.context = s.B;
              a.tint = 0xffffff;
              b.tint = 0xffffff;
            } else {
              a.context = s.B;
              b.context = s.A;
              a.tint = 0x808080;
              b.tint = 0x808080;
            }
          });
        }
      }
    });
    await Promise.all([left[0].ready, right[0].ready]);
    await sleep(600);
    return { ctxId: registerCtx(ctx), regions: { left: [40, 40, 260, 400], right: [340, 40, 260, 400] }, info: { A: A.info, B: B.info }, ...loopInfo(ctx) };
  }

  async function gfxSharedStep(id, step, o = {}) {
    const ctx = getCtx(id);
    const s = ctx.gfx;
    const out = { step, throws: [] };
    switch (step) {
      case 'recolor':
        // Every node on both sides follows the shared context.
        tryCall(out.throws, 'A', () => s.A.clear().circle(0, 0, 8).fill(0x00ff00));
        tryCall(out.throws, 'B', () => s.B.clear().star(0, 0, 5, 11, 5).fill(0xff0000));
        break;
      case 'swapStart':
        s.swap = true;
        break;
      case 'swapStop': {
        s.swap = false;
        await raf();
        for (const g of s.left) {
          g.context = s.A;
          g.tint = 0xffffff;
        }
        for (const g of s.right) {
          g.context = s.B;
          g.tint = 0xffffff;
        }
        out.swapThrows = s.throws.slice();
        break;
      }
      case 'second': {
        // A second renderer drawing the same two contexts (300 × 200 at x 660).
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'display:block;position:absolute;left:660px;top:0;width:300px;height:200px';
        document.body.appendChild(canvas);
        const c2 = await createCtx({ worker: o.worker, backend: o.backend, canvas });
        const n2 = [];
        for (let i = 0; i < 200; i++) {
          const g = new GPU.Graphics(i < 100 ? s.A : s.B);
          g.x = (i < 100 ? 10 : 160) + (i % 10) * 13;
          g.y = 20 + Math.floor((i % 100) / 10) * 17;
          c2.renderer.stage.addChild(g);
          n2.push(g);
        }
        startLoop(c2);
        await n2[0].ready;
        await sleep(500);
        s.second = registerCtx(c2);
        s.n2 = n2;
        out.secondId = s.second;
        out.regions2 = { left: [10, 15, 130, 175], right: [160, 15, 130, 175] };
        break;
      }
      case 'recolorBlue':
        tryCall(out.throws, 'A', () => s.A.clear().circle(0, 0, 8).fill(0x0000ff));
        break;
      case 'destroySecond': {
        const c2 = getCtx(s.second);
        stopLoop(c2);
        for (const g of s.n2) g.destroy();
        c2.renderer.destroy();
        c2.canvas.remove();
        out.contextsAlive = { A: !s.A.destroyed, B: !s.B.destroyed };
        break;
      }
      case 'destroyNodes': {
        // Default destroy keeps a shared context; destroy half the left side.
        for (let i = 0; i < s.left.length; i += 2) tryCall(out.throws, 'destroy', () => s.left[i].destroy());
        out.contextsAlive = { A: !s.A.destroyed, B: !s.B.destroyed };
        break;
      }
      case 'destroyContextB':
        // Destroy a context that 4000 live nodes still draw.
        tryCall(out.throws, 'B.destroy', () => s.B.destroy());
        out.Bdestroyed = s.B.destroyed;
        break;
      case 'rehomeRight':
        // The orphaned nodes take ctxA (blue circles now).
        for (const g of s.right) tryCall(out.throws, 'rehome', () => (g.context = s.A));
        break;
    }
    await sleep(400);
    return { ...out, info: { A: s.A.info, B: s.B.destroyed ? null : s.B.info }, ...loopInfo(ctx) };
  }

  // ─── 4. Graphics as mask ──────────────────────────────────────────────────
  // Row A (y 20..200): masks clip a blue Graphics rect; row B (y 250..430):
  // inverted masks clip a blue sprite. Panel i at x = 20 + 210·i. Mask i
  // covers x ∈ [px, px+120] over the whole panel height:
  //   0 rect (scissor), 1 roundRect (SDF), 2 polygon (mesh).
  const MPX = i => 20 + 210 * i;
  const ROWS = [20, 250];
  function drawMask(g, i, px, py) {
    g.clear();
    if (i === 0) g.rect(px, py, 120, 180).fill(0xffffff);
    else if (i === 1) g.roundRect(px, py - 10, 120, 200, 12).fill(0xffffff);
    else g.poly([px, py - 10, px + 60, py - 10, px + 120, py - 10, px + 120, py + 190, px, py + 190]).fill(0xffffff);
  }
  function maskRegionsGfx() {
    const r = {};
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 3; i++) {
        const px = MPX(i);
        const py = ROWS[row];
        r[`${row ? 'B' : 'A'}${i}.in`] = [px + 10, py + 40, 100, 100];
        r[`${row ? 'B' : 'A'}${i}.right`] = [px + 132, py + 40, 40, 100];
      }
    }
    r.ctrl = [25, 445, 50, 20];
    return r;
  }

  async function gfxMaskInit({ worker, backend }) {
    phase('gfxMaskInit');
    const ctx = await createCtx({ worker, backend });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const white = GPU.Texture.fromPixels(1, 1, new Uint8Array([255, 255, 255, 255]));
    const panels = [];
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 3; i++) {
        const px = MPX(i);
        const py = ROWS[row];
        const group = new GPU.Group();
        let content;
        if (row === 0) content = new GPU.Graphics().rect(px, py, 180, 180).fill(0x0000ff);
        else content = new GPU.Sprite({ texture: white, x: px, y: py, width: 180, height: 180, tint: 0x0000ff });
        group.addChild(content);
        // A moving Graphics child too (exercises SDF instances inside a masked subtree).
        const dot = new GPU.Graphics().circle(0, 0, 6).fill(0x0000ff);
        dot.x = px + 60;
        dot.y = py + 20;
        group.addChild(dot);
        const mask = new GPU.Graphics();
        drawMask(mask, i, px, py);
        stage.addChild(group);
        const P = { row, i, px, py, group, mask, dot, invert: row === 1, mode: 'auto' };
        group.mask = { source: mask, invert: P.invert };
        panels.push(P);
      }
    }
    const ctrl = new GPU.Graphics().rect(20, 440, 60, 30).fill(0xff0000);
    stage.addChild(ctrl);
    ctx.gfx = { panels, churn: false, throws: [], toggles: 0, modeSwaps: 0 };
    startLoop(ctx, f => {
      const s = ctx.gfx;
      for (const P of panels) P.dot.x = P.px + 60 + Math.sin(f * 0.05 + P.i) * 50;
      if (!s.churn) return;
      for (const P of panels) {
        tryCall(s.throws, 'churn', () => {
          if (P.i !== 0) drawMask(P.mask, P.i, P.px, P.py); // re-recorded every frame
          if (P.i === 2) P.mask.rotation = 0.002 * Math.sin(f * 0.3); // tiny wobble
          if ((f + P.i * 7) % 20 === 0) {
            P.group.mask = null;
            s.toggles++;
          } else if ((f + P.i * 7) % 20 === 3) P.group.mask = { source: P.mask, invert: P.invert, mode: P.mode };
          if ((f + P.i * 11) % 45 === 0 && P.i !== 0) {
            P.mode = ['auto', 'stencil', 'alpha'][(f / 45 + P.i) % 3 | 0];
            P.group.mask = { source: P.mask, invert: P.invert, mode: P.mode };
            s.modeSwaps++;
          }
        });
      }
    });
    await Promise.all(panels.map(P => P.group.ready));
    await sleep(600);
    return { ctxId: registerCtx(ctx), regions: maskRegionsGfx(), modes: gfxMaskModes(ctx), stencilCap: !!ctx.renderer.info.capabilities.stencil, ...loopInfo(ctx) };
  }
  const gfxMaskModes = ctx => ctx.gfx.panels.map(P => `${P.row ? 'B' : 'A'}${P.i}:${P.group._maskBinding?.mode ?? 'none'}`);

  async function gfxMaskChurn(id, { seconds = 6 }) {
    const ctx = getCtx(id);
    const s = ctx.gfx;
    s.churn = true;
    await sleep(seconds * 1000);
    s.churn = false;
    await raf();
    for (const P of s.panels) {
      P.mode = 'auto';
      P.mask.rotation = 0;
      drawMask(P.mask, P.i, P.px, P.py);
      P.group.mask = { source: P.mask, invert: P.invert };
    }
    await Promise.all(s.panels.map(P => P.group.ready));
    await sleep(500);
    return { throws: s.throws.slice(), toggles: s.toggles, modeSwaps: s.modeSwaps, modes: gfxMaskModes(ctx), ...loopInfo(ctx) };
  }

  /** Mask nodes rotated by 45° (rect mask can no longer be a scissor). */
  async function gfxMaskRotate(id, deg) {
    const ctx = getCtx(id);
    for (const P of ctx.gfx.panels) {
      P.mask.pivotX = P.px + 60;
      P.mask.pivotY = P.py + 90;
      P.mask.x = P.px + 60;
      P.mask.y = P.py + 90;
      P.mask.rotation = (deg * Math.PI) / 180;
    }
    await sleep(500);
    return { modes: gfxMaskModes(ctx), ...loopInfo(ctx) };
  }

  // ─── 5. Picking with userId ───────────────────────────────────────────────
  async function gfxPickInit({ worker, backend, background = 5000 }) {
    phase('gfxPickInit');
    const ctx = await createCtx({ worker, backend, debug: false });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const labels = new Map();
    const add = (label, g) => {
      labels.set(g, label);
      stage.addChild(g);
      return g;
    };
    // Background load: non-pickable moving Graphics in the band y 400..480.
    const bg = [];
    const rand = mulberry(3);
    for (let i = 0; i < background; i++) {
      const g = new GPU.Graphics();
      g.circle(0, 0, 3).fill(PALETTE[i % PALETTE.length]);
      g.x = rand() * 640;
      g.y = 400 + rand() * 80;
      stage.addChild(g);
      bg.push(g);
    }
    const white = GPU.Texture.fromPixels(1, 1, new Uint8Array([255, 255, 255, 255]));
    const N = {};
    N.circle = add('circle', new GPU.Graphics({ pickable: true, userId: 101 }).circle(100, 100, 50).fill(0xff0000));
    N.behind = add('behind', new GPU.Graphics({ pickable: true, userId: 103 }).rect(250, 50, 100, 100).fill(0x202060));
    N.ring = add('ring', new GPU.Graphics({ pickable: true, userId: 102 }).circle(300, 100, 40).stroke({ width: 12, color: 0xffffff }));
    N.hit = add('hit', new GPU.Graphics({ pickable: true, userId: 104 }).rect(420, 40, 120, 120).fill({ color: 0x000000, alpha: 0 }));
    N.star = add('star', new GPU.Graphics({ pickable: true, userId: 105 }).star(100, 300, 5, 60, 25).fill(0x00ff00));
    N.sprite = add('sprite', new GPU.Sprite({ texture: white, x: 260, y: 250, width: 80, height: 80, tint: 0xffff00, userId: 107 }));
    N.cover = add('cover', new GPU.Graphics().rect(250, 240, 100, 100).fill({ color: 0x0000ff, alpha: 0.5 }));
    const shared = new GPU.GraphicsContext().roundRect(-25, -25, 50, 50, 8).fill(0xff8800);
    N.sharedA = add('sharedA', new GPU.Graphics({ context: shared, pickable: true, userId: 108, x: 470, y: 300 }));
    N.sharedB = add('sharedB', new GPU.Graphics({ context: shared, pickable: true, userId: 109, x: 560, y: 300 }));
    // Rotated square: (420..460) AABB corner is outside the shape.
    N.rot = add('rot', new GPU.Graphics({ pickable: true, userId: 110, x: 400, y: 220 }).rect(-20, -20, 40, 40).fill(0xff00ff));
    N.rot.rotation = Math.PI / 4;
    N.big = add('bigId', new GPU.Graphics({ pickable: true, userId: 0xfffffffe }).circle(600, 420, 15).fill(0xffffff));
    ctx.gfx = { N, labels, bg };
    ctx.pickIds = labels;
    startLoop(ctx, f => {
      for (let i = 0; i < bg.length; i++) bg[i].x = (bg[i].x + 1.5) % 640;
      N.sharedA.rotation = 0; // touched every frame (change detection by value)
    });
    await Promise.all([N.circle.ready, N.star.ready, N.sharedA.ready, bg[0]?.ready]);
    await sleep(500);
    return { ctxId: registerCtx(ctx), ...loopInfo(ctx) };
  }

  async function gfxPick(id, x, y) {
    const ctx = getCtx(id);
    const f0 = ctx.renderer.stats.frameId;
    let hit;
    try {
      hit = await Promise.race([ctx.renderer.pick(x, y), sleep(10000).then(() => 'timeout')]);
    } catch (e) {
      return { error: errText(e) };
    }
    if (hit === 'timeout') return { timeout: true };
    return {
      label: hit ? ctx.gfx.labels.get(hit.node) ?? 'unknown' : null,
      userId: hit ? hit.userId : null,
      instance: hit ? hit.instance : null,
      frames: ctx.renderer.stats.frameId - f0,
    };
  }

  /** Round `k`: the expected table, after applying that round's changes. */
  async function gfxPickRound(id, k) {
    const ctx = getCtx(id);
    const N = ctx.gfx.N;
    const uid = 101 + k * 1000;
    N.circle.userId = uid;
    N.circle.pickable = k % 3 !== 2;
    N.hit.userId = 104 + k;
    await raf();
    await raf();
    const cases = [
      ['circle center', 100, 100, N.circle.pickable ? 'circle' : null, N.circle.pickable ? uid : null],
      ['circle outside corner', 60, 60, null, null],
      ['ring band', 300 + 40, 100, 'ring', 102],
      ['ring hole → rect behind', 300, 100, 'behind', 103],
      ['alpha-0 hit area', 480, 100, 'hit', 104 + k],
      ['star center (mesh)', 100, 300, 'star', 105],
      ['star outside', 155, 355, null, null],
      ['non-pickable Graphics over sprite', 300, 290, 'sprite', 107],
      ['shared context A', 470, 300, 'sharedA', 108],
      ['shared context B', 560, 300, 'sharedB', 109],
      ['rotated square center', 400, 220, 'rot', 110],
      ['rotated square AABB corner', 418, 202, null, null],
      ['u32 userId', 600, 420, 'bigId', 0xfffffffe],
    ];
    const bad = [];
    const frames = [];
    let timeouts = 0;
    const errors = [];
    for (const [name, x, y, want, wantUid] of cases) {
      const r = await gfxPick(id, x, y);
      if (r.timeout) timeouts++;
      if (r.error) errors.push(`${name}: ${r.error}`);
      if (r.frames !== undefined) frames.push(r.frames);
      const ok = r.label === want && (want === null || (r.userId === wantUid && (want === 'sprite' || r.instance === -1)));
      if (!ok) bad.push({ name, at: [x, y], want, wantUid, got: r });
    }
    return { round: k, cases: cases.length, bad, timeouts, errors, maxFrames: frames.length ? Math.max(...frames) : null, ...loopInfo(ctx) };
  }

  // ─── 6. Device loss with Graphics ─────────────────────────────────────────
  async function gfxLossInit({ worker, backend }) {
    phase('gfxLossInit');
    const ctx = await createCtx({ worker, backend, debug: true });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    const probe = probeGraphics();
    stage.addChild(probe);
    const star = new GPU.GraphicsContext().star(0, 0, 5, 14, 7).fill(0x0000ff);
    const stars = [];
    for (let i = 0; i < 200; i++) {
      const g = new GPU.Graphics(star);
      g.x = 360 + (i % 20) * 13;
      g.y = 210 + Math.floor(i / 20) * 9;
      stage.addChild(g);
      stars.push(g);
    }
    const tex = checker();
    const textured = new GPU.Graphics().poly([20, 200, 160, 200, 160, 300, 20, 300]).fill({ texture: tex });
    stage.addChild(textured);
    // Rebuilt every frame (green bars), mesh + SDF mixed.
    const live = new GPU.Graphics();
    stage.addChild(live);
    // Masked group: a blue rect clipped by a mesh polygon to x 180..280.
    const group = new GPU.Group();
    group.addChild(new GPU.Graphics().rect(180, 200, 160, 100).fill(0x0000ff));
    const mask = new GPU.Graphics().poly([180, 190, 230, 190, 280, 190, 280, 310, 180, 310]).fill(0xffffff);
    group.mask = mask;
    stage.addChild(group);
    const pickMe = new GPU.Graphics({ pickable: true, userId: 77 }).circle(80, 90, 50).fill({ color: 0, alpha: 0 });
    stage.addChild(pickMe);
    const labels = new Map([[pickMe, 'pickMe']]);
    ctx.gfx = { labels, live, stars, star, made: [] };
    startLoop(ctx, f => {
      live.clear();
      for (let i = 0; i < 20; i++) live.rect(20 + i * 30, 330 + 20 * Math.sin(f * 0.1 + i), 20, 60).fill(0x00ff00);
      live.moveTo(20, 420).bezierCurveTo(200, 380 + 30 * Math.sin(f * 0.05), 400, 470, 620, 420).stroke({ width: 4, color: 0x00ff00 });
      for (let i = 0; i < stars.length; i++) stars[i].rotation = f * 0.02;
    });
    await Promise.all([probe.ready, stars[0].ready, textured.ready, live.ready, group.ready, pickMe.ready]);
    await sleep(800);
    return {
      ctxId: registerCtx(ctx),
      regions: { ...PROBE_REGIONS, stars: [360, 205, 250, 90], textured: [30, 210, 120, 80], maskIn: [190, 210, 80, 80], maskOut: [290, 210, 40, 80], bars: [20, 350, 600, 30] },
      ...loopInfo(ctx),
    };
  }

  /** After a loss: also create a new Graphics on a fresh context. */
  async function gfxLossAfter(id, k) {
    const ctx = getCtx(id);
    const g = new GPU.Graphics().circle(620, 460, 12).fill(0xffffff);
    ctx.renderer.stage.addChild(g);
    ctx.gfx.made.push(g);
    await g.ready;
    await sleep(300);
    const pick = await gfxPick(id, 80, 90);
    return { k, pick, ...loopInfo(ctx) };
  }

  // ─── 7. Static scene for the allocation check ─────────────────────────────
  // 1000 Graphics × 100 SDF shapes, 50 nodes on one shared mesh context, one
  // textured mesh: nothing changes after the first frame.
  async function gfxStaticInit({ worker, backend, nodes = 1000, per = 100 }) {
    phase('gfxStaticInit');
    const ctx = await createCtx({ worker, backend });
    await GPU.loadGraphics('all');
    const stage = ctx.renderer.stage;
    // Baseline: front CPU of an empty stage on this machine.
    const base = [];
    for (let i = 0; i < 90; i++) {
      ctx.renderer.render();
      if (i >= 30) base.push(ctx.renderer.stats.cpuMs);
      await raf();
    }
    const rand = mulberry(5);
    const list = [];
    for (let b = 0; b < nodes; b++) {
      const g = new GPU.Graphics();
      for (let k = 0; k < per; k++) sdfShape(g, b * per + k, rand() * 40, rand() * 40);
      g.x = (b % 40) * 15;
      g.y = Math.floor(b / 40) * 17;
      stage.addChild(g);
      list.push(g);
    }
    const mesh = new GPU.GraphicsContext().star(0, 0, 6, 16, 8).fill(0x0000ff).stroke({ width: 2, color: 0xffffff });
    for (let i = 0; i < 50; i++) {
      const g = new GPU.Graphics(mesh);
      g.x = 20 + i * 12;
      g.y = 450;
      stage.addChild(g);
      list.push(g);
    }
    const textured = new GPU.Graphics().poly([500, 20, 620, 20, 620, 120, 500, 120]).fill({ texture: checker() });
    stage.addChild(textured);
    await Promise.all([list[0].ready, list[list.length - 1].ready, textured.ready]);
    await settle(ctx, 10);
    startLoop(ctx);
    ctx.gfx = { list };
    return { ctxId: registerCtx(ctx), shapes: nodes * per, emptyStageCpuMs: stat(base), ...loopInfo(ctx) };
  }

  /** Front CPU + packet size over `frames` frames of the (unchanged) scene. */
  async function gfxStaticMeasure(id, frames = 120) {
    const ctx = getCtx(id);
    const cpu = [];
    const packet = [];
    const draws = [];
    const f0 = ctx.renderer.stats.frameId;
    while (ctx.renderer.stats.frameId - f0 < frames) {
      await raf();
      cpu.push(ctx.renderer.stats.cpuMs);
      packet.push(ctx.renderer.stats.packetBytes);
      draws.push(ctx.renderer.stats.drawCalls);
    }
    return { ...loopInfo(ctx), cpuMs: stat(cpu), packetBytes: stat(packet), drawCalls: stat(draws) };
  }

  return {
    gfxSdfInit,
    gfxPathsInit,
    gfxSharedInit,
    gfxSharedStep,
    gfxMaskInit,
    gfxMaskChurn,
    gfxMaskRotate,
    gfxPickInit,
    gfxPickRound,
    gfxLossInit,
    gfxLossAfter,
    gfxStaticInit,
    gfxStaticMeasure,
    gfxInfo: id => loopInfo(getCtx(id)),
    gfxMeter: id => meterSummary(getCtx(id).meter),
  };
}
