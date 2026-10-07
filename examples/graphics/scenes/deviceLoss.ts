// Device loss, worker mode and picking with Graphics (ARCHITECTURE §26.7,
// §26.8). Everything the graphics core holds lives on the GPU only, so a
// lost device takes all of it: after `deviceRestored` the front re-sends
// every buffer and mesh on its own, and this scene does nothing about it.
//
//   top      one Graphics with every SDF kind: rects (miter, bevel, round
//            joins), a rounded rect, circles, an ellipse, segments with
//            butt / round / square caps, arcs, a 1 px pixelLine grid
//   middle   60 nodes sharing one star context (one mesh, one draw)
//   bottom   a texture fill (mesh path, textured) and a pickable disc
//
// ?lose=1 loses the device (WebGL2: the context) after ~1 s. The pick at the
// disc's centre runs before and after, and lands in the status object.
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

type Debuggable = { _debug(action: 'loseDevice'): void };

const STARS = 60;

export const createDeviceLossScene: SceneFactory = (
  renderer,
  params,
  status,
) => {
  const stage = renderer.stage;

  const shapes = new GPU.Graphics({ x: 40, y: 80 });
  shapes
    .rect(0, 0, 70, 50)
    .fill(0x1e293b)
    .stroke({ width: 8, color: 0x38bdf8 });
  shapes
    .rect(100, 0, 70, 50)
    .fill(0x1e293b)
    .stroke({ width: 8, color: 0x38bdf8, join: 'bevel' });
  shapes
    .rect(200, 0, 70, 50)
    .fill(0x1e293b)
    .stroke({ width: 8, color: 0x38bdf8, join: 'round' });
  shapes
    .roundRect(300, 0, 70, 50, 14)
    .fill(0xf43f5e)
    .stroke({ width: 3, color: 0xffffff });
  shapes
    .circle(435, 25, 25)
    .fill(0xfacc15)
    .stroke({ width: 4, color: 0x0f172a });
  shapes.ellipse(530, 25, 45, 20).fill({ color: 0x22c55e, alpha: 0.7 });
  const caps = ['butt', 'round', 'square'] as const;
  for (let i = 0; i < caps.length; i++) {
    shapes
      .moveTo(10, 90 + i * 22)
      .lineTo(150, 90 + i * 22)
      .stroke({ width: 10, color: 0xe2e8f0, cap: caps[i] });
  }
  shapes
    .arc(230, 115, 32, 0, Math.PI * 1.25)
    .stroke({ width: 8, color: 0xa78bfa });
  shapes
    .arc(330, 115, 32, -Math.PI / 2, Math.PI * 0.75)
    .stroke({ width: 8, color: 0xfb923c, cap: 'round' });
  for (let x = 420; x <= 580; x += 20) {
    shapes
      .moveTo(x, 80)
      .lineTo(x, 150)
      .stroke({ width: 1, color: 0x64748b, pixelLine: true });
  }
  stage.addChild(shapes);

  // One star context, drawn by every node: one mesh upload, one draw.
  const star = new GPU.GraphicsContext()
    .star(0, 0, 5, 14, 6)
    .fill(0xfde047)
    .stroke({ width: 2, color: 0xb45309, join: 'round' });
  const stars: GPU.Graphics[] = [];
  for (let i = 0; i < STARS; i++) {
    const node = new GPU.Graphics(star);
    stage.addChild(node);
    stars.push(node);
  }

  const checker = GPU.Texture.fromPixels(16, 16, checkerPixels(16));
  const textured = new GPU.Graphics({ x: 40, y: 370 });
  textured
    .poly([0, 0, 140, 0, 160, 70, 20, 90])
    .fill({ texture: checker })
    .stroke({ width: 2, color: 0xffffff });
  stage.addChild(textured);

  const disc = new GPU.Graphics({ x: 300, y: 410, pickable: true });
  disc.circle(0, 0, 36).fill(0x0ea5e9).stroke({ width: 4, color: 0xffffff });
  disc.userId = 42;
  stage.addChild(disc);

  const picks: string[] = [];
  status.picks = picks;
  const pick = (): void => {
    renderer.pick(disc.x, disc.y).then(
      hit => {
        picks.push(
          hit
            ? `${hit.node === disc ? 'disc' : hit.node.kind}:${hit.userId}`
            : 'miss',
        );
      },
      (err: unknown) => picks.push(`error ${String(err)}`),
    );
  };

  let frames = 0;
  let lostAt = -1;
  if (params.get('lose') === '1') {
    setTimeout(() => {
      lostAt = frames;
      (renderer as unknown as Debuggable)._debug('loseDevice');
    }, 1000);
  }

  const scene: Scene = {
    update(_dt, time) {
      frames++;
      const w = renderer.width;
      for (let i = 0; i < STARS; i++) {
        const a = (i / STARS) * Math.PI * 2 + time * 0.3;
        const node = stars[i];
        node.setPosition(w * 0.5 + Math.cos(a) * 220, 300 + Math.sin(a) * 40);
        node.rotation = time + i;
      }
      textured.rotation = Math.sin(time) * 0.05;
      // Picks before the loss and once the restore had time to re-upload.
      if (frames === 30 || (lostAt >= 0 && frames === lostAt + 90)) pick();
      status.lostAt = lostAt;
    },
    hud() {
      return (
        `stars ${STARS} (shared context) · picks ${picks.join(', ') || '-'}` +
        (status.deviceRestored ? ` · restored ${status.deviceRestored}×` : '')
      );
    },
  };
  return scene;
};

function checkerPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 2) + (y >> 2)) & 1;
      px[i] = on ? 236 : 99;
      px[i + 1] = on ? 72 : 102;
      px[i + 2] = on ? 153 : 241;
      px[i + 3] = 255;
    }
  }
  return px;
}
