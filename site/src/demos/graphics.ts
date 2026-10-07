// Graphics: thousands of analytic shapes plus vector paths.
//
// Behind everything, one Graphics node is cleared and redrawn every frame
// with the slider's count of circles, rings, rounded rects, arcs and line
// segments: each is one 64-byte SDF instance, nothing is tessellated and
// the redraw allocates nothing. In front, a dashboard: gauges (SDF arcs), a
// live chart (a path re-tessellated every frame) and three vector emblems
// (curves, holes) tessellated once and only re-transformed.
// Full example: examples/graphics/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const SAMPLES = 160;
const CARDS = 3;
const COLORS = [0x38bdf8, 0xf472b6, 0xfacc15, 0x34d399, 0xa78bfa];
const PAD = 20;

/** Shape kinds of the field, cycled by index. */
const KINDS = 5;

function emblems(): GPU.GraphicsContext[] {
  // A flower of quadratic petals around a hole.
  const flower = new GPU.GraphicsContext();
  const petals = 8;
  flower.moveTo(0, -46);
  for (let i = 0; i < petals; i++) {
    const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / petals;
    const a1 = a0 + (2 * Math.PI) / petals;
    const am = (a0 + a1) / 2;
    flower.quadraticCurveTo(
      Math.cos(am) * 78,
      Math.sin(am) * 78,
      Math.cos(a1) * 46,
      Math.sin(a1) * 46,
    );
  }
  flower
    .closePath()
    .fill(0xf472b6)
    .stroke({ width: 3, color: 0xfdf2f8, join: 'round' })
    .circle(0, 0, 14)
    .cut();

  // A star with a round window, round joins.
  const star = new GPU.GraphicsContext()
    .star(0, 0, 6, 52, 26)
    .fill(0xfacc15)
    .stroke({ width: 4, color: 0x422006, join: 'round' })
    .circle(0, 0, 12)
    .cut();

  // A heart from two cubic curves.
  const heart = new GPU.GraphicsContext()
    .moveTo(0, -18)
    .bezierCurveTo(-28, -58, -80, -14, 0, 48)
    .bezierCurveTo(80, -14, 28, -58, 0, -18)
    .closePath()
    .fill(0x34d399)
    .stroke({ width: 3, color: 0xecfdf5, join: 'round' });
  return [flower, star, heart];
}

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const renderer = await GPU.createRenderer({
    canvas: ctx.canvas,
    background: 0x0b1020,
    backend: ctx.backend,
    worker: workerOption(ctx),
    antialias: true,
  });
  await GPU.loadGraphics();
  const stage = renderer.stage;

  // ── The field: N shapes, redrawn every frame ──────────────────────────────
  const field = new GPU.Graphics();
  stage.addChild(field);
  let count = 0;
  let seeds = new Float32Array(0);
  const setCount = (n: number): void => {
    count = n;
    if (seeds.length < n * 4) {
      const next = new Float32Array(n * 4);
      next.set(seeds);
      for (let i = seeds.length; i < next.length; i++) next[i] = Math.random();
      seeds = next;
    }
  };
  setCount(ctx.count);
  // Styles are plain objects reused every frame: no allocation per shape.
  const fill = { color: 0, alpha: 0.6 };
  const line = { width: 1.5, color: 0, alpha: 0.7, cap: 'round' as const };

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const panels = new GPU.Graphics();
  stage.addChild(panels);
  const gauges = new GPU.Graphics();
  stage.addChild(gauges);
  const chart = new GPU.Graphics();
  stage.addChild(chart);
  const shapes = emblems();
  const marks: GPU.Graphics[] = [];
  for (let i = 0; i < CARDS; i++) {
    const node = new GPU.Graphics(shapes[i]);
    stage.addChild(node);
    marks.push(node);
  }

  const series = [new Float64Array(SAMPLES), new Float64Array(SAMPLES)];
  const sample = (k: number, t: number): number =>
    k === 0
      ? 0.55 + 0.25 * Math.sin(t * 1.3) + 0.12 * Math.sin(t * 4.1)
      : 0.35 + 0.2 * Math.cos(t * 0.9) + 0.1 * Math.sin(t * 6.7);
  // Start with a full chart: the samples of the last few seconds.
  for (let i = 0; i < SAMPLES; i++) {
    series[0][i] = sample(0, (i - SAMPLES) / 30);
    series[1][i] = sample(1, (i - SAMPLES) / 30);
  }
  let head = 0;
  let acc = 0;
  let width = 0;
  let height = 0;
  let cardW = 0;
  let cardTop = PAD;
  let cardH = 150;
  let emblemScale = 1;
  const track = { width: 10, color: 0x1e293b };
  const arcStyle = { width: 10, color: 0, cap: 'round' as const };
  const lineStyle = { width: 2.5, color: 0, join: 'round' as const };
  const areaStyle = { color: 0, alpha: 0.2 };

  const layout = (): void => {
    width = renderer.width;
    height = renderer.height;
    cardW = (width - PAD * (CARDS + 1)) / CARDS;
    // Narrow stages: shorter cards below the page's HUD line.
    const narrow = width < 560;
    cardTop = narrow ? 64 : PAD;
    cardH = narrow ? 100 : 150;
    emblemScale = Math.min(1, cardW / 300, cardH / 150);
    panels.clear();
    for (let i = 0; i < CARDS; i++) {
      panels
        .roundRect(PAD + i * (cardW + PAD), cardTop, cardW, cardH, 14)
        .fill({ color: 0x0f172a, alpha: 0.93 })
        .stroke({ width: 1, color: 0x334155 });
      marks[i].setPosition(
        PAD + i * (cardW + PAD) + cardW * 0.27,
        cardTop + cardH / 2,
      );
      marks[i].setScale(emblemScale);
    }
    const top = cardTop + cardH + PAD;
    panels
      .roundRect(PAD, top, width - 2 * PAD, height - top - PAD, 14)
      .fill({ color: 0x0f172a, alpha: 0.93 })
      .stroke({ width: 1, color: 0x334155 });
    for (let k = 1; k < 5; k++) {
      const y = top + ((height - top - PAD) * k) / 5;
      panels
        .moveTo(PAD + 12, y)
        .lineTo(width - PAD - 12, y)
        .stroke({ width: 1, color: 0x1f2937, pixelLine: true });
    }
  };
  layout();

  const ticker = GPU.ticker(renderer);
  ticker.add((dt, time) => {
    ctx.tick();
    if (renderer.width !== width || renderer.height !== height) layout();

    // Field: every shape orbits its own centre; kinds cycle by index.
    field.clear();
    const s = seeds;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const r = 20 + s[o + 2] * 60;
      const a = time * (0.3 + s[o + 3]) * (i & 1 ? 1 : -1) + s[o + 2] * 40;
      const x = s[o] * width + Math.cos(a) * r;
      const y = s[o + 1] * height + Math.sin(a) * r;
      const size = 2 + s[o + 3] * 4;
      const color = COLORS[i % COLORS.length];
      switch (i % KINDS) {
        case 0:
          fill.color = color;
          field.circle(x, y, size).fill(fill);
          break;
        case 1:
          line.color = color;
          field.circle(x, y, size + 1).stroke(line);
          break;
        case 2:
          fill.color = color;
          field
            .roundRect(x - size, y - size * 0.7, size * 2, size * 1.4, 2)
            .fill(fill);
          break;
        case 3:
          line.color = color;
          field.arc(x, y, size + 2, a, a + 3.5).stroke(line);
          break;
        default:
          line.color = color;
          field
            .moveTo(x - Math.cos(a) * size, y - Math.sin(a) * size)
            .lineTo(x + Math.cos(a) * size, y + Math.sin(a) * size)
            .stroke(line);
      }
    }

    // Gauges: a track and a value arc per card.
    gauges.clear();
    for (let i = 0; i < CARDS; i++) {
      const cx = PAD + i * (cardW + PAD) + cardW * 0.7;
      const cy = cardTop + cardH / 2 + 6;
      const radius = Math.min(48, cardW * 0.2, cardH * 0.32);
      const v = 0.5 + 0.45 * Math.sin(time * (0.6 + i * 0.37) + i * 2);
      const a0 = Math.PI * 0.75;
      gauges.arc(cx, cy, radius, a0, a0 + Math.PI * 1.5).stroke(track);
      arcStyle.color = COLORS[i];
      gauges.arc(cx, cy, radius, a0, a0 + Math.PI * 1.5 * v).stroke(arcStyle);
      gauges.circle(cx, cy, radius * (0.15 + 0.2 * v)).fill(COLORS[i]);
    }
    // Emblems: tessellated once, only their transforms change.
    for (let i = 0; i < CARDS; i++) {
      marks[i].rotation = Math.sin(time * 0.8 + i) * 0.5;
      marks[i].setScale(emblemScale * (1 + 0.06 * Math.sin(time * 2 + i)));
    }

    // Chart: two series sampled 30 times a second, re-tessellated per frame.
    acc += dt;
    if (acc > 1 / 30) {
      acc = 0;
      series[0][head] = sample(0, time);
      series[1][head] = sample(1, time);
      head = (head + 1) % SAMPLES;
    }
    chart.clear();
    const top = cardTop + cardH + PAD;
    const x0 = PAD + 12;
    const w = width - 2 * PAD - 24;
    const h = height - top - PAD - 24;
    if (h > 20) {
      const y0 = top + 12 + h;
      const step = w / (SAMPLES - 1);
      for (let k = 0; k < 2; k++) {
        const data = series[k];
        chart.moveTo(x0, y0);
        for (let i = 0; i < SAMPLES; i++) {
          chart.lineTo(x0 + i * step, y0 - data[(head + i) % SAMPLES] * h);
        }
        areaStyle.color = COLORS[k];
        chart
          .lineTo(x0 + w, y0)
          .closePath()
          .fill(areaStyle);
        chart.moveTo(x0, y0 - data[head] * h);
        for (let i = 1; i < SAMPLES; i++) {
          chart.lineTo(x0 + i * step, y0 - data[(head + i) % SAMPLES] * h);
        }
        lineStyle.color = COLORS[k];
        chart.stroke(lineStyle);
      }
    }
  });

  return {
    renderer,
    ticker,
    objects: () => count + CARDS * 3 + CARDS + 2,
    setCount,
    destroy: () => teardown(ticker, renderer),
  };
}
