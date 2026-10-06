/**
 * The Text node (ARCHITECTURE §23.2): glyph children, chunk loading, the
 * synchronous re-layout once the chunks are cached, metrics and destroy.
 */
import { Text } from './Text';
import { fakeFont } from './font.testutil';
import type { FontAsset } from './types';

let font: FontAsset;

beforeEach(() => {
  font = fakeFont();
});

describe('Text', () => {
  it('has no glyphs until the layout chunk has loaded, then one per glyph', async () => {
    const text = new Text('abc', { font });
    const label = new Text('abc', { font });
    expect(label.kind).toBe('container');
    await text.ready;
    expect(text.children).toHaveLength(3);
    expect(text.metrics.glyphs).toBe(3);
    expect(text.metrics.lines).toBe(1);
  });

  it('re-lays out synchronously once the chunks are cached', async () => {
    const text = new Text('Score: 0', { font });
    await text.ready;
    const before = text.children[0];
    text.text = 'Score: 1';
    // No await: the modules are cached, so the layout already ran.
    expect(text.metrics.glyphs).toBe(7);
    expect(text.children[0]).toBe(before);
  });

  it('ignores a write of the same string', async () => {
    const text = new Text('abc', { font });
    await text.ready;
    const first = text.children[0];
    text.text = 'abc';
    expect(text.children[0]).toBe(first);
  });

  it('re-lays out on setStyle and keeps the rest of the style', async () => {
    const text = new Text('ab', { font, size: 10 });
    await text.ready;
    const width = text.metrics.width;
    text.setStyle({ size: 20 });
    expect(text.style.font).toBe(font);
    expect(text.metrics.width).toBe(width * 2);
  });

  it('accepts the options form', async () => {
    const text = new Text({ text: 'ab', style: { font }, x: 5, label: 'hud' });
    await text.ready;
    expect(text.x).toBe(5);
    expect(text.label).toBe('hud');
    expect(text.children).toHaveLength(2);
  });

  it('drops its glyph children on destroy', async () => {
    const text = new Text('abc', { font });
    await text.ready;
    const glyph = text.children[0];
    text.destroy();
    expect(text.destroyed).toBe(true);
    expect(glyph.destroyed).toBe(true);
  });

  it('keeps the last write when the string changes while loading', async () => {
    const text = new Text('a', { font });
    text.text = 'abcd';
    await text.ready;
    expect(text.text).toBe('abcd');
    expect(text.children).toHaveLength(4);
  });
});
