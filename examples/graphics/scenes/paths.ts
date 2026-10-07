// Paths (ARCHITECTURE §26.4): everything the analytic path cannot draw is
// tessellated once into a mesh in context space and cached.
//
//   row 1   quadratic and cubic curves, arcTo corners, a closed path whose
//           stroke sits inside (alignment 1)
//   row 2   polylines with miter / bevel / round joins and caps, a star, a
//           regular polygon and a rect with two holes (cut)
//   row 3   a texture fill (local mapping) and a live line chart that is
//           cleared and re-tessellated every frame
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

const CHART_POINTS = 120;

function checkerPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 2) + (y >> 2)) & 1;
      px[i] = on ? 250 : 40;
      px[i + 1] = on ? 200 : 60;
      px[i + 2] = on ? 80 : 120;
      px[i + 3] = 255;
    }
  }
  return px;
}

export const createPathsScene: SceneFactory = renderer => {
  const stage = renderer.stage;
  const g = new GPU.Graphics({ x: 40, y: 60 });
  stage.addChild(g);

  g.moveTo(0, 60)
    .quadraticCurveTo(60, -20, 120, 60)
    .stroke({ width: 6, color: 0x38bdf8, cap: 'round' });
  g.moveTo(150, 60)
    .bezierCurveTo(170, -30, 260, 130, 290, 20)
    .stroke({ width: 4, color: 0xf472b6, join: 'round', cap: 'round' });
  g.moveTo(320, 70)
    .arcTo(320, 0, 400, 0, 24)
    .arcTo(480, 0, 480, 70, 24)
    .lineTo(480, 70)
    .stroke({ width: 5, color: 0xfacc15 });
  g.moveTo(520, 0)
    .lineTo(640, 0)
    .quadraticCurveTo(660, 40, 640, 80)
    .lineTo(520, 80)
    .closePath()
    .fill(0x1e293b)
    .stroke({ width: 8, color: 0x22c55e, alignment: 1 });

  const joins = ['miter', 'bevel', 'round'] as const;
  const caps = ['butt', 'square', 'round'] as const;
  for (let i = 0; i < 3; i++) {
    const x = i * 110;
    g.poly([x, 190, x + 30, 120, x + 60, 190, x + 90, 120], false).stroke({
      width: 12,
      color: 0xe2e8f0,
      join: joins[i],
      cap: caps[i],
      alpha: 0.85,
    });
  }
  g.star(390, 155, 5, 42, 18)
    .fill(0xfde047)
    .stroke({ width: 3, color: 0xb45309, join: 'round' });
  g.regularPoly(490, 155, 38, 6, Math.PI / 6)
    .fill({ color: 0x0ea5e9, alpha: 0.7 })
    .stroke({ width: 2, color: 0xffffff });
  g.rect(550, 115, 100, 80)
    .fill(0xf43f5e)
    .stroke({ width: 2, color: 0xffffff })
    .circle(580, 155, 18)
    .cut()
    .roundRect(608, 135, 30, 40, 6)
    .cut();

  const checker = GPU.Texture.fromPixels(16, 16, checkerPixels(16));
  const textured = new GPU.Graphics({ x: 40, y: 300 });
  textured
    .moveTo(0, 40)
    .bezierCurveTo(40, -30, 120, -30, 160, 40)
    .lineTo(140, 110)
    .lineTo(20, 110)
    .closePath()
    .fill({ texture: checker })
    .stroke({ width: 2, color: 0xffffff });
  stage.addChild(textured);

  // A line chart, rebuilt every frame from a ring of samples.
  const chart = new GPU.Graphics({ x: 250, y: 300 });
  stage.addChild(chart);
  const frame = new GPU.Graphics({ x: 250, y: 300 });
  frame.rect(0, 0, 400, 120).stroke({ width: 1, color: 0x475569 });
  stage.addChild(frame);
  const samples = new Float64Array(CHART_POINTS);
  const line = { width: 2, color: 0x38bdf8, join: 'round' as const };
  const area = { color: 0x38bdf8, alpha: 0.2 };
  let head = 0;
  let acc = 0;

  const scene: Scene = {
    update(dt, time) {
      acc += dt;
      if (acc > 1 / 30) {
        acc = 0;
        samples[head] =
          0.5 + 0.3 * Math.sin(time * 1.7) + 0.15 * Math.sin(time * 5.3);
        head = (head + 1) % CHART_POINTS;
      }
      chart.clear();
      const step = 400 / (CHART_POINTS - 1);
      chart.moveTo(0, 120);
      for (let i = 0; i < CHART_POINTS; i++) {
        chart.lineTo(i * step, 120 - samples[(head + i) % CHART_POINTS] * 120);
      }
      chart.lineTo(400, 120).closePath().fill(area);
      chart.moveTo(0, 120 - samples[head] * 120);
      for (let i = 1; i < CHART_POINTS; i++) {
        chart.lineTo(i * step, 120 - samples[(head + i) % CHART_POINTS] * 120);
      }
      chart.stroke(line);
      textured.rotation = Math.sin(time) * 0.05;
    },
    hud() {
      const info = g.context.info;
      return (
        `paths: ${info.meshVertices} vertices · ${info.meshTriangles} triangles` +
        ` · chart ${chart.context.info.meshTriangles} triangles / frame`
      );
    },
  };
  return scene;
};
