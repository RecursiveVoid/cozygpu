/**
 * The M3 effect seam (ARCHITECTURE §21, §22, §25): a Group is a batch
 * boundary with children, and each feature behind the seam arrives as its
 * own chunk.
 */
import { isRenderGroup } from '../types/core';
import { Container } from './Container';
import { Group } from './Group';
import { Text } from '../text/Text';
import { Particles } from '../particles/Particles';
import { filters, defineFilter } from '../filters';
import { fakeFont } from '../text/font.testutil';

describe('Group (M3 effect seam)', () => {
  it('is a container with its own kind and is recognised as a render group', () => {
    const group = new Group();
    expect(group).toBeInstanceOf(Container);
    expect(group.kind).toBe('group');
    expect(isRenderGroup(group)).toBe(true);
    expect(isRenderGroup(new Container())).toBe(false);
    group.destroy();
  });

  it('stores mask and filters without touching the GPU, and clears them', () => {
    const group = new Group();
    const rect = { x: 0, y: 0, width: 10, height: 20 };
    group.mask = rect;
    expect(group.mask).toBe(rect);
    group.mask = null;
    expect(group.mask).toBeNull();
    // An empty chain is the same as no chain.
    group.filters = [];
    expect(group.filters).toBeNull();
    group.destroy();
  });

  it('skips its subtree while the effect chunk has not produced a binding', () => {
    const group = new Group();
    group.mask = { x: 0, y: 0, width: 1, height: 1 };
    const world = new Float32Array(6);
    expect(group._emitGroupBegin(null as never, world, 0, 1)).toBe(false);
    group.destroy();
  });

  it('a group without effects draws normally', () => {
    const group = new Group();
    const world = new Float32Array(6);
    expect(group._emitGroupBegin(null as never, world, 0, 1)).toBe(true);
    group._emitGroupEnd(null as never);
    group.destroy();
  });

  it('the mask chunk loads and produces a binding', async () => {
    const group = new Group();
    group.mask = { x: 0, y: 0, width: 1, height: 1 };
    await expect(group.ready).resolves.toBeUndefined();
    expect(group._maskBinding).not.toBeNull();
    group.destroy();
  });

  it('the filter chunk loads and produces a binding', async () => {
    const group = new Group();
    group.filters = [filters.blur()];
    await expect(group.ready).resolves.toBeUndefined();
    expect(group._filterBinding).not.toBeNull();
    group.destroy();
  });
});

describe('M3 features are implemented behind the seam', () => {
  it('filters and defineFilter', () => {
    expect(filters.blur().name).toBe('blur');
    expect(filters.colorMatrix().cheap).toBe(true);
    // A definition with no shader for either language is rejected up front.
    expect(() => defineFilter({ name: 'x', params: {}, defaults: {} })).toThrow(
      /INVALID_ARGUMENT/,
    );
  });

  it('Particles is a swarm node', () => {
    const fx = new Particles({ capacity: 10 });
    expect(fx.kind).toBe('swarm');
    expect(fx.swarm).toBe(fx);
    fx.destroy();
  });

  it('Text constructs, is a container, and lays out its first string', async () => {
    const text = new Text('hi', { font: fakeFont() });
    expect(text.kind).toBe('container');
    expect(text.text).toBe('hi');
    expect(text.metrics.glyphs).toBe(0);
    await expect(text.ready).resolves.toBeUndefined();
    expect(text.metrics.glyphs).toBe(2);
    text.destroy();
  });
});
