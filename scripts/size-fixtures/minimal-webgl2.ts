// Size fixture (scripts/size.mjs): the minimal program on WebGL2.
import * as GPU from 'cozygpu';

export async function main(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = await GPU.createRenderer({ canvas, backend: 'webgl2' });
  const texture = GPU.Texture.fromPixels(
    1,
    1,
    new Uint8Array([255, 255, 255, 255]),
  );
  renderer.stage.addChild(new GPU.Sprite({ texture, x: 10, y: 10 }));
  renderer.render();
}
