// SDF shapes (ARCHITECTURE §26.3): every primitive the analytic path draws,
// one 64-byte instance each, nothing tessellated.
//
//   row 1   rects: miter / bevel / round joins, stroke inside / centred /
//           outside (alignment 1, 0.5, 0)
//   row 2   rounded rects, circles, an ellipse, fill-only and stroke-only
//   row 3   line segments with butt / round / square caps, arcs, a 1 px
//           pixelLine grid that stays 1 device px at any zoom
//   right   a node redrawn every frame (clear + roundRect with a pulsing
//           radius: no allocation, no tessellation), a spinning arc and a
//           zooming node that stays crisp
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

export const createShapesScene: SceneFactory = renderer => {
  const stage = renderer.stage;
  const g = new GPU.Graphics({ x: 40, y: 70 });
  stage.addChild(g);

  const joins = ['miter', 'bevel', 'round'] as const;
  for (let i = 0; i < 3; i++) {
    g.rect(i * 100, 0, 70, 50)
      .fill(0x1e293b)
      .stroke({ width: 10, color: 0x38bdf8, join: joins[i] });
  }
  const aligns = [1, 0.5, 0];
  for (let i = 0; i < 3; i++) {
    g.rect(320 + i * 100, 0, 70, 50)
      .fill(0x334155)
      .stroke({ width: 8, color: 0xf472b6, alignment: aligns[i], alpha: 0.8 });
  }

  g.roundRect(0, 90, 90, 60, 18)
    .fill(0xf43f5e)
    .stroke({ width: 3, color: 0xffffff });
  g.roundRect(110, 90, 90, 60, 30).fill({ color: 0x22c55e, alpha: 0.6 });
  g.circle(255, 120, 30).fill(0xfacc15).stroke({ width: 5, color: 0x0f172a });
  g.circle(335, 120, 30).stroke({ width: 3, color: 0xa78bfa });
  g.ellipse(440, 120, 55, 25)
    .fill(0x0ea5e9)
    .stroke({ width: 2, color: 0xe0f2fe });
  g.ellipse(560, 120, 20, 32).fill({ color: 0xfb923c, alpha: 0.5 });

  const caps = ['butt', 'round', 'square'] as const;
  for (let i = 0; i < 3; i++) {
    g.moveTo(10, 190 + i * 26)
      .lineTo(170, 190 + i * 26)
      .stroke({ width: 12, color: 0xe2e8f0, cap: caps[i] });
  }
  g.moveTo(200, 180).lineTo(260, 250).stroke({ width: 4, color: 0x94a3b8 });
  g.arc(320, 220, 32, 0, Math.PI * 1.3).stroke({ width: 8, color: 0xa78bfa });
  g.arc(410, 220, 32, -Math.PI / 2, Math.PI * 0.75).stroke({
    width: 8,
    color: 0xfb923c,
    cap: 'round',
  });
  for (let x = 470; x <= 640; x += 17) {
    g.moveTo(x, 180)
      .lineTo(x, 260)
      .stroke({ width: 1, color: 0x64748b, pixelLine: true });
  }

  // Redrawn every frame.
  const pulse = new GPU.Graphics({ x: 760, y: 110 });
  stage.addChild(pulse);
  const spinner = new GPU.Graphics({ x: 760, y: 260 });
  spinner
    .arc(0, 0, 40, 0, Math.PI * 1.5)
    .stroke({ width: 10, color: 0x38bdf8, cap: 'round' });
  stage.addChild(spinner);
  const zoom = new GPU.Graphics({ x: 330, y: 420 });
  zoom
    .roundRect(-40, -25, 80, 50, 10)
    .fill(0x1d4ed8)
    .stroke({ width: 2, color: 0xffffff });
  zoom.circle(0, 0, 12).fill(0xfacc15);
  stage.addChild(zoom);

  const scene: Scene = {
    update(_dt, time) {
      const r = 6 + 34 * (0.5 + 0.5 * Math.sin(time * 2));
      pulse
        .clear()
        .roundRect(-60, -40, 120, 80, r)
        .fill(0x7c3aed)
        .stroke({ width: 4, color: 0xede9fe });
      spinner.rotation = time * 4;
      zoom.setScale(1 + 2 * (0.5 + 0.5 * Math.sin(time * 0.7)));
      zoom.rotation = Math.sin(time * 0.5) * 0.4;
    },
    hud() {
      return (
        `sdf shapes ${g.context.info.sdfShapes} in one node · ` +
        `mesh vertices ${g.context.info.meshVertices}`
      );
    },
  };
  return scene;
};
