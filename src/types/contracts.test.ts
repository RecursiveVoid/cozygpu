/**
 * Tester (logic, round 1): cross-owner id tables agree with each other and
 * with the normative tables in docs/ARCHITECTURE.md §3.4 (opcodes, command
 * flags, format ids, texture flags, blend ids, READBACK srcKind).
 */
import { BlendModeId } from '../backend/types';
import {
  CommandFlag,
  FilterOp,
  MaskOp,
  Op,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
import { GfxOp } from '../commands/gfxOpcodes';
import { SPRITE_BLEND_MODES } from '../sprites/pipeline';
import { BLEND_MODES, SwarmReadbackKind } from '../swarm/constants';

// Node built-ins without @types/node (tsconfig types: webgpu + jest only).
declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
declare const __dirname: string;

const doc = require('fs').readFileSync(
  `${__dirname}/../../docs/ARCHITECTURE.md`,
  'utf8',
);

describe('ARCHITECTURE §3.4 opcode table ↔ src/commands/opcodes.ts', () => {
  const rows = [
    ...doc.matchAll(
      // Tolerates Prettier's column padding in the Markdown table.
      /^\|\s*(0x[0-9A-Fa-f]{4})\s*\|\s*([A-Z_0-9]+)\s*\|\s*([A-Z_+]*)\s*\|/gm,
    ),
  ].map(m => ({ code: parseInt(m[1], 16), name: m[2], flags: m[3] }));

  it('lists every opcode exactly once with the same value', () => {
    // M3: masks and filters keep their own tables so an unused one is
    // tree-shaken (ARCHITECTURE §21.6); the doc table lists them together.
    // M4: graphics likewise (§26).
    const all = { ...Op, ...MaskOp, ...FilterOp, ...GfxOp };
    expect(rows.length).toBe(Object.keys(all).length);
    const table = all as Record<string, number>;
    for (const row of rows)
      expect([row.name, table[row.name]]).toEqual([row.name, row.code]);
    expect(new Set(Object.values(all)).size).toBe(rows.length);
  });

  it('DRAW / COMPUTE / PASS_BREAK flag columns match the command kinds', () => {
    const withFlag = (flag: string) =>
      rows
        .filter(r => r.flags.split('+').includes(flag))
        .map(r => r.name)
        .sort();
    expect(withFlag('DRAW')).toEqual([
      'FILTER_BEGIN',
      'FILTER_END',
      'GFX_DRAW_MESH',
      'GFX_DRAW_SHAPES',
      'MASK_GEOMETRY_END',
      'MASK_POP',
      'MASK_PUSH_ALPHA',
      'MASK_PUSH_SCISSOR',
      'MASK_PUSH_STENCIL',
      'SPRITE_DRAW',
      'SPRITE_SET_EFFECT',
      'SWARM_DRAW',
    ]);
    expect(withFlag('COMPUTE')).toEqual([
      'SWARM_KILL_LIST',
      'SWARM_KILL_RANGE',
      'SWARM_SPAWN',
      'SWARM_STEP',
    ]);
    // M3: every PASS_BREAK command is also a DRAW command (§21.3).
    const breaks = withFlag('PASS_BREAK');
    expect(breaks).toEqual([
      'FILTER_BEGIN',
      'FILTER_END',
      'MASK_GEOMETRY_END',
      'MASK_POP',
      'MASK_PUSH_ALPHA',
      'MASK_PUSH_STENCIL',
    ]);
    for (const name of breaks) expect(withFlag('DRAW')).toContain(name);
    expect(CommandFlag).toEqual({ DRAW: 1, COMPUTE: 2, PASS_BREAK: 4 });
  });

  it('format ids, texture flags and blend ids match the prose', () => {
    const formats = Object.fromEntries(
      [...doc.matchAll(/`([a-z0-9-]+)`=(\d+)/g)]
        .filter(m => m[1] in TextureFormatId || m[1] in BlendModeId)
        .map(m => [m[1], Number(m[2])]),
    );
    for (const [name, id] of Object.entries(TextureFormatId)) {
      expect([name, formats[name]]).toEqual([name, id]);
    }
    const flags = Object.fromEntries(
      [...doc.matchAll(/`([A-Z_]+)`=(\d+)/g)].map(m => [m[1], Number(m[2])]),
    );
    for (const [name, bit] of Object.entries(TextureFlag)) {
      expect([name, flags[name]]).toEqual([name, bit]);
    }
    const blends = Object.fromEntries(
      [...doc.matchAll(/\b(normal|add|multiply|screen|none)=(\d)/g)].map(m => [
        m[1],
        Number(m[2]),
      ]),
    );
    expect(blends).toEqual(BlendModeId);
  });
});

describe('blend mode tables', () => {
  it('sprite and swarm pipelines index blend modes by BlendModeId', () => {
    const byId = Object.entries(BlendModeId)
      .sort((a, b) => a[1] - b[1])
      .map(e => e[0]);
    expect(SPRITE_BLEND_MODES).toEqual(byId);
    expect(BLEND_MODES).toEqual(byId);
  });
});

describe('READBACK srcKind', () => {
  it('swarm kinds are 1 (hot) and 2 (cold); 0 is the sprite buffer', () => {
    expect(doc).toMatch(/srcKind \(0 sprite buf, 1 swarm hot, 2 swarm cold\)/);
    expect(SwarmReadbackKind).toEqual({ HOT: 1, COLD: 2 });
  });
});
