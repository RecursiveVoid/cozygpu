// Graphics throughput (ARCHITECTURE §26.9).
//
//   ?mode=nodes    ?count Graphics nodes with one SDF shape each, all moving
//                  (one upload, one draw)
//   ?mode=redraw   one Graphics cleared and redrawn with ?count circles
//                  every frame (no tessellation, no library allocation)
//   ?mode=mesh     ?count nodes sharing one tessellated star, all moving
//                  (one mesh, one instanced draw)
//   ?mode=static   ?count SDF shapes in 100 nodes that never change (nothing
//                  uploaded per frame)
//   ?count=10000
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

export const createPerfScene: SceneFactory = (renderer, params) => {
  const mode = params.get('mode') ?? 'nodes';
  const count = Math.max(1, Number(params.get('count') ?? 10_000) || 10_000);
  const stage = renderer.stage;
  const nodes: GPU.Graphics[] = [];
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const dot = new GPU.GraphicsContext().circle(0, 0, 4).fill(0x38bdf8);
  const star = new GPU.GraphicsContext().star(0, 0, 5, 7, 3).fill(0xfacc15);
  const one = new GPU.Graphics();
  const style = { color: 0xf472b6 };

  if (mode === 'nodes' || mode === 'mesh') {
    for (let i = 0; i < count; i++) {
      const node = new GPU.Graphics(mode === 'mesh' ? star : dot);
      node.setPosition(rnd() * renderer.width, rnd() * renderer.height);
      vx[i] = (rnd() - 0.5) * 200;
      vy[i] = (rnd() - 0.5) * 200;
      stage.addChild(node);
      nodes.push(node);
    }
  } else if (mode === 'static') {
    const per = Math.ceil(count / 100);
    for (let n = 0; n < 100; n++) {
      const node = new GPU.Graphics();
      for (let i = 0; i < per; i++) {
        node
          .rect(rnd() * renderer.width, rnd() * renderer.height, 4, 4)
          .fill(0x64748b);
      }
      stage.addChild(node);
    }
  } else {
    stage.addChild(one);
  }

  const scene: Scene = {
    update(dt, time) {
      const w = renderer.width;
      const h = renderer.height;
      if (mode === 'redraw') {
        one.clear();
        for (let i = 0; i < count; i++) {
          const a = i * 0.618 + time * 0.2;
          one
            .circle(
              w * 0.5 + Math.cos(a) * (i % 400) * 0.001 * w,
              h * 0.5 + Math.sin(a * 1.3) * (i % 300) * 0.0013 * h,
              2,
            )
            .fill(style);
        }
        return;
      }
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        let x = node.x + vx[i] * dt;
        let y = node.y + vy[i] * dt;
        if (x < 0 || x > w) vx[i] = -vx[i];
        if (y < 0 || y > h) vy[i] = -vy[i];
        x = Math.min(Math.max(x, 0), w);
        y = Math.min(Math.max(y, 0), h);
        node.setPosition(x, y);
      }
    },
    hud() {
      const s = renderer.stats;
      return `perf · ${mode} · ${count.toLocaleString()} · front cpu ${s.cpuMs.toFixed(3)} ms`;
    },
  };
  return scene;
};
