// Shared contexts (ARCHITECTURE §26.6): a GraphicsContext is recorded once
// and drawn by any number of nodes. Its mesh is uploaded once per renderer;
// each node adds a 32-byte record, and consecutive nodes are one draw.
//
//   ?count=600   nodes (default 600), half of them on an SDF icon context,
//                half on a mesh (star) context, all moving
// Every 2 s both contexts are re-recorded: every node follows.
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

export const createSharingScene: SceneFactory = (renderer, params) => {
  const count = Math.max(2, Number(params.get('count') ?? 600) || 600);
  const icon = new GPU.GraphicsContext();
  const star = new GPU.GraphicsContext();
  let variant = -1;
  const record = (v: number): void => {
    icon.clear();
    star.clear();
    if (v % 2 === 0) {
      icon.circle(0, 0, 9).fill(0x38bdf8).stroke({ width: 2, color: 0xffffff });
      star.star(0, 0, 5, 12, 5).fill(0xfacc15);
    } else {
      icon.roundRect(-9, -9, 18, 18, 4).fill(0xf472b6);
      star
        .regularPoly(0, 0, 11, 6)
        .fill(0x22c55e)
        .stroke({ width: 2, color: 0x14532d, join: 'round' });
    }
  };

  const nodes: GPU.Graphics[] = [];
  for (let i = 0; i < count; i++) {
    const node = new GPU.Graphics(i < count / 2 ? icon : star);
    node.tint = i % 3 === 0 ? 0xffffff : i % 3 === 1 ? 0xffd0d0 : 0xd0e0ff;
    renderer.stage.addChild(node);
    nodes.push(node);
  }

  const scene: Scene = {
    update(_dt, time) {
      const v = Math.floor(time / 2);
      if (v !== variant) {
        variant = v;
        record(v);
      }
      const w = renderer.width;
      const h = renderer.height;
      for (let i = 0; i < count; i++) {
        const k = i / count;
        const node = nodes[i];
        node.setPosition(
          w * (0.5 + 0.42 * Math.sin(time * 0.3 + k * 37.1)),
          h * (0.55 + 0.38 * Math.cos(time * 0.23 + k * 91.7)),
        );
        node.rotation = time + i;
      }
    },
    hud() {
      return (
        `${count} nodes on 2 shared contexts · icon ${icon.info.sdfShapes} sdf · ` +
        `star ${star.info.meshVertices} vertices (uploaded once)`
      );
    },
  };
  return scene;
};
