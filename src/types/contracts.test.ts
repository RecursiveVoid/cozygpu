/**
 * Tester (logic, round 1): cross-owner id tables agree with each other and
 * with the normative tables in docs/ARCHITECTURE.md §3.4 (opcodes, command
 * flags, format ids, texture flags, blend ids, READBACK srcKind).
 */
import { BlendModeId } from '../backend/types';
import {
  CommandFlag,
  Op,
  TextureFlag,
  TextureFormatId,
} from '../commands/opcodes';
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
      /^\|\s*(0x[0-9A-Fa-f]{4})\s*\|\s*([A-Z_0-9]+)\s*\|\s*([A-Z]*)\s*\|/gm,
    ),
  ].map(m => ({ code: parseInt(m[1], 16), name: m[2], flags: m[3] }));

  it('lists every opcode exactly once with the same value', () => {
    expect(rows.length).toBe(Object.keys(Op).length);
    const table = Op as Record<string, number>;
    for (const row of rows)
      expect([row.name, table[row.name]]).toEqual([row.name, row.code]);
    expect(new Set(Object.values(Op)).size).toBe(rows.length);
  });

  it('DRAW / COMPUTE flag columns match the command kinds', () => {
    const draw = rows
      .filter(r => r.flags === 'DRAW')
      .map(r => r.name)
      .sort();
    const compute = rows
      .filter(r => r.flags === 'COMPUTE')
      .map(r => r.name)
      .sort();
    expect(draw).toEqual(['SPRITE_DRAW', 'SWARM_DRAW']);
    expect(compute).toEqual([
      'SWARM_KILL_LIST',
      'SWARM_KILL_RANGE',
      'SWARM_SPAWN',
      'SWARM_STEP',
    ]);
    expect(CommandFlag).toEqual({ DRAW: 1, COMPUTE: 2 });
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
