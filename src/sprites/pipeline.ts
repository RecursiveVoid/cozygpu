/** Sprite pipeline descriptors. Mirrors layouts.ts §4.1. */
import type { BlendMode, VertexBufferLayout } from '../backend/types';
import {
  SI_A,
  SI_COLOR,
  SI_FLAGS,
  SI_TX,
  SI_U0,
  SPRITE_INSTANCE_BYTES,
} from '../types/layouts';

export const SPRITE_VERTEX_LAYOUT: VertexBufferLayout = {
  stride: SPRITE_INSTANCE_BYTES,
  stepMode: 'instance',
  attributes: [
    { location: 1, format: 'float32x4', offset: SI_A },
    { location: 2, format: 'float32x2', offset: SI_TX },
    { location: 3, format: 'unorm8x4', offset: SI_COLOR },
    { location: 4, format: 'unorm16x4', offset: SI_U0 },
    { location: 5, format: 'uint32', offset: SI_FLAGS },
  ],
};

/** Index = BlendModeId. */
export const SPRITE_BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'add',
  'multiply',
  'screen',
  'none',
];
