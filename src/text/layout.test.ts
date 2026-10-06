/**
 * Text layout: line breaking, alignment, baseline, spacing, kerning,
 * maxLines / ellipsis, and the compare-then-write pass that makes a changed
 * tail rewrite only the sprites it changed (ARCHITECTURE §23.4).
 */
import { Container } from '../scene/Container';
import type { Sprite } from '../scene/Sprite';
import { Dirty, nodeStore } from '../scene/store';
import { SpriteInstanceFlag } from '../types/layouts';
import { layoutText } from './layout';
import type { TextLayoutHost } from './layout';
import {
  FAKE_ADVANCE,
  FAKE_ASCENDER,
  FAKE_DESCENDER,
  FAKE_LINE_HEIGHT,
  FAKE_SIZE,
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

function glyphs(node: TextLayoutHost): Sprite[] {
  return node._glyphs;
}

function positions(node: TextLayoutHost): number[][] {
  return glyphs(node).map(s => [s.x, s.y]);
}

let font: FontAsset;

beforeEach(() => {
  font = fakeFont();
});

describe('layoutText', () => {
  it('lays a single line out along the baseline', () => {
    const node = host('abc', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(3);
    expect(metrics.lines).toBe(1);
    expect(metrics.width).toBe(3 * FAKE_ADVANCE);
    expect(metrics.height).toBe(FAKE_ASCENDER - FAKE_DESCENDER);
    expect(metrics.firstBaseline).toBe(FAKE_ASCENDER);
    // offsetY is -ascender, so every quad sits at the top of the line.
    expect(positions(node)).toEqual([
      [0, 0],
      [FAKE_ADVANCE, 0],
      [2 * FAKE_ADVANCE, 0],
    ]);
  });

  it('scales metrics with style.size', () => {
    const node = host('ab', { font, size: FAKE_SIZE * 2 });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.width).toBe(2 * FAKE_ADVANCE * 2);
    expect(metrics.height).toBe((FAKE_ASCENDER - FAKE_DESCENDER) * 2);
    expect(glyphs(node)[1].x).toBe(FAKE_ADVANCE * 2);
    // A 6×10 frame drawn at twice the font size covers 12×20 px.
    expect(glyphs(node)[0].scaleX).toBe(2);
    expect(glyphs(node)[0].scaleY).toBe(2);
  });

  it('emits no quad for whitespace but keeps its advance', () => {
    const node = host('a b', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(2);
    expect(glyphs(node)[1].x).toBe(2 * FAKE_ADVANCE);
  });

  it('breaks hard at \\n', () => {
    const node = host('ab\ncd', { font });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(metrics.height).toBe(
      FAKE_LINE_HEIGHT + FAKE_ASCENDER - FAKE_DESCENDER,
    );
    expect(glyphs(node)[2].y).toBe(FAKE_LINE_HEIGHT);
  });

  it('wraps on words and drops the break space', () => {
    // maxWidth fits two glyphs, so "aa bb" becomes two lines.
    const node = host('aa bb', { font, maxWidth: 2 * FAKE_ADVANCE });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(metrics.glyphs).toBe(4);
    expect(positions(node)).toEqual([
      [0, 0],
      [FAKE_ADVANCE, 0],
      [0, FAKE_LINE_HEIGHT],
      [FAKE_ADVANCE, FAKE_LINE_HEIGHT],
    ]);
  });

  it('wraps mid-word with wrap: char and never with wrap: none', () => {
    const chars = host('abcd', {
      font,
      maxWidth: 2 * FAKE_ADVANCE,
      wrap: 'char',
    });
    expect(layoutText(chars, fakeSource(font)).lines).toBe(2);

    const none = host('abcd', {
      font,
      maxWidth: 2 * FAKE_ADVANCE,
      wrap: 'none',
    });
    const metrics = layoutText(none, fakeSource(font));
    expect(metrics.lines).toBe(1);
    expect(metrics.width).toBe(4 * FAKE_ADVANCE);
  });

  it('aligns centre and right against maxWidth', () => {
    const style: TextStyle = { font, maxWidth: 10 * FAKE_ADVANCE };
    const centre = host('ab', { ...style, align: 'center' });
    layoutText(centre, fakeSource(font));
    expect(glyphs(centre)[0].x).toBe(
      (10 * FAKE_ADVANCE - 2 * FAKE_ADVANCE) / 2,
    );

    const right = host('ab', { ...style, align: 'right' });
    layoutText(right, fakeSource(font));
    expect(glyphs(right)[0].x).toBe(10 * FAKE_ADVANCE - 2 * FAKE_ADVANCE);
  });

  it('justifies wrapped lines only', () => {
    // "aa bb cc" wraps after "bb"; the first line stretches, the last does not.
    const node = host('aa bb cc', {
      font,
      maxWidth: 6 * FAKE_ADVANCE,
      align: 'justify',
    });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    // Line 1 holds "aa bb" (5 advances) in 6, so its one space stretches by 1.
    expect(glyphs(node)[2].x).toBe(4 * FAKE_ADVANCE);
    // The last line keeps its natural position.
    expect(glyphs(node)[4].x).toBe(0);
  });

  it('places the baseline for each baseline mode', () => {
    const height = FAKE_ASCENDER - FAKE_DESCENDER;
    const top = host('a', { font, baseline: 'top' });
    expect(layoutText(top, fakeSource(font)).firstBaseline).toBe(FAKE_ASCENDER);
    const middle = host('a', { font, baseline: 'middle' });
    expect(layoutText(middle, fakeSource(font)).firstBaseline).toBe(
      FAKE_ASCENDER - height / 2,
    );
    const bottom = host('a', { font, baseline: 'bottom' });
    expect(layoutText(bottom, fakeSource(font)).firstBaseline).toBe(
      FAKE_ASCENDER - height,
    );
    const alphabetic = host('a', { font, baseline: 'alphabetic' });
    expect(layoutText(alphabetic, fakeSource(font)).firstBaseline).toBe(0);
  });

  it('adds letter and word spacing', () => {
    const node = host('a b', { font, letterSpacing: 2, wordSpacing: 5 });
    layoutText(node, fakeSource(font));
    // pen: a (6 + 2) + space (6 + 2 + 5) = 21
    expect(glyphs(node)[1].x).toBe(21);
  });

  it('does not count letterSpacing after the last glyph of a line', () => {
    // Three glyphs, two gaps: 3 * 6 + 2 * 3 = 24, not 3 * (6 + 3) = 27.
    const node = host('abc', { font, letterSpacing: 3 });
    expect(layoutText(node, fakeSource(font)).width).toBe(
      3 * FAKE_ADVANCE + 2 * 3,
    );
    // Per line, not once for the block.
    const two = host('ab\nabc', { font, letterSpacing: 3 });
    const metrics = layoutText(two, fakeSource(font));
    expect(metrics.lines).toBe(2);
    expect(metrics.width).toBe(3 * FAKE_ADVANCE + 2 * 3);
    // A right-aligned line is placed from its own (uninflated) width.
    const right = host('ab\nabc', {
      font,
      letterSpacing: 3,
      align: 'right',
      maxWidth: 100,
    });
    layoutText(right, fakeSource(font));
    expect(glyphs(right)[0].x).toBe(100 - (2 * FAKE_ADVANCE + 3));
  });

  it('applies kerning between pairs', () => {
    const kerned = fakeFont(new Map([['97,98', -2]]));
    const node = host('ab', { font: kerned });
    const metrics = layoutText(node, fakeSource(kerned));
    expect(glyphs(node)[1].x).toBe(FAKE_ADVANCE - 2);
    expect(metrics.width).toBe(2 * FAKE_ADVANCE - 2);
  });

  it('stops at maxLines and appends an ellipsis', () => {
    const node = host('aa bb cc', {
      font,
      maxWidth: 2 * FAKE_ADVANCE,
      maxLines: 2,
      ellipsis: true,
    });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(2);
    // Line 2 is "bb"; one glyph makes room for the ellipsis.
    const last = glyphs(node)[metrics.glyphs - 1];
    expect(last.y).toBe(FAKE_LINE_HEIGHT);
    expect(last.x).toBe(FAKE_ADVANCE);
    // Line 2 is "b" plus the ellipsis glyph.
    expect(metrics.glyphs).toBe(4);
  });

  it('rounds positions with pixelSnap', () => {
    const node = host('ab', { font, size: 11, pixelSnap: true });
    layoutText(node, fakeSource(font));
    const x = glyphs(node)[1].x;
    expect(x).toBe(Math.round(x));
  });

  it('writes the source instance flags without clobbering the pick id', () => {
    const node = host('a', { font });
    layoutText(node, fakeSource(font, SpriteInstanceFlag.MSDF));
    const sprite = glyphs(node)[0];
    const word = nodeStore.flags[sprite._slot];
    expect(word & 0xff).toBe(SpriteInstanceFlag.MSDF);
    expect(word >>> 8).toBe(sprite.id);
  });

  it('rewrites only the glyphs that changed', () => {
    const node = host('Score: 19', { font });
    layoutText(node, fakeSource(font));
    const before = glyphs(node).slice();
    const kept = before.slice(0, before.length - 1);
    const keptX = kept.map(s => s.x);
    // Clear the dirty bits the first layout set, then change the last digit.
    for (const sprite of before) nodeStore.dirty[sprite._slot] = 0;
    node._text = 'Score: 18';
    layoutText(node, fakeSource(font));

    expect(glyphs(node)).toHaveLength(before.length);
    // Same sprite objects, same positions, untouched dirty bits.
    for (let i = 0; i < kept.length; i++) {
      expect(glyphs(node)[i]).toBe(kept[i]);
      expect(glyphs(node)[i].x).toBe(keptX[i]);
      expect(nodeStore.dirty[kept[i]._slot] & Dirty.SPRITE).toBe(0);
    }
    const changed = glyphs(node)[before.length - 1];
    expect(nodeStore.dirty[changed._slot] & Dirty.SPRITE).not.toBe(0);
  });

  it('grows and shrinks the glyph list at the tail only', () => {
    const node = host('abc', { font });
    layoutText(node, fakeSource(font));
    const first = glyphs(node)[0];
    node._text = 'abcde';
    layoutText(node, fakeSource(font));
    expect(node.children).toHaveLength(5);
    expect(glyphs(node)[0]).toBe(first);
    node._text = 'a';
    layoutText(node, fakeSource(font));
    expect(node.children).toHaveLength(1);
    expect(glyphs(node)[0]).toBe(first);
  });

  it('is empty for an empty string', () => {
    const node = host('abc', { font });
    layoutText(node, fakeSource(font));
    node._text = '';
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.glyphs).toBe(0);
    expect(metrics.lines).toBe(0);
    expect(node.children).toHaveLength(0);
  });

  it('never stalls on a glyph wider than maxWidth', () => {
    const node = host('abcd', { font, maxWidth: 1, wrap: 'char' });
    const metrics = layoutText(node, fakeSource(font));
    expect(metrics.lines).toBe(4);
    expect(metrics.glyphs).toBe(4);
  });

  it('tints every glyph from style.fill', () => {
    const node = host('ab', { font, fill: '#ff8800' });
    layoutText(node, fakeSource(font));
    expect(glyphs(node)[0].tint).toBe(0xff8800);
    expect(glyphs(node)[1].tint).toBe(0xff8800);
  });
});
