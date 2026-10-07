// Graphics as mask sources (ARCHITECTURE §26.8). Three panels, each a Group
// whose subtree (orbiting sprites over Graphics rings) is clipped by a
// Graphics that is not in the scene tree:
//
//   left    a plain filled rect          → scissor (no draw, no target)
//   middle  a turning rounded rect (SDF) → stencil on WebGL2, alpha on WebGPU
//   right   a turning star (mesh path)   → same, from tessellated triangles
//
// An outline Graphics (a 1 px `pixelLine` stroke of the same shape) shows
// where each mask is. Flags: ?invert=1 inverts the three masks (the rect
// then leaves the scissor path), ?mode=auto|scissor|stencil|alpha forces one.
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

const PANELS = 3;
/** Mask shapes are drawn at this size and scaled to the panel. */
const UNIT = 100;

type GroupInternals = GPU.Group & { _maskBinding: { mode: string } | null };

/** Draws panel `i`'s mask shape into `g` (fill) or as a 1 px outline. */
function drawShape(g: GPU.Graphics, i: number, outline: boolean): void {
  const h = UNIT / 2;
  if (i === 0) g.rect(-h, -h, UNIT, UNIT);
  else if (i === 1) g.roundRect(-h, -h * 0.7, UNIT, UNIT * 0.7, 18);
  else g.star(0, 0, 5, h, h * 0.45);
  if (outline) g.stroke({ width: 1, color: 0xf8fafc, pixelLine: true });
  else g.fill(0xffffff);
}

export const createMaskScene: SceneFactory = (renderer, params, status) => {
  const modeParam = params.get('mode');
  const forced =
    modeParam === 'scissor' || modeParam === 'stencil' || modeParam === 'alpha'
      ? modeParam
      : 'auto';
  const invert = params.get('invert') === '1';
  const checker = GPU.Texture.fromPixels(32, 32, checkerPixels(32));

  const groups: GroupInternals[] = [];
  const masks: GPU.Graphics[] = [];
  const outlines: GPU.Graphics[] = [];
  const rings: GPU.Graphics[] = [];
  const tiles: GPU.Sprite[] = [];
  for (let i = 0; i < PANELS; i++) {
    const group = new GPU.Group();
    renderer.stage.addChild(group);
    groups.push(group as unknown as GroupInternals);
    // Graphics content: rings and spokes, all SDF shapes.
    const ring = new GPU.Graphics();
    for (let r = 12, n = 0; r <= 150; r += 14, n++) {
      ring
        .circle(0, 0, r)
        .stroke({ width: 5, color: n % 2 ? 0x38bdf8 : 0xf472b6 });
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ring
        .moveTo(Math.cos(a) * 20, Math.sin(a) * 20)
        .lineTo(Math.cos(a) * 150, Math.sin(a) * 150)
        .stroke({ width: 3, color: 0xfacc15, cap: 'round' });
    }
    group.addChild(ring);
    rings.push(ring);
    // Sprite content between the Graphics: the sprite batch is split.
    for (let k = 0; k < 10; k++) {
      const tile = new GPU.Sprite({ texture: checker, anchor: 0.5 });
      tile.width = 24;
      tile.height = 24;
      group.addChild(tile);
      tiles.push(tile);
    }
    const mask = new GPU.Graphics();
    drawShape(mask, i, false);
    masks.push(mask);
    const outline = new GPU.Graphics();
    drawShape(outline, i, true);
    renderer.stage.addChild(outline);
    outlines.push(outline);
    group.mask = { source: mask, mode: forced, invert };
  }

  const place = (time: number): void => {
    const w = renderer.width;
    const h = renderer.height;
    const panel = w / PANELS;
    const size = Math.min(panel, h) * 0.62;
    const scale = size / UNIT;
    for (let i = 0; i < PANELS; i++) {
      const cx = panel * (i + 0.5);
      const cy = h / 2;
      const rotation = i === 0 ? 0 : time * (i === 1 ? 0.5 : -0.3);
      for (let k = 0; k < 2; k++) {
        const g = k === 0 ? masks[i] : outlines[i];
        g.setPosition(cx, cy);
        g.scaleX = g.scaleY = scale;
        g.rotation = rotation;
      }
      rings[i].setPosition(cx, cy);
      rings[i].rotation = time * 0.2;
      for (let k = 0; k < 10; k++) {
        const a = time * 0.8 + (k / 10) * Math.PI * 2;
        const tile = tiles[i * 10 + k];
        tile.setPosition(
          cx + Math.cos(a) * size * 0.45,
          cy + Math.sin(a * 1.3) * size * 0.45,
        );
        tile.rotation = a;
      }
    }
  };
  place(0);

  const scene: Scene = {
    update(_dt, time) {
      place(time);
      status.modes = groups.map(g => g._maskBinding?.mode ?? 'pending');
    },
    hud() {
      const modes = (status.modes as string[] | undefined) ?? [];
      return (
        `rect → ${modes[0]}   rounded rect → ${modes[1]}   star → ${modes[2]}` +
        (invert ? ' · inverted' : '')
      );
    },
  };
  return scene;
};

/** Opaque checkerboard, premultiplied. */
function checkerPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 3) + (y >> 3)) & 1;
      px[i] = on ? 245 : 90;
      px[i + 1] = on ? 245 : 90;
      px[i + 2] = on ? 245 : 120;
      px[i + 3] = 255;
    }
  }
  return px;
}
