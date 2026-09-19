// Minimal Pixi v8 program: application + one textured sprite.
import { Application, Sprite, Texture } from 'pixi.js';

export async function main(canvas: HTMLCanvasElement): Promise<void> {
  const app = new Application();
  await app.init({ canvas });
  const s = new Sprite(Texture.WHITE);
  s.position.set(10, 10);
  app.stage.addChild(s);
  app.render();
}
