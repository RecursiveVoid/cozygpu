# cozygpu architecture

Status: **M2 contract** (M1 is built; M2 contracts are frozen, features are
stubs). Sections marked _normative_ are binding for every developer; code
in `src/types/**`, `src/backend/types.ts`, `src/scene/types.ts`,
`src/swarm/types.ts`, `src/assets/types.ts`, `src/commands/opcodes.ts`,
and `src/commands/types.ts` mirrors them. If the code and this document
disagree, stop and report it. Do not guess.

- [1. Goals and non-goals](#1-goals-and-non-goals)
- [2. Layers and threads](#2-layers-and-threads)
- [3. Command stream (normative)](#3-command-stream-normative)
- [4. Memory layouts (normative)](#4-memory-layouts-normative)
- [5. Sprites: scene graph to GPU](#5-sprites-scene-graph-to-gpu)
- [6. Swarm: GPU simulation](#6-swarm-gpu-simulation)
- [7. Backend (RHI)](#7-backend-rhi)
- [8. Worker mode](#8-worker-mode)
- [9. Device loss, resize, DPR](#9-device-loss-resize-dpr)
- [10. Performance budgets](#10-performance-budgets)
- [11. Source layout and ownership (M2)](#11-source-layout-and-ownership-m2)
- [12. M2 overview](#12-m2-overview)
- [13. WebGL2 backend (M2)](#13-webgl2-backend-m2)
- [14. Swarm in M2: WebGL2 and GPU free lists](#14-swarm-in-m2-webgl2-and-gpu-free-lists)
- [15. Asset loader (M2)](#15-asset-loader-m2)
- [16. Sprites in M2: bulk API, incremental structure, picking](#16-sprites-in-m2-bulk-api-incremental-structure-picking)
- [17. Worker command ring (M2)](#17-worker-command-ring-m2)
- [18. Bundle and build (M2)](#18-bundle-and-build-m2)
- [19. Later milestones (design notes only)](#19-later-milestones-design-notes-only)

---

## 1. Goals and non-goals

**Goals:** a small, fast 2D graphics library. It is WebGPU first, with a
WebGL2 fallback (M2) whose ceiling may be lower. Import it with
`import * as GPU from 'cozygpu'`.

- Tier 1 is a Pixi-like CPU scene graph (`Container`, `Sprite`). Nodes
  are handles into typed-array stores, and each frame uploads only the
  dirty ranges.
- Tier 2 is **Swarm**, which handles millions of objects. Their state
  lives only in GPU buffers. Compute shaders (WebGPU) or transform
  feedback (WebGL2) simulate them, and a vertex shader draws them straight
  from those buffers. The CPU sends only small commands.
- The same public API works on the main thread and in a worker
  (OffscreenCanvas).
- The library has no runtime dependencies, allocates nothing per frame in
  steady state, and exposes no WebGPU or WebGL types.
- Texture data lives in GPU memory only, unless the caller explicitly asks
  for a CPU copy (`keepPixels`, `hitMask`, `RETAIN_SOURCE`).

**Non-goals:** ECS, game loop policy, input and event dispatch, audio,
physics. These belong to the future cozyJS suite. The `ticker` is an
optional convenience; `renderer.pick()` answers "what is at this pixel",
it does not dispatch events.

## 2. Layers and threads

```
 PUBLIC / FRONT  (always main thread)                 CORE  (main thread OR worker)
 ───────────────────────────────────────              ─────────────────────────────────────
 createRenderer() → Renderer (src/renderer)            RenderCore (src/renderer/RenderCore.ts)
   stage: Container ─┐                                   ├─ core state: view uniform, TextureRegistry,
   Sprite / Swarm    │ render():                         │  shared-memory table, picking (ops 0x00, 0x01)
   Texture           │  1. control cmds, frame hooks     ├─ SpriteCoreSystem      (ops 0x02)
   renderer.assets ──┤     (assets), PICK requests       ├─ SwarmCoreSystem       (ops 0x03, lazy)
   ticker()          │  2. ScenePacker.pack(stage)       └─ Backend (RHI) ── import('webgpu') | import('webgl2')
                     │  3. Swarm._emitDraw(frame)
                     ▼
            CommandEncoder ──FramePacket──► Transport ──► CommandDecoder ──► systems
                               (src/commands)   local: direct call
                                                worker: SAB command ring (M2) | postMessage(transfer)
```

- **Front** (public objects) never touches GPU objects. It encodes
  intent into a binary `FramePacket`.
- **Core** owns the backend and every GPU resource. It decodes packets
  and executes them. The same core code runs on the main thread (via
  `LocalTransport`) and in the worker (`src/worker/entry.ts`).
- `CoreSystem` (`src/types/core.ts`) is the plug-in point. RenderCore
  routes each command by the opcode's high byte.
- **Assets** (M2) load and parse on the front and hand decoded
  ImageBitmaps and compressed level buffers to the core by transfer (§15).

### Frame lifecycle (normative)

Front, inside `renderer.render()`:

1. If `transport.busy`, skip the frame and return. `stats.skippedFrames++`,
   and dt keeps accumulating.
2. `encoder.reset(transport.takeRecycledBuffer())`, then `FRAME_BEGIN(time, dt)`.
3. Queued control commands: `RESIZE`, `SET_CLEAR_COLOR` (only on change),
   `SET_VIEW`, and pending READBACKs.
4. M2: every `FrontFrameHook.encodeFrame(frame)` (assets: atlas region
   uploads, mip regeneration, evictions, reloads), then
   `PickClient.encode(frame)` (queued PICK commands).
5. `flushSwarmDestroys(frame)`: SWARM_DESTROY for swarms destroyed since
   the last frame, even when no Swarm remains in the tree
   (`src/swarm/destroyQueue.ts`).
6. `scenePacker.pack(stage, frame)`, which walks the tree in draw order:
   - It updates dirty world transforms.
   - It packs sprite instances and emits `TEXTURE_*` on first use,
     `SPRITE_UPLOAD[_SHARED]` for dirty ranges, and one `SPRITE_DRAW` per
     batch.
   - At a `CustomDrawable` (a Swarm), it flushes the open batch and calls
     `node._emitDraw(frame, world, o, worldAlpha)`. The swarm appends its
     queued commands, then `SWARM_STEP` and `SWARM_DRAW`.
7. `FRAME_END`, `encoder.finish(frameId)`, then
   `transport.submit(packet, encoder.transferList)`.

Core, per packet:

1. Decode sequentially. Commands flagged `DRAW` are not executed now;
   their offsets go into a reused `Uint32Array`. Every other command goes
   to its system's `execute()` (0x00 and 0x01 are handled by RenderCore).
   Commands flagged `COMPUTE` are queued by their system. PICK requests
   are queued by the core picking module.
2. **Compute phase**: `system.compute(list)` in registration order. Each
   system runs its queued work in stream order. (WebGL2: systems run
   transform-feedback passes here instead, §14.2.)
3. **Main render pass**: one pass on the canvas (MSAA-resolved when
   `antialias` is on). The core replays the DRAW offsets in order with
   `decoder.seek(offset)`, then calls `system.draw(reader, pass)`.
4. M2 **pick pass** (only when picks are queued): the same DRAW offsets are
   replayed through `system.drawPick` into a 1×1 integer target (§16.3).
5. `list.submit()`, picking `afterSubmit()` (starts readbacks), then
   `system.endFrame()`, then acknowledge: `frameDone` (local and transfer
   path; the worker host first stores the frameId in the shared frame
   signal) or the ring control block (§17).

All `writeBuffer` calls made during step 1 land before the submitted
command buffer, so uploads are visible to compute and draw in the same
frame. **Pitfall:** several writes to the _same_ buffer range before one
submit collapse to the last one. Use dynamic offsets or distinct ranges
(see the Swarm spawn uniform and the pick View uniforms).

`frameDone` is posted exactly once per packet even when a system throws
(`try/finally`). A packet that cannot run (device lost, core dead) is
dropped, but its READBACK and PICK commands are still answered with
`code: 'DEVICE_LOST'` so front promises settle.

## 3. Command stream (normative)

Code: `src/commands/opcodes.ts` (constants) and `src/commands/types.ts`
(encoder, decoder, reader). `PROTOCOL_VERSION` is **2** in M2; the front
and the worker bundle must be built from the same version.

### 3.1 Encoding rules

- All values are little-endian. Scalars are `u32`, `i32`, or `f32`, with
  `u16` only in the command header.
- **Everything is 4-byte aligned.** Every payload starts on a 4-byte
  boundary and its length is rounded up to a multiple of 4. Readers can
  therefore take `Float32Array` and `Uint32Array` views without copying.
- Byte blobs (`u8[n]`) are followed by zero padding to the next multiple
  of 4. The length field stores the **unpadded** length; the header's
  `payloadBytes` stores the padded total.
- Strings are UTF-8 and prefixed by their byte length (a `u32` field
  earlier in the payload).
- Ids are `u32`. `0` means none. `0xFFFFFFFF` (`NO_ID`) means
  "absent/default" (for example, no texture). Ids come from
  `src/types/ids.ts`.
- Objects that cannot be bytes (ImageBitmap, ArrayBuffer,
  SharedArrayBuffer) go into `packet.objects[]`. Commands refer to them by
  `objectIndex`. A packet with objects never travels through the command
  ring (§17); it takes the transfer path.

### 3.2 Packet header (16 B)

| off | type | field                                 |
| --- | ---- | ------------------------------------- |
| 0   | u32  | magic `0x31475A43` ("CZG1")           |
| 4   | u32  | byteLength (used bytes, incl. header) |
| 8   | u32  | frameId                               |
| 12  | u32  | commandCount                          |

### 3.3 Command header (8 B)

| off | type | field                                        |
| --- | ---- | -------------------------------------------- |
| 0   | u16  | opcode (high byte = system range)            |
| 2   | u16  | flags: bit0 `DRAW`, bit1 `COMPUTE`, others 0 |
| 4   | u32  | payloadBytes (padded, multiple of 4)         |

Example: `SPRITE_DRAW(bufferId=1, first=0, count=500, texId=3, blend=normal)`
is 28 bytes:

```
10 02  01 00  14 00 00 00  01 00 00 00  00 00 00 00  F4 01 00 00  03 00 00 00  00 00 00 00
op     flags  payload=20   bufferId=1   first=0      count=500    texId=3      blend=0
```

### 3.4 Opcodes

Ranges: `0x00` core, `0x01` texture, shared memory, readback and picking
(all handled by RenderCore), `0x02` sprite, `0x03` swarm, `0x04–0x7F`
reserved (M3: text, masks, filters), `0x80–0xFF` extensions. Unknown
opcodes are skipped using `payloadBytes`, with one warning per opcode.

| opcode | name                         | flags   | payload                                                                                                                       |
| ------ | ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0x0000 | NOP                          |         | —                                                                                                                             |
| 0x0001 | FRAME_BEGIN                  |         | f32 time, f32 dt                                                                                                              |
| 0x0002 | RESIZE                       |         | f32 cssWidth, f32 cssHeight, f32 resolution                                                                                   |
| 0x0003 | SET_CLEAR_COLOR              |         | f32 r, g, b, a (straight)                                                                                                     |
| 0x0004 | SET_VIEW                     |         | f32 a, b, c, d, tx, ty (stage → css px)                                                                                       |
| 0x00FF | FRAME_END                    |         | —                                                                                                                             |
| 0x0100 | TEXTURE_CREATE               |         | u32 texId, width, height, formatId, texFlags (bits 24–31: mip level count, M2)                                                |
| 0x0101 | TEXTURE_UPLOAD_PIXELS        |         | u32 texId, x, y, w, h, u8[w·h·4]                                                                                              |
| 0x0102 | TEXTURE_UPLOAD_BITMAP        |         | u32 texId, objectIndex, flipY                                                                                                 |
| 0x0103 | TEXTURE_DESTROY              |         | u32 texId                                                                                                                     |
| 0x0104 | TEXTURE_UPLOAD_BITMAP_REGION |         | M2. u32 texId, objectIndex, x, y, flipY                                                                                       |
| 0x0105 | TEXTURE_UPLOAD_COMPRESSED    |         | M2. u32 texId, mipLevel, width, height, objectIndex (ArrayBuffer), byteOffset, byteLength                                     |
| 0x0106 | TEXTURE_GENERATE_MIPMAPS     |         | M2. u32 texId                                                                                                                 |
| 0x0110 | SHARED_REGISTER              |         | u32 sharedId, objectIndex                                                                                                     |
| 0x0111 | SHARED_RELEASE               |         | u32 sharedId                                                                                                                  |
| 0x0120 | READBACK                     |         | u32 requestId, srcKind (0 sprite buf, 1 swarm hot, 2 swarm cold), srcId, first, count; M2: srcKind 3 = swarm alive count      |
| 0x0121 | PICK                         |         | M2. u32 requestId, f32 x, f32 y (css px)                                                                                      |
| 0x0200 | SPRITE_BUFFER_ALLOC          |         | u32 bufferId, capacity                                                                                                        |
| 0x0201 | SPRITE_BUFFER_DESTROY        |         | u32 bufferId                                                                                                                  |
| 0x0202 | SPRITE_UPLOAD                |         | u32 bufferId, first, count, u8[count·40]                                                                                      |
| 0x0203 | SPRITE_UPLOAD_SHARED         |         | u32 bufferId, first, count, sharedId, byteOffset                                                                              |
| 0x0210 | SPRITE_DRAW                  | DRAW    | u32 bufferId, first, count, texId, blendModeId                                                                                |
| 0x0300 | SWARM_CREATE                 |         | u32 swarmId, capacity, texId, blendModeId, renderFlags, paramsBytes, computeSrcBytes, renderSrcBytes, u8[compute], u8[render] |
| 0x0301 | SWARM_DESTROY                |         | u32 swarmId                                                                                                                   |
| 0x0302 | SWARM_SET_PIPELINE           |         | like CREATE without capacity                                                                                                  |
| 0x0303 | SWARM_WRITE_HOT              |         | u32 swarmId, first, count, u8[count·40]                                                                                       |
| 0x0304 | SWARM_WRITE_COLD             |         | u32 swarmId, first, count, u8[count·16]                                                                                       |
| 0x0305 | SWARM_SPAWN                  | COMPUTE | u32 swarmId, u8[112] SpawnParams                                                                                              |
| 0x0306 | SWARM_KILL_RANGE             | COMPUTE | u32 swarmId, first, count                                                                                                     |
| 0x0307 | SWARM_KILL_LIST              | COMPUTE | u32 swarmId, n, u32[n]                                                                                                        |
| 0x0308 | SWARM_SET_PARAMS             |         | u32 swarmId, byteOffset, byteLength, u8[byteLength]                                                                           |
| 0x0309 | SWARM_STEP                   | COMPUTE | u32 swarmId, f32 dt, u32 substeps, u32 activeCount                                                                            |
| 0x030A | SWARM_DRAW                   | DRAW    | u32 swarmId, f32 a, b, c, d, tx, ty, f32 alpha, u32 drawCount                                                                 |
| 0x030B | SWARM_SET_FRAMES             |         | u32 swarmId, count, f32[count·4] (u0, v0, u1, v1)                                                                             |
| 0x030C | SWARM_SET_PICK               |         | M2. u32 swarmId, pickId (Swarm node id; 0 = not pickable)                                                                     |

Format ids: `rgba8unorm`=0, `rgba8unorm-srgb`=1, `r8unorm`=2,
`rgba16float`=3. M2 compressed format ids (names equal the RHI
`TextureFormat`): `bc1-rgba-unorm`=16, `bc1-rgba-unorm-srgb`=17,
`bc3-rgba-unorm`=18, `bc3-rgba-unorm-srgb`=19, `bc4-r-unorm`=20,
`bc5-rg-unorm`=21, `bc7-rgba-unorm`=22, `bc7-rgba-unorm-srgb`=23,
`etc2-rgb8unorm`=32, `etc2-rgb8unorm-srgb`=33, `etc2-rgba8unorm`=34,
`etc2-rgba8unorm-srgb`=35, `eac-r11unorm`=36, `eac-rg11unorm`=37,
`astc-4x4-unorm`=48, `astc-4x4-unorm-srgb`=49.

Texture flags: `MIPMAPS`=1, `NEAREST`=2, `REPEAT`=4,
`PREMULTIPLIED`=8, `RETAIN_SOURCE`=16. Bits 24–31 of texFlags
(`TEXTURE_MIP_LEVELS_SHIFT`) carry an explicit mip level count; 0 means
automatic (1, or the full chain with MIPMAPS). Blend ids: normal=0, add=1,
multiply=2, screen=3, none=4.

M2 payload rules:

- `TEXTURE_UPLOAD_BITMAP_REGION` copies the whole bitmap to (x, y) of mip
  0 and never regenerates mips; the asset manager emits one
  `TEXTURE_GENERATE_MIPMAPS` per page per frame after its region uploads.
- `TEXTURE_UPLOAD_COMPRESSED` uploads exactly one whole mip level. The
  ArrayBuffer is transferred (worker) and not retained by the core.
- `PICK` coordinates are canvas css px, the same space as pointer events'
  `offsetX/offsetY` (before `SET_VIEW`).

### 3.5 Core to front messages

These are defined in `src/types/transport.ts`: `ready{caps}`,
`frameDone{frameId, buffer}`, `readback{requestId, data, code?, message?}`,
`pick{requestId, objectId, instance, code?, message?}` (M2),
`deviceLost{message}`, `deviceRestored`, and `error{code, message}`. The
transfer path transfers the ArrayBuffers.

**Accepted M1 contract (optional fields):** `readback.code` and
`readback.message` are set when a readback failed; `data` is then empty and
the front rejects with `CozyGPUError(code)`. Codes: `DEVICE_LOST` (lost
before or during the read, including `mapAsync` rejections after a loss),
`OUT_OF_CAPACITY` (refused or disabled swarm), `UNSUPPORTED` (no system
owns `srcKind`), `INTERNAL` (non-cozygpu exception, also logged as
`error`). `init.frameSignal` is described in §8.

### 3.6 Encoder and decoder rules

- The encoder uses a growable ArrayBuffer (start at 64 KiB, grow ×2)
  with cached `Uint8Array`, `Uint32Array`, and `Float32Array` views. Views
  are rebuilt only when the buffer grows.
- Pool: up to 3 buffers. On the transfer path a buffer is detached while
  in flight and returns with `frameDone`. M2: `encoder.reset()` also
  accepts a ring `SharedArrayBuffer` slot; a packet that outgrows it moves
  to a fresh ArrayBuffer and takes the transfer path for that frame.
- `utf8()` uses a shared `TextEncoder.encodeInto`.
- The decoder validates the magic, `byteLength ≤ buffer.byteLength`, and
  that every command end is ≤ byteLength. `seek()` also checks that the
  command header and its payload fit the packet. On corruption it throws
  `CozyGPUError('INVALID_ARGUMENT')`, and the core drops the packet. The
  decoder caches its views per buffer, so a ring slot costs no allocation
  per packet.
- Tests (Node, no GPU) must round-trip every opcode and check the
  alignment, padding, and growth invariants
  (`src/commands/commands.test.ts`).

## 4. Memory layouts (normative)

Code: `src/types/layouts.ts`. WGSL structs (and, M2, GLSL std140 blocks
and attribute layouts) must match. `src/types/layouts.test.ts` asserts
WGSL struct sizes against these constants.

Packed color everywhere: `u32 = r | g<<8 | b<<16 | a<<24`, so bytes on
disk are `R G B A`. This equals WGSL `unpack4x8unorm(u)` and vertex format
`unorm8x4`.

**Alpha convention:** colors are stored straight (non-premultiplied).
Textures on the GPU hold premultiplied texels. **Every fragment shader
outputs premultiplied color.** Blend `normal` = (one, one-minus-src-alpha),
`add` = (one, one), `multiply` = (dst, one-minus-src-alpha), `screen` =
(one, one-minus-src). The canvas uses premultiplied alpha
(WebGPU `alphaMode: 'premultiplied'`, WebGL2 `premultipliedAlpha: true`).

### 4.1 Sprite instance: 40 B, vertex buffer, `stepMode: 'instance'`

| off | size | type | field                                     | vertex attr                        |
| --- | ---- | ---- | ----------------------------------------- | ---------------------------------- |
| 0   | 4    | f32  | a                                         | @location(1) `float32x4` (a,b,c,d) |
| 4   | 4    | f32  | b                                         |                                    |
| 8   | 4    | f32  | c                                         |                                    |
| 12  | 4    | f32  | d                                         |                                    |
| 16  | 4    | f32  | tx                                        | @location(2) `float32x2`           |
| 20  | 4    | f32  | ty                                        |                                    |
| 24  | 4    | u8×4 | color RGBA (tint × worldAlpha)            | @location(3) `unorm8x4`            |
| 28  | 2    | u16  | u0 (unorm)                                | @location(4) `unorm16x4`           |
| 30  | 2    | u16  | v0                                        |                                    |
| 32  | 2    | u16  | u1                                        |                                    |
| 34  | 2    | u16  | v1                                        |                                    |
| 36  | 4    | u32  | flags (bits 0–7) + pickId (bits 8–31, M2) | @location(5) `uint32`              |

The affine maps the **unit quad** corner `q ∈ [0,1]²` straight to stage
space, because it already includes `translate(-anchor·size)·scale(size)`:

```wgsl
// geometry from vertex_index, no vertex buffer (triangle-strip, 4 verts)
let q = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
let p = inst.ad.xy * q.x + inst.ad.zw * q.y + inst.t;          // stage px
let s = view.col0 * p.x + view.col1 * p.y + view.translate;    // css px
out.pos = vec4f(s.x / view.resolution.x * 2.0 - 1.0, 1.0 - s.y / view.resolution.y * 2.0, 0.0, 1.0);
out.uv  = mix(inst.uv.xy, inst.uv.zw, q);
```

WebGL2 uses the same attributes with `gl_VertexID` (§13.3).

**Pick id (M2):** `SI_FLAGS >> SI_PICK_SHIFT` is the sprite's
`SceneNode.id` when `pickable` and `id ≤ SI_PICK_MAX` (0xFFFFFF), else 0.

### 4.2 Swarm hot: 40 B, `var<storage, read_write>` in compute, `read` in vertex

```wgsl
struct SwarmHot {   // size 40, align 4
  pos:    vec2f,    // 0
  vel:    vec2f,    // 8
  scale:  vec2f,    // 16  size in stage px
  rot:    f32,      // 24  radians
  angVel: f32,      // 28  radians/s
  age:    f32,      // 32  seconds since spawn
  life:   f32,      // 36  seconds; <= 0 means dead; 3.4e38 means immortal
}
```

WebGL2 (M2) stores the same 40-byte record interleaved in a vertex
buffer: `vec4 h0 = (pos, vel)`, `vec4 h1 = (scale, rot, angVel)`,
`vec2 h2 = (age, life)`, which is also the transform-feedback varying
order.

### 4.3 Swarm cold: 16 B, `read` in step and vertex, `read_write` in spawn

```wgsl
struct SwarmCold {  // size 16
  color: u32,       // 0  packed RGBA8
  frame: u32,       // 4  index into frames: array<vec4f> (u0,v0,u1,v1)
  flags: u32,       // 8  bits 8-15 behavior groups (M2); rest reserved
  user:  u32,       // 12 free for custom behaviors
}
```

Why the split: the step pass touches only hot data and reads cold data
rarely. `write()` of colors never re-uploads positions. Cold is
typically static after spawn.

### 4.4 SpawnParams: 112 B uniform (dynamic offset, stride 256)

| off | type  | field    | off | type | field                                                      |
| --- | ----- | -------- | --- | ---- | ---------------------------------------------------------- |
| 0   | u32   | first    | 64  | f32  | rotMin                                                     |
| 4   | u32   | count    | 68  | f32  | rotMax                                                     |
| 8   | u32   | seed     | 72  | f32  | angVelMin                                                  |
| 12  | u32   | frame    | 76  | f32  | angVelMax                                                  |
| 16  | vec2f | posMin   | 80  | f32  | lifeMin                                                    |
| 24  | vec2f | posMax   | 84  | f32  | lifeMax                                                    |
| 32  | vec2f | velMin   | 88  | u32  | colorA                                                     |
| 40  | vec2f | velMax   | 92  | u32  | colorB                                                     |
| 48  | vec2f | scaleMin | 96  | u32  | frameCount                                                 |
| 56  | vec2f | scaleMax | 100 | u32  | flags (UNIFORM_SCALE=1, POLAR_VELOCITY=2, DISC_POSITION=4) |
|     |       |          | 104 | u32  | user                                                       |
|     |       |          | 108 | u32  | coldFlags (M2: written to cold.flags; M1 `_pad`, always 0) |

Color sampling: rgb uses one random t between colorA and colorB (a
gradient), alpha uses its own random t.

### 4.5 Uniforms

```wgsl
struct View      { col0: vec2f, col1: vec2f, translate: vec2f, resolution: vec2f,
                   time: f32, dt: f32, dpr: f32, _pad: f32 }        // 48 B, @group(0) @binding(0)
struct SwarmSim  { dt: f32, time: f32, count: u32, substep: u32 }   // 16 B
struct SwarmDraw { col0: vec2f, col1: vec2f, translate: vec2f, alpha: f32, flags: u32 } // 32 B
```

The WGSL uniform layouts above are identical to GLSL std140 for these
members, so the same bytes feed both backends. Behavior params composed
by the swarm composer pin every member with `@size`, and the GLSL
composer must produce the same offsets (§14.2).

### 4.6 Bind group conventions

| group | contents                                                                     | owner                                                                                        |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0     | View uniform (VERTEX, FRAGMENT, COMPUTE)                                     | RenderCore (`ctx.viewLayout` / `ctx.viewBindGroup`); the pick pass passes its own View group |
| 1     | texture + sampler (`ctx.textureLayout`, from `ctx.getTexture(id).bindGroup`) | RenderCore                                                                                   |
| 2     | system data (swarm buffers and uniforms)                                     | each system                                                                                  |

Pipelines that don't use group 1, such as swarm compute, put an empty bind
group layout at index 1 so group numbers stay stable. WebGL2 maps
(group, binding) to names (§13.3).

### 4.7 Picking (M2)

Pick target `PICK_TARGET_FORMAT` = `rg32uint`, one texel. A pick fragment
writes `vec2u(objectId, instance + 1)`; sprites write `(pickId, 0)`, so
instance decodes to -1. `(0, 0)` is a miss. Texels whose premultiplied
alpha is below `PICK_ALPHA_THRESHOLD` (0.5) are discarded. Readback is
`PICK_RESULT_BYTES` = 8.

## 5. Sprites: scene graph to GPU

Owner: sprites. Files: `src/scene/*`, `src/sprites/front.ts`,
`src/sprites/core.ts`, `src/math/*`. This section describes M1 as built;
M2 changes are in §16.

### 5.1 Front stores (SoA, zero allocation per frame)

`NodeStore` (`src/scene/store.ts`) is process-wide. Arrays are replaced on
growth (×2), so code reads them through the `nodeStore` object and never
keeps a view across node creation.

| array                 | stride         | contents                                                                                             |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `pos`                 | 2 f32          | x, y. Kept apart from the local record, so per-frame moves touch an 8-byte stride                    |
| `local`               | 12 f32         | rot, scaleX, scaleY, skewX, skewY, pivotX, pivotY, alpha, anchorX, anchorY, frameW, frameH           |
| `localAffine`         | 6 f32          | cached local 2×2 (slots 4–5 are filled only by `updateTransform()`)                                  |
| `world`               | 6 f32          | stage-space affine. Its 2×2 is authoritative; its translation is materialized on read (see `worldT`) |
| `worldT`              | 2 f32          | M2. Authoritative world translation, dense so per-frame moves touch an 8-byte stride                 |
| `worldAlpha`          | 1 f32          |                                                                                                      |
| `dirty`               | u8             | LOCAL=1, ALPHA=2, SPRITE=4, POSITION=8 (LOCAL implies POSITION)                                      |
| `tint`, `uv`, `flags` | u32, 4 u16, u8 | sprite data                                                                                          |

- `structureVersion` is bumped on add, remove, reorder, visibility,
  texture-source or blend changes (anything that moves a batch boundary).
- `touch` is bumped by every `markDirty()` and slot alloc/free, masked to
  30 bits so it stays a small integer. A packer whose tree did not change
  and whose `touch` is unchanged skips the transform pass entirely (static
  scenes cost ~0.03 ms per frame at 100k sprites).
- `setPosition(x, y)` inlines `markDirty` and sets only `POSITION`.
- **M2 `worldT`.** Every writer puts the world translation in `worldT`
  (2 f32 per slot); `world[]` slots 4–5 are stale between renders.
  `materializeWorld()` folds `worldT` back into `world[]` and is called from
  `SceneNode.worldTransform`, `Container.updateTransform()` and the packer's
  slow path, so the public contract is unchanged: `worldTransform` still
  reports the value as of the last `render()` / `updateTransform()`. The
  moved-sprite fast path writes only `worldT` plus the instance bytes, which
  is what took the 100k-moving-sprite transform pass from 0.425 ms to
  0.350 ms.
- `InstanceStore`: one ArrayBuffer (a `SharedArrayBuffer` when
  `frame.useSharedArrayBuffer`) of `capacity × 40` bytes, with cached
  `Float32Array`, `Uint32Array`, `Uint16Array`, and `Uint8Array` views.
  **Instance index = draw order.**

### 5.2 pack(stage, frame)

1. **Structure pass** (`rebuild`), only when `structureVersion` or the
   stage changed. It walks the tree depth-first, with sprite children
   inlined without recursion, and fills a flat list: node slot, parent
   flat index, kind plus force bits, and `runEnd` (the end of the run of
   consecutive sprite siblings). Each visible sprite gets the next instance
   index. Batches are contiguous (texture source, blend) runs, split by
   CustomDrawables. Force bits: `FORCE_WORLD` when a node was not visited
   in the previous build (its world may be stale), `FORCE_INSTANCE` when a
   different node owned that instance index before (`instOwner`). M1
   rebuilds the whole list; the incremental version is §16.2.
2. **Transform pass** over the flat list, never recursive. Parent values
   (world 2×2, translation, alpha, changed bits) are cached while
   consecutive entries share a parent. Work is split by what changed:
   - Nothing changed and the parent did not change: skip.
   - **Position-only fast path:** a sprite with only `Dirty.POSITION`
     under an unchanged parent consumes its whole sibling run in a tight
     loop. It reads `pos` and the **offset cache** `instOff` (4 f32 per
     instance: local pivot offset x, y and world-space anchor offset x, y),
     writes `worldT` (not `world[]`, §5.1) and instance bytes 16..23, and
     clears the dirty byte. Rebuild frames only trust single entries (force
     bits). The loop walks its offsets forward instead of multiplying per
     sprite, and a `hasPivots` flag selects a variant that skips the two
     pivot-offset reads for the common pivot-free scene.
   - Translation only (POSITION, or a parent whose world only translated):
     recompute world tx/ty with the cached 2×2 and pivot.
   - 2×2 change (LOCAL, FORCE_WORLD, parent 2×2 changed): full local
     affine (`rot`/`skew` fast cases), full multiply, all six instance
     floats, and a fresh `instOff` record.
   - Color, UVs, and flags are repacked only on alpha change, `SPRITE`, or
     `FORCE_INSTANCE`.
3. **Dirty ranges** (`DirtyRanges`): up to 8 `[start, end)` instance
   ranges. Instance indices increase along the flat list, so the pass
   tracks the open run inline. Gaps up to `MERGE_GAP` = 32 instances are
   merged; when full, the nearest ranges merge. `finalize()` uploads one
   range if the dirty instances cover more than half of the overall span.
4. **Upload.** Growth or a new generation emits `SPRITE_BUFFER_ALLOC`,
   then a full upload. If `frame.sharedMemory`, the store is registered
   once per buffer and generation (`SHARED_REGISTER`, `SHARED_RELEASE` for
   the previous buffer) and each range becomes `SPRITE_UPLOAD_SHARED`.
   Otherwise `SPRITE_UPLOAD` carries the bytes inline.
5. **Draw.** `SPRITE_DRAW` per batch, every frame (20-byte payload).
   `ensureTextureUploaded` emits `TEXTURE_CREATE` and the upload the first
   time a source is used per (renderer, generation). A `CustomDrawable`
   splits the batch.

### 5.3 Core

`SpriteCoreSystem` keeps a GPU vertex buffer per bufferId
(`VERTEX|COPY_DST`) and one pipeline per blend mode (created async in
`init`). It caches a `Uint8Array` view per sharedId (created at register
time, never per frame) and calls
`backend.writeBuffer(buf, first·40, view, byteOffset + first·40, count·40)`.

**Widened uploads:** Chrome (Metal) has a `queue.writeBuffer` size cliff:
writes below 4 MiB go through a slower staging path (~0.5 ms/MB) than
writes of 4 MiB or more (~0.03 ms/MB). Shared uploads in `[1 MiB, 4 MiB)`
are widened to 4 MiB when both the GPU buffer and the source have room
(end first, then start). The extra bytes are the store's current contents
or unused capacity, so rewriting them is harmless.

For draws it sets the pipeline, group 0 (`ctx.viewBindGroup`), group 1
from `ctx.getTexture(texId)`, then calls `draw(4, count, 0, first)` with
`triangle-strip`. Draws of a bufferId that is missing or too small are
skipped.

UV packing: `u16 = round(u · 65535)`. Texture frames are converted once
per texture change, not per frame.

Texture lifecycle: `Texture.destroy()` queues the source; each packer
flushes `TEXTURE_DESTROY` for renderers that uploaded it and frees the
texId when no renderer holds it. `Renderer.destroy()` calls
`dropTextureUploads(rendererId)` so ids are freed even when that renderer
never flushes again.

## 6. Swarm: GPU simulation

Owner: swarm. Files: `src/swarm/*`, `src/shaders/swarm/*`. This section
describes the WebGPU path built in M1; §14 adds WebGL2 and GPU free lists.

### 6.1 GPU objects per swarm (core)

| buffer                     | usage                                        | size                                             |
| -------------------------- | -------------------------------------------- | ------------------------------------------------ |
| hot                        | STORAGE, COPY_DST, COPY_SRC                  | capacity × 40                                    |
| cold                       | STORAGE, COPY_DST, COPY_SRC                  | capacity × 16                                    |
| frames                     | STORAGE, COPY_DST                            | max(1, frames) × 16                              |
| params                     | UNIFORM, COPY_DST                            | paramsBytes (≥ 16)                               |
| sim                        | UNIFORM, COPY_DST                            | 16                                               |
| draw                       | UNIFORM, COPY_DST                            | 32                                               |
| spawn                      | UNIFORM, COPY_DST                            | 256 × maxSpawnsPerFrame (grows), dynamic offsets |
| kill                       | STORAGE, COPY_DST (u32 list) + UNIFORM range | grows                                            |
| visible + args (cull only) | STORAGE / INDIRECT                           | capacity × 4, 16                                 |

The capacity check runs at SWARM_CREATE:
`capacity × 40 ≤ caps.maxStorageBufferBindingSize`. The default limit of
128 MiB allows about 3.35M objects. With `limits: 'max'` the backend
requests the adapter maximum for `maxBufferSize` and
`maxStorageBufferBindingSize` (100M objects were allocated in M1 tests).
Large buffers wait for the backend's `allocated` promise
(`src/backend/allocation.ts`) before binding, so one out-of-memory
allocation cannot break every frame. Swarms over 1 GiB warn once. On
failure the core posts `error{OUT_OF_CAPACITY}` and readbacks of that swarm
reject with the same code.

### 6.2 Front: allocation and commands

- `allocation: 'ring'` (default): `spawn(n)` returns `cursor`, advances
  by `n` mod capacity, and splits into two SWARM_SPAWN commands when it
  wraps. `activeCount = min(capacity, max ever written)`.
- `allocation: 'manual'`: uses a CPU free list of ranges. `kill()`
  returns slots to it; `spawn` returns -1 when no contiguous range is
  free. Deaths from `life` or `bounds` are **not** reported to the CPU, so
  manual swarms should use immortal objects. `'gpu'` is M2 (§14.3).
- Every mutating call encodes into the swarm's own small growable byte
  queue, using the same binary format. `_emitDraw` does the rest:
  - First use per (renderer, generation): SWARM_CREATE (composed WGSL) and
    SWARM_SET_FRAMES.
  - It copies the queue into `frame.encoder`, then emits SWARM_SET_PARAMS
    once if the params mirror is dirty.
  - If `autoStep`, it emits SWARM_STEP with `frame.dt × timeScale`, then
    SWARM_DRAW.
- A swarm that is detached or invisible is neither flushed nor stepped.
  Its queue waits; `clear()` or `destroy()` discard it.
- `destroy()` queues SWARM_DESTROY per renderer that created it
  (`src/swarm/destroyQueue.ts`); `Renderer.render()` flushes it every
  frame, and a swarm moved to another renderer releases the old one's
  buffers the same way.
- `behavior(name).set()` writes the `Float32Array` / `Uint32Array` mirror
  of the params uniform at the composer-computed offset and marks it
  dirty. There is no per-call encoding.

### 6.3 Composer (pure function, Node-testable)

`composeSwarmShaders(behaviors, renderFlags, language?)` returns
`{ language, compute, render, paramsBytes, params[] }`.

- Params layout: behaviors in order, fields in declaration order, using
  WGSL uniform layout rules (vec2f align 4, vec3f/vec4f align 16, struct
  rounded to 16). Each behavior gets
  `struct P_<name> { … }`, and `Params { <name>: P_<name>, … }`.
  `$params` in a snippet becomes `params.<name>`. A behavior with no
  params gets no field; add a `_pad: u32` if Params would be empty.
- The composer pins every member with `@size(n)` (and nested structs
  with their rounded size), so the byte layout never depends on
  implementation-specific WGSL rules. Chrome no longer pads a member
  that follows a nested struct to a 16-byte boundary; relying on that
  rule shifted the attractor params in M1.
- Template placeholders (`//@SLOT` etc.) are replaced on whole lines only,
  and a missing marker throws. Build-time shader minification must keep
  every `//@` line intact (§18.2).
- Validation: names are unique and match `/^[a-z][a-zA-Z0-9_]*$/`, no
  WGSL keywords, no `$params` without params, helper identifiers carry the
  behavior prefix, no clashes. Throw `CozyGPUError('INVALID_ARGUMENT')`
  with the behavior name.

Composed compute shader (sketch):

```wgsl
// prelude: SwarmHot, SwarmCold, SwarmSim, View, SpawnParams, hash32/rand01
@group(0) @binding(0) var<uniform> view: View;
@group(2) @binding(0) var<storage, read_write> hot: array<SwarmHot>;
@group(2) @binding(1) var<storage, read> cold: array<SwarmCold>;
@group(2) @binding(2) var<uniform> sim: SwarmSim;
@group(2) @binding(3) var<uniform> params: Params;

fn hash32(x: u32) -> u32 { var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u; return (h >> 22u) ^ h; }
fn rand01(i: u32, salt: u32) -> f32 { return f32(hash32(i ^ hash32(salt))) / 4294967295.0; }

@compute @workgroup_size(256)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * 65535u * 256u;       // 2D dispatch beyond 16.7M invocations
  if (i >= sim.count) { return; }
  var p = hot[i];
  if (p.life <= 0.0) { return; }
  p.age += sim.dt;
  if (p.age >= p.life) { p.life = 0.0; hot[i] = p; return; }
  let c = cold[i];
  { /* behavior 0: velocity */ p.pos += p.vel * sim.dt; p.rot += p.angVel * sim.dt; }
  { /* behavior 1: acceleration */ p.vel += params.gravity.value * sim.dt; }
  hot[i] = p;
}
```

`cs_spawn` binds cold as `read_write` plus the SpawnParams uniform with a
dynamic offset, and initializes `[first, first+count)` from
`rand01(slot, seed + k)`. `cs_kill` sets `life = 0` for a range or a list.
Step, spawn, and kill use **separate bind groups** because cold is `read`
in one and `read_write` in another.

Dispatch: `ceil(n / 256)` workgroups; when that exceeds 65535, use
`x = 65535, y = ceil(n / (256·65535))`. `substeps > 1` means dispatching
cs_step k times with `dt/k`. Each substep writes a distinct sim uniform
offset (dynamic offsets again, to avoid collapsed writes).

### 6.4 Render

The vertex shader reads hot, cold, and frames from storage (group 2) and
View (group 0). It draws with `draw(6, activeCount)` and no vertex
buffers, or with `drawIndirect` over the compacted `visible` list when
`render.cull` is on (requires `caps.indirectDraw`).

```wgsl
let h = hot[ii]; let c = cold[ii];
if (h.life <= 0.0) { out.pos = vec4f(2.0, 2.0, 2.0, 1.0); return out; } // degenerate → clipped
var t = 1.0 - clamp(h.age / h.life, 0.0, 1.0);
let corner = QUAD[vi] - 0.5;                               // 6-vertex quad
let sz = h.scale * select(1.0, t, (draw.flags & SHRINK) != 0u);
let ang = select(h.rot, atan2(h.vel.y, h.vel.x), (draw.flags & ALIGN) != 0u);
let local = rotate(corner * sz, ang) + h.pos;              // swarm space
let stage = draw.col0 * local.x + draw.col1 * local.y + draw.translate;
// … View → clip as in §4.1; color = unpack4x8unorm(c.color); a *= draw.alpha (* t if FADE_OUT)
// fragment: textured quad or SDF circle (CIRCLE flag); output premultiplied
```

Swarm draw order is its position in the scene tree. Draws from the same
swarm are not merged with sprites.

On WebGPU the core requires `caps.compute && caps.vertexStorage`;
otherwise it posts `error{UNSUPPORTED}` on SWARM_CREATE and the swarm draws
nothing. WebGL2 takes the §14.2 path instead.

### 6.5 Async pipelines

SWARM_CREATE creates buffers synchronously, so WRITE_HOT and WRITE_COLD
work immediately. Pipelines use `createComputePipeline` and
`createRenderPipeline`, both async. Until they are ready:

- SPAWN and KILL commands are kept in a pending list, in order.
- STEP commands are dropped.
- DRAW commands are skipped.

A WRITE that follows a dispatch in the same frame is deferred (with
everything after it) to the next frame, because all `writeBuffer` calls
land before the frame's command buffer. `SWARM_SET_PIPELINE` keeps the old
pipeline running until the new one resolves. Param bytes are resized and
preserved per name where possible.

## 7. Backend (RHI)

Contract: `src/backend/types.ts` (frozen). Implementations:
`src/backend/webgpu/*` (M1) and `src/backend/webgl2/*` (M2, §13). Both are
loaded by dynamic import from `src/backend/createBackend.ts`.

- The RHI is thin: buffers, textures, samplers, shader modules, bind
  group layouts and groups, render, compute (async) and M2 transform
  feedback pipelines, one `CommandList` per frame with render, compute and
  M2 feedback passes, `draw`, `drawIndexed`, `drawIndirect`, `dispatch`,
  `readBuffer` and M2 `readTexture`.
- Enums are `as const` objects, not `const enum`, which keeps it safe
  under `isolatedModules`. String unions mirror WebGPU spelling.
- **No WebGPU or WebGL types in the interface**, and none in the public
  API. Implementations cast internally.
- **Capability flags** (`Capabilities`) gate features. Nothing above the
  RHI may assume compute, storage buffers, indirect draws, or transform
  feedback.

| flag                                        | WebGPU                             | WebGL2                                                                          |
| ------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `shaderLanguage`                            | `'wgsl'`                           | `'glsl300es'`                                                                   |
| `compute`, `storageBuffers`, `indirectDraw` | true                               | false                                                                           |
| `vertexStorage`                             | true (false in compat mode)        | false                                                                           |
| `transformFeedback`                         | false                              | true                                                                            |
| `instancing`                                | true                               | true                                                                            |
| `baseInstance`                              | true                               | extension `WEBGL_draw_instanced_base_vertex_base_instance` (emulated otherwise) |
| `floatRenderTargets`                        | true                               | `EXT_color_buffer_float`                                                        |
| `integerRenderTargets`                      | true                               | true (R32UI / RG32UI)                                                           |
| `maxSampledTextures`                        | `maxSampledTexturesPerShaderStage` | `MAX_TEXTURE_IMAGE_UNITS`                                                       |
| `textureCompression.bc` / `bc7`             | `texture-compression-bc`           | s3tc + rgtc / bptc                                                              |
| `textureCompression.etc2` / `astc`          | features                           | `WEBGL_compressed_texture_etc` / `_astc`                                        |

- **One color format everywhere:** `caps.canvasFormat`. WebGPU uses
  `navigator.gpu.getPreferredCanvasFormat()`; the context is configured
  with it, and every color-target pipeline defaults to it. WebGL2 reports
  `rgba8unorm`. Never hard-code `bgra8unorm`.
- `beginCommands()` returns a reused CommandList, and passes are reused
  wrappers, so there is no per-frame allocation. WebGPU creates a
  `GPUCommandEncoder` per frame (unavoidable) but keeps one pass
  descriptor object and mutates its `view`.
- Device request: `requiredLimits` gets `maxBufferSize` and
  `maxStorageBufferBindingSize` set to the adapter maximum when
  `limits: 'max'`. Request the features `timestamp-query`,
  `float32-filterable`, `texture-compression-*` and
  `indirect-first-instance` if available; never require them.
- **Init order (M2, normative):** acquire adapter and device first, then
  call `canvas.getContext('webgpu')`. A canvas that has a context can never
  get a different kind, so this order keeps `backend: 'auto'` able to fall
  back to WebGL2 (§13.5).
- **Deferred destroy:** `backend.destroy()` drops the device-lost callback,
  abandons the command list, unconfigures the context, and calls
  `device.destroy()` only after `queue.onSubmittedWorkDone()` resolves.
  `device.destroy()` blocks until queued frames finish (tens of ms at high
  frame rates), so teardown returns immediately instead.
- `debug: true` (RendererOptions → CoreInitOptions → BackendOptions) or
  `globalThis.__COZYGPU_DEBUG__ = true` adds error scopes around creation
  and frames plus shader warnings.
- RenderCore (`src/renderer/RenderCore.ts`) owns the view uniform, the
  1×1 white texture, the texture registry (`TextureRegistry.ts`; keeps
  ImageBitmap or pixel sources when `RETAIN_SOURCE` is set), the
  shared-memory table, the MSAA target, readback routing, the picking
  module, and opcode routing.

## 8. Worker mode

Owner: worker+build (transport, entry, host, encoder and decoder).
RenderCore is the same code in both modes.

**Startup** (`createRenderer({ canvas, worker: true })`):

1. Main thread: `offscreen = canvas.transferControlToOffscreen()` and
   `new Worker(url, { type: 'module', name: 'cozygpu' })`. The default
   url is `new URL('./cozygpu.worker.js', import.meta.url)`; override it
   with `worker: { url }`. M2: `WorkerTransport` itself is loaded with a
   dynamic import (§18.1).
2. Post `init {canvas: offscreen, options, cssWidth, cssHeight,
resolution, frameSignal?, ring?}` with transfer `[offscreen]`.
3. The worker sizes the canvas, calls `createRenderCore(offscreen, options,
createDefaultCoreSystems(), post)` and posts `ready{caps}`. The
   transport resolves. If there is no `ready` within 10 s, it rejects
   with `UNSUPPORTED`.

**Frames (transfer path):** the transport posts `frame{packet}` with
transfer `[packet.buffer, ...ImageBitmaps]`. The core executes it and
replies `frameDone{frameId, buffer}`, transferring the buffer back to the
pool. At most one frame is in flight. `render()` while busy skips (§2).
M2 adds the SharedArrayBuffer command ring (§17); the transfer path stays
for non-isolated pages and for packets that carry objects.

**Frame signal (accepted M1 contract):** when `crossOriginIsolated`, the
transport creates a 4-byte SharedArrayBuffer (`init.frameSignal`). The
worker host stores the frameId of every finished packet in
`Int32Array[RingControl.ACK_FRAME_ID]` **before** posting `frameDone`, and
`transport.busy` reads it with `Atomics.load`. Under load the main thread
often runs the next rAF before the `frameDone` message task, which used to
skip about every other frame although the worker had finished in under a
millisecond. The buffer still returns with the message; until then the
encoder uses a second pooled buffer. In M2 the same buffer grows to
`RING_CONTROL_BYTES` (16) when the ring is enabled.

**Shared memory:** `sharedMemory = crossOriginIsolated && typeof
SharedArrayBuffer !== 'undefined'`. When true, stores allocate SABs,
register them once, and use `*_SHARED` uploads. The core reads the SAB
directly, so the stream carries no bulk bytes. When false, uploads copy
inline. Main-thread mode is always "shared", since it is the same heap.

**Caveats:**

- After `transferControlToOffscreen()` the main thread must never set
  `canvas.width` or `canvas.height`. Only the core does, on RESIZE.
- ImageBitmaps are cloned for `loadTexture` sources (the front keeps them
  for other renderers and device-loss restore) and **transferred** for
  asset-managed textures (GPU-only, §15).
- Worker code must not touch `window` or `document`, so
  `src/renderer/RenderCore.ts`, `src/renderer/TextureRegistry.ts`,
  `src/renderer/pickingCore.ts`, `src/backend/**`, `src/sprites/core.ts`,
  `src/swarm/core.ts`, and `src/worker/**` stay DOM-free. Use `globalThis`.
- **Readback:** the front allocates `requestId` (`ids.readback`), emits
  READBACK, and resolves the promise when `readback{requestId}` arrives.
  The core asks each system's optional `CoreSystem.readback(srcKind, srcId,
first, count)` in order; the first one that returns a promise owns the
  request. The data reflects the last submitted frame. Failures carry
  `code`/`message` (§3.5). A request whose device was lost is rejected on
  the front immediately (`DEVICE_LOST`); its id stays reserved until the
  core's answer arrives, so a late answer never settles a newer request.
- **Errors:** a `CozyGPUError` thrown inside the core keeps its code; any
  other exception is reported as `error{code: 'INTERNAL'}` (never
  `DEVICE_LOST`, which would kill the renderer). Each distinct message is
  posted once. `frameDone` is posted exactly once per packet even when a
  system throws (try/finally); the host acks packets itself if the core
  is missing or throws, and closes their ImageBitmaps.
- **Debug:** `debug: true` or `globalThis.__COZYGPU_DEBUG__ = true` also
  exposes the core as `globalThis.__COZYGPU_CORE__` in its own thread.

## 9. Device loss, resize, DPR

### 9.1 Device loss

1. The backend's `device.lost` handler runs for the current device. The
   backend never reports its own `destroy()` (it drops the callback first,
   and the core is already `DESTROYED`). A `reason: 'destroyed'` loss
   while the core is alive therefore came from outside the renderer (app
   code, an extension, a shared device) and is restored like any other
   loss. WebGL2: `webglcontextlost` (§13.6).
2. RenderCore sets state `LOST`, fails queued and in-flight picks with
   `DEVICE_LOST`, and posts `deviceLost{message}`. The front rejects
   pending readbacks and picks with `DEVICE_LOST` and calls
   `onDeviceLost({ willRestore: true })`. While lost, packets are dropped,
   but `frameDone` is still posted so buffers return, and their READBACK
   and PICK commands are answered with `code: 'DEVICE_LOST'`.
3. `backend.restore()` requests a new adapter and device (3 attempts:
   0 ms, 500 ms, 2000 ms) and reconfigures the context with the same
   format. Readbacks that were mapping when the device died reject with
   `DEVICE_LOST`, not `INTERNAL` (the core compares loss epochs).
4. The core recreates the view uniform, the white texture, retained
   textures (unretained ones become white and log one warning), and the
   MSAA target. Then it awaits `system.restore(ctx)` for each system and
   the picking module's `restore`.
5. It posts `deviceRestored`. The front increments `generation`, which
   has these effects:
   - RESIZE, SET_CLEAR_COLOR and SET_VIEW are re-sent.
   - Stores re-register shared memory and re-alloc with a full upload.
   - Textures are re-uploaded if the front still has their source.
   - M2: `FrontFrameHook.onDeviceRestored()` runs; the asset manager
     reloads GPU-only textures from their URLs (§15.7).
   - Swarms re-emit SWARM_CREATE (empty) and call `onRestore(swarm)`.
   - The front calls `onDeviceRestored()`.
6. If restore fails (or the device is lost again during every retry), the
   core posts `error{DEVICE_LOST}`, the renderer becomes `destroyed`, and
   the front calls `onDeviceLost({ willRestore: false })`.

### 9.2 Resize and DPR

- The front (main thread, both modes) uses a `ResizeObserver` on the
  canvas, preferring `devicePixelContentBoxSize` for exact pixels, plus a
  `matchMedia('(resolution: Xdppx)')` listener for DPR changes. Both call
  `renderer.resize(cssW, cssH, res)`, which stores the size and emits
  RESIZE in the next submitted frame.
- Core on RESIZE:
  1. `backend.resize(round(cssW·res), round(cssH·res))` sets the canvas
     size and recreates size-dependent targets.
  2. RenderCore recreates the MSAA target and updates View.resolution and
     View.dpr.
- A zero size (hidden canvas) skips drawing but still acks frames.
- The ResizeObserver's device-pixel box is used only when it agrees with
  `cssSize · devicePixelRatio` within 1 px (it disagrees under DPR
  emulation); otherwise the renderer uses the CSS box and listens for
  ratio changes.

### 9.3 Teardown

`renderer.destroy()` rejects pending readbacks and picks with `DESTROYED`,
runs `FrontFrameHook.onRendererDestroyed()`, destroys the stage, the
packer, queued swarm destroys and texture upload records for that
renderer, then destroys the transport. The core destroys its systems, core
resources and the backend (deferred `device.destroy()`, §7). Tearing down
100k sprites takes ~2 ms.

## 10. Performance budgets

Reference machine: Apple M1/M2/M4 integrated GPU, Chrome stable. Bench
harness: `benchmarks/**`. The budgets are enforced as regression
thresholds.

| scenario                                                                                                     | budget                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Steady-state JS allocations per frame (all examples, both modes)                                             | **0** (heap-sampling bench asserts < 1 KB per 600 frames)                                                         |
| `render()` front CPU, 100k static sprites, nothing dirty                                                     | < 0.5 ms                                                                                                          |
| `render()` front CPU, 100k sprites all moving                                                                | < 6 ms (pack + transforms); M2 bulk API < 3 ms                                                                    |
| Sprite upload, 100k all moving                                                                               | ≤ 4 MB/frame, ≤ 8 writeBuffer calls                                                                               |
| Draw calls, sprites                                                                                          | one per contiguous (texture, blend) run                                                                           |
| Swarm 1M objects, velocity + acceleration + bounds (WebGPU)                                                  | ≥ 60 fps; front CPU < 0.3 ms/frame; packet < 1 KB/frame                                                           |
| Swarm 4M objects (discrete GPU, `limits: 'max'`)                                                             | ≥ 60 fps                                                                                                          |
| Swarm 250k objects on WebGL2 (integrated GPU)                                                                | ≥ 60 fps; front CPU < 0.3 ms/frame                                                                                |
| 100k moving sprites on WebGL2                                                                                | < 6 ms front CPU; ≥ 60 fps                                                                                        |
| Swarm spawn of 1M objects                                                                                    | one command, < 1 ms front CPU                                                                                     |
| `renderer.pick()`                                                                                            | ≤ 2 frames latency; 0 cost in frames without picks                                                                |
| Asset load of a 2048² PNG                                                                                    | no main-thread stall > 4 ms (decode off-thread, upload by transfer)                                               |
| Command overhead                                                                                             | 8 B header; typical command ≤ 64 B                                                                                |
| Worker mode                                                                                                  | ≤ 1 frame latency; main-thread busy loop of 8 ms must not drop core frames; 0 allocations per frame with the ring |
| `createRenderer` (excluding first pipeline compile)                                                          | < 150 ms                                                                                                          |
| Bundle (min+gzip), minimal program: createRenderer + Texture + Sprite, WebGPU, including the chunks it loads | ≤ 30 KB                                                                                                           |
| Bundle, same minimal program on WebGL2                                                                       | ≤ 30 KB                                                                                                           |
| Bundle, all exports (sum of every chunk)                                                                     | ≤ 45 KB                                                                                                           |
| Worker bundle: `dist/cozygpu.worker.js` + the backend chunk it loads                                         | ≤ 25 KB                                                                                                           |

M1 measurements (Apple M4, Chrome 152 headless; see
`docs/reports/M1.md` and `benchmarks/results/m1-final.md`): Swarm 1M
144 fps / 0.23 ms front CPU / 108 B packet; Swarm 2M beats Three TSL
compute by 16%; 100k static sprites 0.54 ms frame (0.03 ms CPU); 100k
moving sprites 1.46 ms frame (1.33 ms CPU, 8–16% behind the best
competitor); minimal program 28.4 KB, all exports 46.0 KB, worker bundle
20.0 KB; worker mode allocates 18–25 KB per frame (ring fixes it, §17);
Swarm 400–750 B per frame.

**M2 measurements (`node scripts/size.mjs`, Apple M4, Chrome 152).** The
four bundle budgets are **not met** and cannot be met at M2's code volume;
they are kept as written rather than quietly raised, and the size script
exits non-zero so the gap stays visible:

| fixture        | min+gzip | budget |
| -------------- | -------- | ------ |
| minimal-webgpu | 41.3 KB  | 30 KB  |
| minimal-webgl2 | 43.2 KB  | 30 KB  |
| all-exports    | 93.3 KB  | 45 KB  |
| worker-webgpu  | 31.7 KB  | 25 KB  |
| worker-webgl2  | 33.6 KB  | 25 KB  |

The integrator's M2 pass took minimal-webgpu from 52.0 KB to 41.3 KB and
the worker from 39.0 KB to 31.7 KB by making three things lazy: the assets
implementation (dropped from the `src/index.ts` barrel — `renderer.assets`
is the public path), the swarm core (`registerCoreSystemLoader`, so
`src/renderer/systems.ts` no longer statically imports it), and the worker
bundle (code-split, so it loads one backend instead of both). What remains
is the library's own front code, not packaging: in minimal-webgpu the entry
chunk is 28.4 KB gz, whose largest inputs are `sprites/front.ts` 16.5 KB,
`renderer/RenderCore.ts` 11.5 KB, `renderer/Renderer.ts` 8.7 KB,
`renderer/TextureRegistry.ts` 6.7 KB and `scene/bulk.ts` 4.4 KB (minified
bytes). Picking (`picking.ts` 1.5 KB + `pickingCore.ts` 3.2 KB minified,
~1.6 KB gz) could be made lazy too, but `pick()` would then miss the frame
it was called in, which is a worse trade than the bytes. Closing the rest
needs either a smaller front (M3) or budgets set to ~45 KB minimal and
~95 KB all exports.

Hot-path rules:

- No closures, arrays, objects, or `for…of` iterators per frame or per
  node. The decoder exposes whole-packet views plus absolute offsets
  (`reader.blob(n)`), so the core never creates views per command. The
  encoder may create one subarray per bulk upload.
- Use typed arrays and index loops.
- No string building per frame.
- Pipelines and bind groups are created on change, not per frame.

## 11. Source layout and ownership (M2)

The build phase runs in parallel. Each developer edits only their own
paths. **Shared files are frozen**; request changes via openIssues, and
the integrator applies them.

| owner                                        | paths                                                                                                                                                                                                                                                                                                                                                                                                                | delivers                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| webgl2                                       | `src/backend/webgl2/**`, GLSL counterparts for sprites `src/shaders/sprite/*.glsl`, `examples/basic/**`; RHI parity additions in `src/backend/webgpu/**` and `src/backend/utils.ts`                                                                                                                                                                                                                                  | WebGL2 backend (§13), sprite GLSL, WebGPU `readTexture` + compressed `writeTexture` + `copyExternalImage` origin, `auto` fallback verified in the browser                                              |
| assets                                       | `src/assets/**` except `types.ts`, `examples/assets/**`, core texture ops in `src/renderer/TextureRegistry.ts`                                                                                                                                                                                                                                                                                                       | `Assets`, `renderer.assets` proxy, format detection, KTX2, transcoder hook, atlas packer, LRU budget, device-loss reload, TEXTURE_UPLOAD_BITMAP_REGION / COMPRESSED / GENERATE_MIPMAPS in the registry |
| sprites                                      | `src/scene/**` except `types.ts`, `src/sprites/**`, `src/math/**`, `src/ticker/**`, `src/shaders/sprite/*.wgsl`, `examples/sprites/**`, `src/renderer/picking*`                                                                                                                                                                                                                                                      | bulk child API, incremental structure pass, `pickable` + pick ids, sprite pick pipelines, `createPickClient`, `createCorePicking`, `Texture.fromProvider`                                              |
| swarm                                        | `src/swarm/**` except `types.ts`, `src/shaders/swarm/**` (WGSL + GLSL), `examples/swarm/**`                                                                                                                                                                                                                                                                                                                          | WebGL2 transform-feedback swarms, GLSL composer and built-in behavior GLSL, behavior groups, allocation 'gpu', `aliveCount`, swarm `drawPick`, SWARM_SET_PICK                                          |
| worker+build                                 | `src/commands/**` (implementation; `opcodes.ts` and `types.ts` are frozen), `src/worker/**`, `src/renderer/createRenderer.ts`, `src/renderer/lazySystems.ts`, `src/renderer/systems.ts`, `rollup.config.cjs`, `scripts/**`, `examples/worker/**`                                                                                                                                                                     | SAB command ring (§17), dynamic imports and async core-system loaders (§18.1), shader minification (§18.2), size script (§18.3)                                                                        |
| integrator / architect (FROZEN during build) | `src/types/**`, `src/backend/types.ts`, `src/backend/createBackend.ts`, `src/scene/types.ts`, `src/swarm/types.ts`, `src/assets/types.ts`, `src/commands/opcodes.ts`, `src/commands/types.ts`, `src/renderer/RenderCore.ts`, `src/renderer/Renderer.ts`, `src/index.ts`, `docs/**`, `ROADMAP.md`, `README.md`, `package.json`, `tsconfig*.json`, `jest.config.cjs`, `jest.wgsl-transform.cjs`, `examples/index.html` | contracts, wiring, final integration                                                                                                                                                                   |

`benchmarks/**` and `tests/browser/**` have no M2 build owner; the
integrator runs them at the end of M2.

Cross-owner call graph (import only these entry points across owners):

```
renderer (frozen) → assets/proxy.ts:createAssetsProxy, renderer/picking.ts:createPickClient,
                    renderer/pickingCore.ts:createCorePicking, renderer/lazySystems.ts:isCoreSystemReady,
                    backend/createBackend.ts → import('./webgpu/WebGPUBackend') | import('./webgl2/WebGL2Backend')
assets   → scene/Texture.ts:Texture.fromProvider, types/core.ts:RendererHost/FrontFrameHook, commands (encoder)
sprites  → commands (encoder types), types/core.ts (FrontFrame, CustomDrawable, CorePicking, PickClient)
swarm    → scene/Texture.ts:ensureTextureUploaded, math/color.ts, commands, renderer/lazySystems.ts
worker   → renderer/RenderCore.ts:createRenderCore, renderer/systems.ts, commands
```

## 12. M2 overview

M2 widens reach (WebGL2), adds the asset loader and picking, closes the
M1 budget gaps (worker allocations, bundle size, moving-sprite CPU), and
adds GPU free lists to Swarm. The contracts for all of it are frozen now;
the implementation files are stubs that throw
`CozyGPUError('NOT_IMPLEMENTED')` (or answer requests with that code), so
`tsc` and `jest` pass while developers work in parallel.

Frozen M2 contract additions, by file:

| file                           | additions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/types.ts`         | `ShaderLanguage`; caps `shaderLanguage`, `transformFeedback`, `instancing`, `baseInstance`, `floatRenderTargets`, `integerRenderTargets`, `maxSampledTextures`, `textureCompression.bc7`; formats `r32uint`, `rg32uint` and 16 compressed formats; `ShaderSource.glsl.fragment?` + GLSL naming conventions; `FeedbackPipelineDesc`, `RhiFeedbackPipeline`, `FeedbackPass`, `CommandList.beginFeedbackPass`, `Backend.createFeedbackPipeline`; `Backend.readTexture`; `copyExternalImage(…, destX?, destY?)`; compressed `writeTexture` rules |
| `src/backend/createBackend.ts` | `'auto'` order and fallback, dynamic imports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/commands/opcodes.ts`      | `PROTOCOL_VERSION` 2; TEXTURE_UPLOAD_BITMAP_REGION, TEXTURE_UPLOAD_COMPRESSED, TEXTURE_GENERATE_MIPMAPS, PICK, SWARM_SET_PICK; compressed `TextureFormatId`s; `TEXTURE_MIP_LEVELS_SHIFT/MASK`; `ReadbackSource`; `CoreMessageType.PICK`                                                                                                                                                                                                                                                                                                      |
| `src/commands/types.ts`        | `FramePacket.buffer: ArrayBuffer \| SharedArrayBuffer`; `encoder.reset(ArrayBuffer \| SharedArrayBuffer)`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/types/core.ts`            | `FrontFrame.caps`, `FrontFrame.isSystemReady`; `CoreSystem.drawPick?`; `PickReplay`, `CorePicking`, `PickClient`; `FrontFrameHook`, `RendererHost`                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/types/transport.ts`       | `pick` message; `frameDone.buffer` union; `RingControl`, `RING_CONTROL_BYTES`; `init.ring?`; `ringSlot` message; `WorkerDoorbell`; `Transport.ring`; optional `code`/`message`/`frameSignal` documented as accepted                                                                                                                                                                                                                                                                                                                          |
| `src/types/renderer.ts`        | `PickHit`; `pick(): Promise<PickHit \| null>`; `renderer.assets`; `RendererOptions.assets`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/types/errors.ts`          | `ABORTED`, `LOAD_FAILED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/types/layouts.ts`         | `SI_PICK_SHIFT`, `SI_PICK_MAX`, `PICK_TARGET_FORMAT`, `PICK_RESULT_BYTES`, `PICK_ALPHA_THRESHOLD`, `SC_GROUP_SHIFT/MASK`, `SP_COLD_FLAGS`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/scene/types.ts`           | `SceneNode.pickable`, `NodeOptions.pickable`; `ContainerNode.bulkChildren`, `childrenVersion`; `BulkField`, `BulkChildren`; `TextureProvider`                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/swarm/types.ts`           | `SpawnOptions.group`; `BehaviorDefinition.glsl`, `.groups`; `allocation: 'gpu'`; `SwarmNode.aliveCount()`; `SWARM_GL_MAX_CAPACITY`, `SWARM_GL_WARN_CAPACITY`; `ComposedSwarmShaders.language`; composer `language` argument                                                                                                                                                                                                                                                                                                                  |
| `src/assets/types.ts`          | the whole asset API (§15)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Stub seams already wired into frozen files (developers only fill in their
own module): `src/renderer/picking.ts`, `src/renderer/pickingCore.ts`,
`src/assets/proxy.ts`, `src/assets/Assets.ts`,
`src/backend/webgl2/WebGL2Backend.ts`, the three `TextureRegistry` M2
methods, `isCoreSystemReady` in `lazySystems.ts`, `Container.bulkChildren`,
`NodeBase.pickable`, `Texture.fromProvider`, `Swarm.aliveCount`, and
WebGPU `readTexture`.

## 13. WebGL2 backend (M2)

Owner: webgl2. Files: `src/backend/webgl2/**`. It implements the same RHI
(`Backend`) so RenderCore and systems do not change; systems branch only
on capability flags.

### 13.1 Context and frame

- `canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true,
antialias: false, depth: false, stencil: false, preserveDrawingBuffer:
false, powerPreference })`. Works with HTMLCanvasElement and
  OffscreenCanvas (worker). DOM-free.
- `beginCommands()` returns a reused CommandList. WebGL executes
  immediately, so a "pass" binds state as calls arrive; `submit()` is a
  no-op apart from unbinding. `'canvas'` is the default framebuffer.
- MSAA (`sampleCount: 4`): a multisampled renderbuffer FBO; the pass with
  `resolveTarget: 'canvas'` blits to the default framebuffer at `end()`.
- `resize(pw, ph)` sets `canvas.width/height` and reallocates
  size-dependent renderbuffers.
- Blend presets map to `blendFunc` exactly as in §4. Clear color is
  premultiplied by the backend (straight RGBA in `clearColor`).

### 13.2 RHI method mapping

| RHI                                                 | WebGL2                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBuffer`                                      | `createBuffer`; target chosen from usage (VERTEX/INDEX/UNIFORM; STORAGE and INDIRECT throw UNSUPPORTED); `bufferData(size, DYNAMIC_DRAW)`                                                                                                                                                                         |
| `writeBuffer`                                       | `bufferSubData(target, offset, view, srcOffset, length)` (no copies; works with SAB views)                                                                                                                                                                                                                        |
| `readBuffer`                                        | `fenceSync` + `clientWaitSync` polled via `setTimeout`, then `getBufferSubData` into a new ArrayBuffer                                                                                                                                                                                                            |
| `createTexture`                                     | `texStorage2D` (immutable) with mip count; multisampled targets become renderbuffers; `r32uint`/`rg32uint` for picking                                                                                                                                                                                            |
| `writeTexture`                                      | `texSubImage2D` (UNPACK_ALIGNMENT 1) or `compressedTexSubImage2D` per level                                                                                                                                                                                                                                       |
| `copyExternalImage`                                 | `texSubImage2D(…, destX, destY, RGBA, UNSIGNED_BYTE, source)` with `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`, `UNPACK_FLIP_Y_WEBGL = flipY`, `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`                                                                                                                            |
| `generateMipmaps`                                   | `generateMipmap`                                                                                                                                                                                                                                                                                                  |
| `readTexture`                                       | FBO + `readPixels(RGBA_INTEGER, UNSIGNED_INT)` for integer formats, packed to the RHI's tight layout                                                                                                                                                                                                              |
| `createSampler`                                     | sampler objects (`bindSampler`)                                                                                                                                                                                                                                                                                   |
| `createShaderModule`                                | keeps `glsl` sources; rejects at pipeline creation when `glsl` is missing (UNSUPPORTED)                                                                                                                                                                                                                           |
| `createBindGroupLayout` / `createBindGroup`         | plain records; groups resolve to UBO bindings and texture units at pipeline link                                                                                                                                                                                                                                  |
| `createRenderPipeline`                              | compile + link (`KHR_parallel_shader_compile` polled when present, so it stays async), bind uniform block indices and sampler units from the naming convention, record attribute layout, topology, blend                                                                                                          |
| `createComputePipeline` / `beginComputePass`        | reject / throw UNSUPPORTED                                                                                                                                                                                                                                                                                        |
| `createFeedbackPipeline`                            | `transformFeedbackVaryings(varyings, INTERLEAVED_ATTRIBS)` before link; `RASTERIZER_DISCARD` during runs                                                                                                                                                                                                          |
| `setVertexBuffer` + `draw(v, n, fv, firstInstance)` | VAO per pipeline; `vertexAttribPointer` / `vertexAttribIPointer` (uint32) / normalized UNSIGNED_BYTE/SHORT; `vertexAttribDivisor(1)` for instance step; `drawArraysInstanced`. Non-zero `firstInstance` without `baseInstance`: re-point instance attributes with `offset + firstInstance × stride` for that draw |
| `drawIndirect` / `dispatch*`                        | throw UNSUPPORTED                                                                                                                                                                                                                                                                                                 |
| `setBindGroup(i, g, dynamicOffsets)`                | `bindBufferRange(UNIFORM_BUFFER, index, buf, offset, size)`, `activeTexture` + `bindTexture` + `bindSampler`                                                                                                                                                                                                      |
| `setScissor` / `setViewport`                        | `scissor` (+ `enable(SCISSOR_TEST)`) / `viewport` with y flipped                                                                                                                                                                                                                                                  |

### 13.3 Shader strategy (normative)

- Hand-written **GLSL ES 3.0** counterparts live next to the WGSL:
  `src/shaders/sprite/sprite.vert.glsl`, `sprite.frag.glsl`,
  `sprite.pick.frag.glsl`; swarm templates under `src/shaders/swarm/`.
  They are imported as strings (`declare module '*.glsl'`; Jest and Rollup
  load `.glsl` like `.wgsl`).
- A system passes **both** sources in one `ShaderSource`
  (`{ wgsl, glsl: { vertex, fragment } }`); the backend uses the one for
  `caps.shaderLanguage`. Sprite GLSL is small enough to ship statically.
  Large GLSL (the swarm templates) is loaded with a dynamic import only
  when `caps.shaderLanguage === 'glsl300es'`, so WebGPU pages don't carry
  it.
- Binding names: uniform block `G{group}_B{binding}` (std140), texture
  `G{group}_B{binding}` (`sampler2D` / `usampler2D`); a `sampler` entry at
  binding b + 1 applies to the texture at b. Attributes use
  `layout(location = n)`. Fragment output `layout(location = 0) out`.
  Clip-space y is the same as WGSL (both are y-up in NDC); the backend
  flips nothing in shaders.
- Behavior of a GLSL counterpart must match its WGSL twin pixel for pixel
  at 1x (premultiplied output, same UV math, same `unpack4x8unorm`
  equivalent: `vec4(color) / 255.0` from `unorm8x4` attributes).

### 13.4 Capabilities and ceiling

`compute`, `storageBuffers`, `vertexStorage`, `indirectDraw` are false.
Sprites, textures, MSAA and picking work fully. Swarm uses transform
feedback with capacity ≤ `SWARM_GL_MAX_CAPACITY` (4M; warns above 1M) and
only behaviors with a `glsl` variant (§14.2). Allocation `'gpu'` and
`render.cull` are unsupported on WebGL2.

### 13.5 Backend selection (normative)

`createBackend(canvas, { preference })` (`src/backend/createBackend.ts`):

- `'webgpu'` or `'webgl2'`: that backend only; its error propagates.
- `'auto'` (default): if `navigator.gpu` exists, try WebGPU. On any error
  except `INVALID_ARGUMENT` (no adapter, `requestDevice` failure, context
  failure) try WebGL2. If WebGL2 also fails, the WebGPU error is thrown
  when it is more informative (WebGL2 `UNSUPPORTED` or `NOT_IMPLEMENTED`),
  else the WebGL2 error. Without `navigator.gpu`, WebGL2 is tried directly.
- The WebGPU backend acquires its device **before** `getContext('webgpu')`
  (§7), which is what keeps the fallback possible.
- `renderer.info.backend` reports the result. Worker mode runs the same
  selection inside the worker.
- When `'auto'` ends up on WebGL2, `createBackend` sets
  `Backend.fallbackReason` to why WebGPU was not used
  (`'navigator.gpu is not available'`, or `'WebGPU init failed: …'`). It
  travels with the core's `ready` message and surfaces as
  `renderer.info.fallbackReason` (undefined on WebGPU and whenever the
  backend was requested explicitly). Diagnostics only — never branch on the
  text.

### 13.6 Context loss

`webglcontextlost` (call `preventDefault()`) → `onDeviceLost({ reason:
'unknown' })`. `restore()` waits for `webglcontextrestored` (up to 3
attempts, 0/500/2000 ms, also trying `WEBGL_lose_context.restoreContext()`
in debug), then recreates the GL program cache. The §9.1 flow is
unchanged.

## 14. Swarm in M2: WebGL2 and GPU free lists

Owner: swarm.

### 14.1 Front selection

`_emitDraw` reads `frame.caps`. With `caps.compute && caps.vertexStorage`
it composes WGSL (M1 path). With `caps.transformFeedback` it composes GLSL
(`composeSwarmShaders(behaviors, flags, 'glsl300es')`) after loading the
GLSL templates by dynamic import (`frame.isSystemReady`-style polling: emit
nothing until loaded). If a behavior lacks `glsl`, or allocation is
`'gpu'`, or capacity exceeds `SWARM_GL_MAX_CAPACITY`, the swarm is disabled
for that renderer: one `console.error` with `[cozygpu:UNSUPPORTED]` or
`[cozygpu:OUT_OF_CAPACITY]` naming the reason, nothing is drawn, and
readbacks reject with that code. The SWARM_CREATE payload is unchanged; the
GLSL strings use the `//@STAGE` section format of `ComposedSwarmShaders`.

### 14.2 WebGL2 simulation (transform feedback)

Per swarm on the core:

| object                   | contents                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| hotA, hotB               | VERTEX buffers, capacity × 40, ping-pong (`src` / `dst`)           |
| cold                     | VERTEX buffer, capacity × 16                                       |
| frames                   | RGBA32F texture (w = frame count) or a std140 UBO when ≤ 64 frames |
| params, sim, draw, spawn | UBOs (std140 = the WGSL layouts, §4.5)                             |

Frame, in the compute phase and stream order:

- **SPAWN**: a feedback run with no input attributes, `gl_VertexID`
  ranging `[first, first + count)`, writing hot records into `src` at
  `first × 40` (`run(src, first·40, first, count)`), then a second run
  writing cold records (`uvec4` varying) into `cold`. The GLSL spawn
  program reproduces `cs_spawn` exactly (same hash32/rand01).
- **KILL_RANGE / KILL_LIST**: `writeBuffer` of zeroed 40-byte records (or
  the 4-byte `life` word per listed index) into `src`. Kill lists are
  small by contract; ranges write one zero block.
- **STEP**: `run(dst, 0, 0, activeCount)` reading `src` + `cold` as
  attributes, then swap. Substeps alternate buffers. Deaths behave as in
  WGSL.
- **DRAW**: instanced draw of `activeCount` with `src` (hot) and `cold` as
  instance attributes (`vertexAttribDivisor(1)`) and a 6-vertex quad from
  `gl_VertexID`; dead slots collapse like §6.4.
- Behavior params: the GLSL composer emits one std140 block
  `G2_B3 { … } params;` whose member offsets equal the WGSL composer's, so
  `SWARM_SET_PARAMS` is backend-agnostic. `$params.x` becomes `params.x`
  (flattened names `<behavior>_<param>` are allowed if the offsets match;
  the composer test asserts equality with the WGSL layout).
- `readHot`/`readCold`: `readBuffer` of `src`/`cold`. `aliveCount()` reads
  hot and counts `life > 0` on the core (CPU) before posting a 4-byte
  result.
- Capacity: `capacity × 40 × 2 ≤ caps.maxBufferSize`, hard cap
  `SWARM_GL_MAX_CAPACITY`. Throughput is bounded by per-frame feedback over
  every active slot; the budget target is 250k at 60 fps on integrated
  GPUs.

### 14.3 WebGPU: GPU free list and compacted drawIndirect

`allocation: 'gpu'` (WebGPU only):

| buffer            | contents                                                                             |
| ----------------- | ------------------------------------------------------------------------------------ |
| free              | `array<u32>` capacity; initialised to `[capacity-1 … 0]` by a compute pass at create |
| freeTop           | `atomic<u32>` in a storage struct (free count)                                       |
| alive             | `array<u32>` capacity (compacted indices, rebuilt each step)                         |
| aliveCount + args | `atomic<u32>` + indirect draw args (vertexCount 6, instanceCount, 0, 0)              |

- **Deaths** in `cs_step` (life, bounds kill, `p.life = 0.0` from a
  behavior): `let k = atomicAdd(&freeTop, 1u); free[k] = i;` (atomicAdd
  returns the old value, so k is unique per invocation). The slot is also
  marked dead.
- **Alive compaction** in the same step: `let a = atomicAdd(&aliveCount,
1u); alive[a] = i;` for survivors; a final 1-invocation pass writes
  `args.instanceCount = aliveCount`. `render.cull` adds the off-screen test
  here.
- **Spawn** of n: `cs_spawn_gpu` reads `top = atomicLoad(&freeTop)` at the
  start (uniform snapshot written by a 1-invocation pre-pass into the
  spawn params), and for `k < min(n, top)` initialises slot
  `free[top - 1 - k]`. A 1-invocation commit pass then sets
  `freeTop = top - min(n, top)`. Spawns beyond the free count are dropped.
  `spawn()` returns 0 on the front.
- **KILL_RANGE / KILL_LIST** set `life = 0` and push the slots (only for
  slots that were alive, so a slot is never pushed twice).
- Dispatch covers `[0, capacity)`; draw is `drawIndirect` over `alive`.
  The vertex shader indexes `hot[alive[instance]]`.
- `aliveCount()` reads back `aliveCount` via READBACK srcKind 3
  (`ReadbackSource.SWARM_ALIVE`).
- The internal render flag bit for `'gpu'` lives in
  `SwarmInternalRenderFlag` (bits ≥ 8 of renderFlags; swarm-internal).

### 14.4 Behavior groups

`SpawnOptions.group` (0–255) is written through `SP_COLD_FLAGS` into
`cold.flags` bits 8–15. A behavior with `groups` set is wrapped by the
composer as `if (((c.flags >> 8u) & GROUPS) != 0u) { … }` (GLSL likewise).
Groups are compile-time, so changing a behavior's groups recompiles.

### 14.5 Swarm picking

`swarm.pickable = true` makes the front emit `SWARM_SET_PICK(swarmId,
node.id)` once (and 0 when set false). The core's `drawPick` uses a pick
render pipeline (same vertex path, fragment writes
`vec2u(pickId, instance_index + 1)` after the alpha test; circles use the
SDF coverage). The instance index is the slot (`alive[instance]` for
`'gpu'`).

## 15. Asset loader (M2)

Owner: assets. Contract: `src/assets/types.ts`. Public entry:
`renderer.assets` and `new GPU.Assets(renderer, options)`.

### 15.1 Where loading happens (decision)

**Loading, parsing, caching and refcounts live on the front (main thread)
in both renderer modes.** Pixels travel to the core by transfer:

- Images: `fetch` → `Blob` → `createImageBitmap(blob, { premultiplyAlpha:
'none', colorSpaceConversion: 'none' })`, which browsers decode off the
  main thread. The bitmap is added to the packet with
  `encoder.addObject(bitmap, true)` (**transfer**) and uploaded with
  `TEXTURE_UPLOAD_BITMAP` (or `_REGION` into an atlas page). After the
  frame is submitted the front holds no pixels.
- KTX2: parsed on the front (header, level index, DFD; a few KB). Each
  level's bytes are copied once into its own ArrayBuffer (or come from the
  transcoder) and transferred with `TEXTURE_UPLOAD_COMPRESSED`.
- JSON, text, binary: kept in front memory.

Why not load inside the worker: the front needs sizes and metadata
synchronously (Texture handles, atlas packing, spritesheet frames), the
cache and refcounts are part of the main-thread API, one implementation
serves both modes, decoding is already off-thread, and transfer is
zero-copy. A heavy transcoder runs in its own worker behind the
`TextureTranscoder` hook.

`renderer.assets` is `createAssetsProxy()` (`src/assets/proxy.ts`), which
Renderer.ts imports statically. It must stay under 1 KB and load
`./Assets` with a dynamic import on the first async call; until then
`get` returns undefined, `has` false, and `stats` zeros. The implementation
registers a `FrontFrameHook` through `RendererHost._addFrameHook`.

### 15.2 Format detection

`detectFormat(url, head?)` is a pure function. The extension of the URL
path (query and hash stripped) gives a first guess; the first 16 bytes
confirm or override it:

| format | magic                                             |
| ------ | ------------------------------------------------- |
| png    | `89 50 4E 47 0D 0A 1A 0A`                         |
| jpeg   | `FF D8 FF`                                        |
| gif    | `47 49 46 38`                                     |
| webp   | `52 49 46 46 ?? ?? ?? ?? 57 45 42 50`             |
| avif   | bytes 4–7 `66 74 79 70` and brand `avif` / `avis` |
| ktx2   | `AB 4B 54 58 20 32 30 BB 0D 0A 1A 0A`             |
| basis  | `73 42`                                           |
| json   | first non-whitespace byte `{` or `[`              |

Unknown binary with a known image extension still goes through
`createImageBitmap`; a decode failure rejects `LOAD_FAILED`. A JSON with
`frames` and `meta.image` is a spritesheet; its image URL resolves
relative to the JSON.

### 15.3 Textures and compressed formats

- Image formats: png, jpeg, webp, avif, gif (first frame).
- KTX2 native formats map `vkFormat` to `TextureFormat` (BC1/3/4/5/7,
  ETC2/EAC, ASTC 4×4, RGBA8 incl. sRGB). A format the renderer's caps
  don't support is transcoded if a transcoder is configured, else rejects
  `UNSUPPORTED`.
- KTX2 with `vkFormat = 0` (Basis Universal ETC1S or UASTC) or zstd
  supercompression needs `AssetsOptions.transcoder`. The hook is called
  lazily once, then `transcode({ data, container, targets })` with targets
  ordered from caps: `astc-4x4-unorm` > `bc7-rgba-unorm` >
  `etc2-rgba8unorm` > `bc3-rgba-unorm` > `rgba8unorm`. **No WASM is
  bundled in M2.**
- Creation: `TEXTURE_CREATE(texId, w, h, formatId, flags | levels << 24)`
  without `RETAIN_SOURCE`, then one upload per level.
- Mipmaps: images with `mipmaps` get `MIPMAPS` and GPU generation;
  atlas pages get `TEXTURE_GENERATE_MIPMAPS` after region uploads (at most
  once per page per frame); compressed files use their own levels.
- `keepPixels`: the bitmap is drawn to an OffscreenCanvas 2D context once
  to read straight RGBA8 before transfer. `hitMask`: same read, then a
  1-bit mask is built and the pixels dropped.

### 15.4 Cache, refcounts, bundles, concurrency

- Cache key = alias or resolved URL. `load` of a cached key returns a new
  handle immediately (adds a reference); concurrent loads share one
  in-flight promise.
- `AssetHandle.release()` removes one reference. At zero, memory assets
  are dropped; GPU assets stay cached (LRU order by last draw use, via
  `TextureProvider.upload` calls) until evicted or `unload`ed.
- `addBundle(name, { alias: source })` + `loadBundle(name, { onProgress,
signal })`; progress counts entries (textures count when uploaded).
- Concurrency: at most `concurrency` (default 6) fetch+decode jobs; the
  rest wait FIFO (`preload` jobs go last). Uploads are rate-limited to
  about 64 MB of texels per frame to avoid long GPU stalls.
- Abort: `signal` rejects with `ABORTED`, releases references this call
  acquired, and cancels fetches that no other caller waits for.

### 15.5 Core side

`src/renderer/TextureRegistry.ts` (owner assets in M2) implements
`uploadBitmapRegion`, `uploadCompressed`, `generateMipmaps`, compressed
`textureFormatFromId` entries and explicit mip counts. RenderCore routes
the opcodes (already wired). Compressed uploads use the RHI's
`writeTexture` per level. Nothing is retained for GPU-only textures.

### 15.6 Scene seam: TextureProvider

Asset textures are `Texture.fromProvider(provider)` handles
(`src/scene/types.ts: TextureProvider`). `ensureTextureUploaded(frame,
texture)` calls `provider.upload(frame)` instead of emitting bitmap
uploads; `false` means "not ready" and the batch draws with the white
texture (`NO_ID`) that frame. Atlas-packed images are `sub()` frames of the
page provider, so sprites batch. Destroying the last handle calls
`provider.release()`.

### 15.7 GPU memory budget, eviction, device loss

- Estimated bytes: uncompressed `w × h × 4 × (mips ? 4/3 : 1)`;
  compressed: sum of level byte lengths. Atlas pages count once; packed
  images report their area share.
- When over `gpuBudgetMB`, zero-reference entries are evicted in LRU
  order: `TEXTURE_DESTROY`, state `'evicted'`, URL kept. A later `load`
  reloads from the URL (HTTP cache). Referenced textures are never
  evicted; a warning is logged once if they alone exceed the budget.
- Atlas packing: skyline packer (pure, Node-tested) into `pageSize²`
  pages with `padding`; images ≤ `maxImageSize` on both sides, not
  `repeat`, not `keepPixels`, not KTX2. Freed rectangles are not reused
  in M2; a page is destroyed when all its images are released and
  evicted.
- Device loss: on `onDeviceRestored`, every referenced GPU asset is
  reloaded from its URL (fetch, decode, transfer again); providers return
  `false` until their upload is encoded, so sprites draw white briefly.
  Zero-reference entries are simply dropped.

## 16. Sprites in M2: bulk API, incremental structure, picking

Owner: sprites.

### 16.1 Bulk child transforms

```ts
const bulk = container.bulkChildren(GPU.BulkField.POSITION);
for (let i = 0; i < bulk.count; i++) {
  bulk.position[i * 2] += vx[i] * dt;
  bulk.position[i * 2 + 1] += vy[i] * dt;
}
bulk.commit(GPU.BulkField.POSITION);
```

- `bulkChildren(fields)` returns the container's reused writer with dense
  arrays indexed by child index, sized for the requested fields only.
  Unrequested arrays are zero-length. `pull()` copies current values in.
- `commit(fields, first, count)` copies into `nodeStore` in one tight
  loop over the children's slots, sets dirty bits in bulk and bumps
  `touch` once. A POSITION-only commit sets `Dirty.POSITION`, so the
  packer takes the §5.2 fast path over the whole run.
- `childrenVersion` bumps on any child add, remove or reorder; `commit`
  with a stale writer throws `INVALID_ARGUMENT`.
- Budget: 100k moving sprites < 3 ms front CPU with the bulk path.

### 16.2 Incremental structure pass

Internal (no contract). Instead of a full rebuild on every
`structureVersion` bump, containers record structural edits (first
affected child index). When every edit since the last pack is local
(add/remove/reorder/visibility inside containers whose subtree span is
known, texture or blend changes that don't cross a batch edge), the packer
rebuilds only the affected flat span: it shifts the tail of the flat
arrays and instance bytes with `copyWithin` when the instance count
changes, re-marks instances from the first changed index as dirty, and
patches the batch list around the span. Anything else falls back to a full
rebuild. Invariant tests (`dirty.property.test.ts`) must compare the
incremental result with a full rebuild byte for byte.

### 16.3 Picking

Front (`src/renderer/picking.ts`, `createPickClient`):

- `renderer.pick(x, y)` allocates a requestId (`ids.readback`), queues it,
  and returns a promise. `encode(frame)` emits `PICK(requestId, x, y)` for
  queued requests in the next `render()`.
- On `pick{objectId, instance}` it resolves the node by id (a live-node
  lookup, e.g. a slot table maintained by `NodeBase`; a stage walk is
  acceptable) and returns `{ node, instance, x, y }`, or null when
  `objectId` is 0 or the node is gone. `code` set → reject with it.
- `rejectAll` on device loss and destroy.

Sprite packing: `SI_FLAGS` bits 8–31 get `node.id` when `pickable` (§4.1);
toggling `pickable` sets `Dirty.SPRITE`.

Core (`src/renderer/pickingCore.ts`, `createCorePicking`), created on the
first PICK:

- Owns one 1×1 `rg32uint` texture (RENDER_TARGET | COPY_SRC), up to 4
  pick View uniform buffers + bind groups (distinct buffers, because
  writes to one range collapse), and requests FIFO (≤ 4 per packet; the
  rest wait for the next packet).
- Pick View = the frame's View with `translate -= (x, y)` and
  `resolution = (1, 1)`: css pixel `(x, y)` covers clip space of the 1×1
  target. `SET_VIEW` transforms are included because they are part of
  col0/col1/translate.
- `render(list, replay, frame)`: for each request, one render pass on the
  pick texture (`load: 'clear'`, clear 0), then
  `replay.drawPick(i, pass, viewGroup)` for `i < replay.drawCount`.
  Systems draw their DRAW commands with pick pipelines (§4.7, §14.5).
  Sprites' pick fragment: `textureSample(...).a * color.a >= 0.5` else
  discard, output `vec2u(pickId, 0u)`.
- `afterSubmit()`: `backend.readTexture(tex, 0, 0, 1, 1)` per rendered
  request; post `pick{requestId, objectId, instance: second - 1}`. A
  second request in the same frame must use its own texture (or wait for
  the previous readback), because the texture is overwritten.
- Pick pipelines are created lazily on the first request (async); requests
  that arrive earlier wait (answered at most 2 frames later).
- `failAll(code)` answers everything with objectId 0 and the code.

## 17. Worker command ring (M2)

Owner: worker+build. Goal: **zero allocations per frame** in worker mode
(M1: 18–25 KB/frame from transferred buffers, per-packet decoder views and
`frame` message clones).

- Enabled when `crossOriginIsolated` (same condition as `sharedMemory`).
  The transport allocates `ring` = 2 SharedArrayBuffer slots (64 KiB
  each, grown ×2 on demand) and a 16-byte control block
  (`init.frameSignal`, `RingControl`).
- Front, per frame: `takeRecycledBuffer()` returns a free slot (one that
  is not in flight); the encoder writes the packet into it;
  `submit(packet)` stores `SUBMITTED_SLOT`, `SUBMITTED_FRAME_ID`,
  `SUBMITTED_BYTE_LENGTH` with `Atomics.store` and posts the slot index as
  a bare number (`WorkerDoorbell`). `busy` compares
  `ACK_FRAME_ID` with the submitted frameId (M1 frame signal).
- Worker host: on a number message it builds (once per slot, cached) a
  `FramePacket` over the slot, calls `core.execute(packet)`, stores
  `ACK_FRAME_ID`, and **does not post `frameDone`** for ring packets.
- The decoder caches views per buffer (§3.6), `packet.objects` is a
  reused empty array, and the core reads nothing from the slot after
  `execute()` returns (uploads copy synchronously), so the front may
  re-encode into it immediately after the ack.
- Growth: when a packet outgrows its slot the encoder switches to an
  ArrayBuffer; the transport sends that frame on the transfer path and
  replaces the slot with a SharedArrayBuffer of the new size through
  `ringSlot{slot, buffer}` (rare, allocation only on growth).
- Packets with `objects` (ImageBitmaps, level buffers, shared-store
  registrations) always use the transfer path.
- Without isolation nothing changes (transfer path, `ring: false`).
- **Core rule:** anything that turns packet bytes into a string must go
  through `reader.utf8(n)`, which copies out of the slot first. A
  `TextDecoder` over a view into a SharedArrayBuffer throws in Blink ("must
  not be shared") but not in Node, so a core that decodes by hand passes
  every unit test and then drops that command on every ring page. Both swarm
  cores did exactly this with `SWARM_CREATE`;
  `swarm.stream.test.ts` now emulates Blink's rule to keep it caught.
- **Dev hook.** `WorkerInboundMessage` has `{ type: 'debug', action:
'loseDevice' }` and `Transport.debug?(action)`, so a page can drive a
  core-side debug action that only `globalThis.__COZYGPU_CORE__` could reach
  on the main thread. The core ignores it unless it was created with
  `debug: true`. This is what makes device loss testable in worker mode
  (`examples/basic/?lose=1&debug=1&worker=1`).

## 18. Bundle and build (M2)

Owner: worker+build (`rollup.config.cjs`, `scripts/**`,
`src/renderer/createRenderer.ts`, `src/renderer/lazySystems.ts`).

### 18.1 Dynamic imports

| module                                     | loaded by            | when                               |
| ------------------------------------------ | -------------------- | ---------------------------------- |
| `backend/webgpu/WebGPUBackend`             | `createBackend`      | WebGPU selected (done)             |
| `backend/webgl2/WebGL2Backend`             | `createBackend`      | WebGL2 selected or fallback (done) |
| `worker/WorkerTransport`                   | `createRenderer`     | `worker: true`                     |
| `swarm/core`                               | `lazySystems` loader | first swarm command in local mode  |
| swarm GLSL templates                       | swarm front          | first swarm on a GLSL renderer     |
| `assets/Assets`                            | `assets/proxy`       | first async `renderer.assets` call |
| `renderer/pickingCore` pipelines / shaders | picking              | first pick (optional)              |

- ESM output (`dist/`) uses code splitting (`output.dir`, chunk names
  `chunks/[name]-[hash].js`). The CJS build and the example builds use
  `inlineDynamicImports: true`. **The worker bundle is code-split too**
  (`dist/cozygpu.worker.js` + `dist/chunks/worker-*`): module workers
  support `import()`, `worker: { url }` still points at the one entry file,
  and inlining made every worker ship both backends (~18 KB gz) to use one.
- The assets implementation is **not** exported from `src/index.ts`. A value
  export there makes `Assets.ts` statically reachable, so no bundler can ever
  split it (measured: +10.2 KB gz on the minimal program). The public path is
  `renderer.assets` (the < 1 KB proxy) and `RendererOptions.assets`; only
  `export type` entries come from `./assets`.
- Async core systems: `registerCoreSystemLoader(range, () =>
import('./core').then(m => m.createSwarmCoreSystem))` in `src/swarm/Swarm.ts`
  replaces the synchronous factory. `src/renderer/systems.ts` must not
  statically import a core it wants split: `createDefaultCoreSystems()` and
  `createLocalCoreSystems()` both hand out a `LazyCoreSystem` for the swarm
  range, and the **worker entry** registers the real factory eagerly
  (`src/worker/entry.ts`), because the front never waits on `isSystemReady`
  in worker mode. `isCoreSystemReady(range)` is true once
  loaded; the first call starts the import. Front code checks
  `frame.isSystemReady(range)` and emits nothing for that range until it
  is true (commands stay queued on the front). Worker mode is always
  ready (eager worker bundle).
- Rule for front modules on the minimal path (`Renderer`, `Container`,
  `Sprite`, `Texture`, sprite core, WebGPU backend): never statically
  import swarm, assets implementation, WebGL2, or worker code.

### 18.2 Shader minification

A Rollup plugin (in `rollup.config.cjs`) transforms `*.wgsl` and `*.glsl`
before `rollup-plugin-string`: remove `/* */` and `//` comments **except
lines whose trimmed text starts with `//@`** (composer markers such as
`//@SLOT`, `//@STAGE`), collapse runs of spaces and blank lines, and keep
a newline after every `//@` line and every GLSL preprocessor line
(`#version` stays first). Identifiers are not renamed. Jest keeps loading
the raw sources, so composer tests see comments; a unit test runs the
minifier over every shader and checks the markers survive and the
composer still works.

### 18.3 Size check

`scripts/size.mjs` builds fixtures with Rollup + esbuild minify, gzips
each chunk and reports JSON plus a table:

| fixture                                            | counts                                        | budget  |
| -------------------------------------------------- | --------------------------------------------- | ------- |
| minimal-webgpu (createRenderer + Texture + Sprite) | entry + chunks loaded when WebGPU is selected | ≤ 30 KB |
| minimal-webgl2                                     | entry + chunks loaded when WebGL2 is selected | ≤ 30 KB |
| all-exports (`import * as GPU` using every export) | every chunk                                   | ≤ 45 KB |
| worker-webgpu                                      | worker entry + the WebGPU backend chunk       | ≤ 25 KB |
| worker-webgl2                                      | worker entry + the WebGL2 backend chunk       | ≤ 25 KB |

It exits non-zero when a budget is exceeded (all five are over today —
§10 has the numbers and the reason). `npm run size` is the same thing. `benchmarks/build.mjs
--sizes` stays as the cross-library comparison.

## 19. Later milestones (design notes only)

The following are **not** part of M2.

- **Masking (M3).** Stencil masks, plus scissor for axis-aligned rects.
- **Filters and effects (M3).** Render-to-texture passes (blur, color
  matrix, bloom) on containers, with a pooled render-target cache.
- **MSDF text (M3).** Atlas from the asset loader; glyph quads batch
  through the sprite path with an MSDF fragment variant (flag bit).
- **Particles on Swarm (M3).** Emitters (rate, burst, shape) implemented
  as `spawn()` schedules, plus color and size curves baked into small
  1D textures sampled by age/life.
- **Per-renderer dirty tracking.** Dirty bits are process-wide, so one
  node tree drawn by two renderers can miss updates.
- **Bounds readback, camera API** (`SET_VIEW` from a public camera),
  custom blend factors, render-to-texture API, WebGPU compatibility-mode
  swarm fallback via transform-style ping-pong textures.
