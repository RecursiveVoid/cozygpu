// Minimal cozygpu program: renderer + one textured sprite.
import * as GPU from 'cozygpu';

export async function main(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = await GPU.createRenderer({ canvas });
  const texture = GPU.Texture.fromPixels(
    1,
    1,
    new Uint8Array([255, 255, 255, 255]),
  );
  renderer.stage.addChild(new GPU.Sprite({ texture, x: 10, y: 10 }));
  renderer.render();
}
