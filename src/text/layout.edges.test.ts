/**
 * Text layout, the cases the main suite leaves out (ARCHITECTURE §23.4):
 * tabs, CRLF and blank lines, `maxLines` without an ellipsis, a wrap that
 * falls on a run of spaces, astral code points, trailing whitespace in the
 * measured width, and the shaping buffers across a shrink and a regrow.
 */
import { Container } from '../scene/Container';
import type { Sprite } from '../scene/Sprite';
import { layoutText } from './layout';
import type { TextLayoutHost } from './layout';
import {
  FAKE_ADVANCE,
  FAKE_ASCENDER,
  FAKE_DESCENDER,
  FAKE_LINE_HEIGHT,
  fakeFont,
  fakeSource,
} from './font.testutil';
import type { FontAsset, TextStyle } from './types';

function host(text: string, style: TextStyle): TextLayoutHost {
  const node = new Container();
  const extended = node as unknown as TextLayoutHost;
  extended._text = text;
  extended._style = style;
  extended._glyphs = [];
  extended._buffers = null;
  return extended;
}

const xs = (node: TextLayoutHost): number[] =>
  node._glyphs.map((s: Sprite) => s.x);
const ys = (node: TextLayoutHost): number[] =>
  node._glyphs.map((s: Sprite) => s.y);

let font: FontAsset;

beforeEach(() => {
  font = fakeFont();
});

describe('whitespace and hard breaks', () => {
  it('advances a tab by four space widths', () => {
    const node = host('a\tb', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(2);
    expect(xs(node)).toEqual([0, FAKE_ADVANCE * 5]);
    expect(metrics.width).toBe(FAKE_ADVANCE * 6);
  });

  it('treats CRLF as one break and emits no quad for the CR', () => {
    const node = host('a\r\nb', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(metrics.glyphs).toBe(2);
    expect(ys(node)).toEqual([0, FAKE_LINE_HEIGHT]);
    expect(metrics.width).toBe(FAKE_ADVANCE);
  });

  it('keeps an empty line between two breaks', () => {
    const node = host('a\n\nb', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(3);
    expect(ys(node)).toEqual([0, 2 * FAKE_LINE_HEIGHT]);
    expect(metrics.height).toBe(
      2 * FAKE_LINE_HEIGHT + (FAKE_ASCENDER - FAKE_DESCENDER),
    );
  });

  it('leaves trailing whitespace out of the measured width', () => {
    const node = host('ab   ', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.width).toBe(2 * FAKE_ADVANCE);
    expect(metrics.glyphs).toBe(2);
  });

  it('right-aligns against the widest line when there is no maxWidth', () => {
    const node = host('a\nbbb', { font, align: 'right' });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.width).toBe(3 * FAKE_ADVANCE);
    expect(xs(node)[0]).toBe(2 * FAKE_ADVANCE);
    expect(xs(node).slice(1)).toEqual([0, FAKE_ADVANCE, 2 * FAKE_ADVANCE]);
  });
});

describe('wrapping', () => {
  it('swallows a whole run of spaces at a soft break', () => {
    const node = host('aa  bb', { font, maxWidth: 3 * FAKE_ADVANCE });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(xs(node)).toEqual([0, FAKE_ADVANCE, 0, FAKE_ADVANCE]);
    expect(ys(node)).toEqual([0, 0, FAKE_LINE_HEIGHT, FAKE_LINE_HEIGHT]);
  });

  it('breaks mid-word when the first word of a line does not fit', () => {
    const node = host('aaaa', { font, maxWidth: 2 * FAKE_ADVANCE });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(ys(node)).toEqual([0, 0, FAKE_LINE_HEIGHT, FAKE_LINE_HEIGHT]);
  });

  it('drops the overflow at maxLines with no ellipsis asked for', () => {
    const node = host('aa bb cc', {
      font,
      maxWidth: 2 * FAKE_ADVANCE,
      maxLines: 2,
    });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(metrics.glyphs).toBe(4);
    expect(metrics.height).toBe(
      FAKE_LINE_HEIGHT + (FAKE_ASCENDER - FAKE_DESCENDER),
    );
  });

  it('does not stretch a hard-broken line under align: justify', () => {
    const node = host('a b\nc d', {
      font,
      maxWidth: 20 * FAKE_ADVANCE,
      align: 'justify',
    });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    // Both lines keep their natural pen positions.
    expect(xs(node)).toEqual([0, 2 * FAKE_ADVANCE, 0, 2 * FAKE_ADVANCE]);
  });

  it('ignores maxWidth entirely with wrap: none', () => {
    const node = host('aaaaaa', { font, maxWidth: FAKE_ADVANCE, wrap: 'none' });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(1);
    expect(metrics.glyphs).toBe(6);
  });
});

describe('code points and buffers', () => {
  it('counts an astral code point as one glyph', () => {
    const node = host('a\u{1F600}b', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(3);
    expect(xs(node)).toEqual([0, FAKE_ADVANCE, 2 * FAKE_ADVANCE]);
  });

  it('reuses the shaping buffers across a shrink and a regrow', () => {
    const node = host('abcdefghij', { font });
    layoutText(node, fakeSource(font));
    const buffers = node._buffers;
    expect(buffers).not.toBeNull();
    node._text = 'ab';
    expect(layoutText(node, fakeSource(font)).glyphs).toBe(2);
    expect(node._glyphs).toHaveLength(2);
    node._text = 'abcdefghij';
    expect(layoutText(node, fakeSource(font)).glyphs).toBe(10);
    expect(node._buffers).toBe(buffers);
    expect(xs(node)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => i * 6));
  });

  it('drops every glyph for an empty string and reports zero metrics', () => {
    const node = host('abc', { font });
    layoutText(node, fakeSource(font));
    node._text = '';
    const metrics = layoutText(node, fakeSource(font));
    expect(node._glyphs).toHaveLength(0);
    expect(metrics).toEqual({
      width: 0,
      height: 0,
      lines: 0,
      firstBaseline: 0,
      glyphs: 0,
    });
  });

  it('reports one line for a string that is only whitespace', () => {
    const node = host('   ', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(0);
    expect(metrics.lines).toBe(1);
    expect(metrics.width).toBe(0);
  });
});
