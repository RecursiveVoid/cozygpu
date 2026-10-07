// Size fixture (scripts/size.mjs): a Graphics program on WebGPU, with every
// chunk a vector scene loads (emitter, tessellation, core, WGSL).
import * as GPU from 'cozygpu';

export async function main(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = await GPU.createRenderer({ canvas, backend: 'webgpu' });
  await GPU.loadGraphics();
  const g = new GPU.Graphics();
  g.roundRect(10, 10, 100, 60, 8)
    .fill(0x38bdf8)
    .stroke({ width: 2, color: 0xffffff });
  g.star(200, 60, 5, 40, 18).fill(0xfacc15);
  renderer.stage.addChild(g);
  renderer.render();
}
