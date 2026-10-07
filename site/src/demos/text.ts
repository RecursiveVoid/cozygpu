// Text: MSDF glyphs loaded through the asset loader, word wrapping that
// follows the canvas width, a counter rewritten every frame, and the Canvas2D
// path for an installed system font. Every glyph is an ordinary sprite
// instance. Full example: examples/text/main.ts.
import * as GPU from 'cozygpu';
import type { DemoContext, DemoHandle } from './types';
import { teardown, workerOption } from './types';

const PARAGRAPH =
  'Text is a Container of glyph sprites, so every glyph is an ordinary ' +
  'sprite instance and batches with the sprites around it. Signed distance ' +
  'fields keep the edges sharp at any scale, and layout runs on the main ' +
  'thread in both renderer modes without touching the DOM.';

export async function start(ctx: DemoContext): Promise<DemoHandle> {
  const { canvas } = ctx;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x101420,
    backend: ctx.backend,
    worker: workerOption(ctx),
    assets: { baseUrl: ctx.assetBase },
  });
  const handle = await renderer.assets.load<GPU.FontAsset>({
    url: 'cozy.json',
    kind: 'font',
  });
  const font = handle.value;
  const world = new GPU.Container();
  renderer.stage.addChild(world);

  const headline = new GPU.Text('cozygpu', { font, size: 64, fill: 0xffd479 });
  headline.setPosition(28, 52);
  world.addChild(headline);

  const width = (): number => Math.max(200, renderer.width - 56);
  const paragraph = new GPU.Text(PARAGRAPH, {
    font,
    size: 17,
    fill: 0xc8d4f0,
    maxWidth: width(),
    wrap: 'word',
    align: 'justify',
    lineHeight: 1.15,
  });
  paragraph.setPosition(28, 136);
  world.addChild(paragraph);

  const counter = new GPU.Text('frame 0', { font, size: 22, fill: 0x9fd7ff });
  world.addChild(counter);

  const system = new GPU.Text('system font fallback: monospace 0123', {
    font: { family: 'monospace', atlasSize: 64 },
    size: 18,
    fill: 0xffffff,
  });
  world.addChild(system);

  // A ring of large glyphs, rotated as one node.
  const ring = new GPU.Container();
  const letters = 'WEBGPU*WEBGL2*';
  const glyphs: GPU.Text[] = [];
  for (let i = 0; i < letters.length; i++) {
    const g = new GPU.Text(letters[i], { font, size: 30, fill: 0xff8fc8 });
    ring.addChild(g);
    glyphs.push(g);
  }
  world.addChild(ring);
  await Promise.all([headline.ready, paragraph.ready, system.ready]);

  let lastW = -1;
  const layout = (): void => {
    lastW = renderer.width;
    paragraph.setStyle({ maxWidth: width() });
    const bottom = 136 + paragraph.metrics.height;
    counter.setPosition(28, bottom + 24);
    system.setPosition(28, bottom + 62);
    const r = Math.min(110, Math.max(60, renderer.height * 0.16));
    ring.setPosition(
      Math.max(renderer.width - r - 40, 300),
      Math.max(renderer.height - r - 30, bottom + r + 100),
    );
    for (let i = 0; i < glyphs.length; i++) {
      const a = (i / glyphs.length) * Math.PI * 2;
      glyphs[i].setPosition(Math.cos(a) * r - 10, Math.sin(a) * r - 16);
    }
  };
  layout();

  let frames = 0;
  const ticker = GPU.ticker(renderer);
  ticker.add((dt, time) => {
    ctx.tick();
    frames++;
    counter.text = `frame ${frames}`;
    headline.rotation = Math.sin(time) * 0.02;
    ring.rotation += dt * 0.4;
    if (renderer.width !== lastW) layout();
  });

  const glyphCount = (): number => {
    let n =
      headline.metrics.glyphs +
      paragraph.metrics.glyphs +
      counter.metrics.glyphs +
      system.metrics.glyphs;
    for (let i = 0; i < glyphs.length; i++) n += glyphs[i].metrics.glyphs;
    return n;
  };

  return {
    renderer,
    ticker,
    objects: glyphCount,
    destroy: () => teardown(ticker, renderer),
  };
}
