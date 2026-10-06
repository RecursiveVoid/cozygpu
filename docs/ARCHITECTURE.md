# cozygpu architecture

Status: **M2.5** (M1, M2 and the M2.5 integration hooks are built;
§13–§19 describe them as built). Sections marked _normative_ are binding;
code in `src/types/**`, `src/backend/types.ts`,
`src/scene/types.ts`, `src/swarm/types.ts`, `src/assets/types.ts`,
`src/commands/opcodes.ts`, and `src/commands/types.ts` mirrors them. If the
code and this document disagree, the document is the reference; fix one of them.

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
- [11. Source layout](#11-source-layout)
- [12. M2 overview](#12-m2-overview)
- [13. WebGL2 backend (M2)](#13-webgl2-backend-m2)
- [14. Swarm in M2: WebGL2 and GPU free lists](#14-swarm-in-m2-webgl2-and-gpu-free-lists)
- [15. Asset loader (M2)](#15-asset-loader-m2)
- [16. Sprites in M2: bulk API, incremental structure, picking](#16-sprites-in-m2-bulk-api-incremental-structure-picking)
- [17. Worker command ring (M2)](#17-worker-command-ring-m2)
- [18. Bundle and build (M2)](#18-bundle-and-build-m2)
- [19. Integration hooks (M2.5)](#19-integration-hooks-m25)
- [20. Later milestones (design notes only)](#20-later-milestones-design-notes-only)

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
it does not dispatch events. cozygpu stays a pure graphics wrapper with zero
runtime dependencies: an ECS or an event bus plugs in only through the
library-neutral M2.5 hooks (§19), which are "register once, commit per
frame", allocate nothing per frame and expose no GPU types.

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

0. M2.5: `CorePicking.poll()` answers picks whose readback slot is ready
   (§19.6). Allocation-free; a no-op without picks in flight.
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
   signal) or the ring control block (§17). While readbacks are paced
   (§7.1) and the GPU is behind, the acknowledgement waits for the GPU, so
   the transport stays busy and the front skips frames.

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
(encoder, decoder, reader). `PROTOCOL_VERSION` is **3** since M2.5
(SWARM_SET_SOURCE, the rgba32uint pick texel); it was 2 in M2. The front and
the worker bundle must be built from the same version.

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

| off | type | field                                                                |
| --- | ---- | -------------------------------------------------------------------- |
| 0   | u16  | opcode (high byte = system range)                                    |
| 2   | u16  | flags: bit0 `DRAW`, bit1 `COMPUTE`, bit2 `PASS_BREAK` (M3), others 0 |
| 4   | u32  | payloadBytes (padded, multiple of 4)                                 |

Example: `SPRITE_DRAW(bufferId=1, first=0, count=500, texId=3, blend=normal)`
is 28 bytes:

```
10 02  01 00  14 00 00 00  01 00 00 00  00 00 00 00  F4 01 00 00  03 00 00 00  00 00 00 00
op     flags  payload=20   bufferId=1   first=0      count=500    texId=3      blend=0
```

### 3.4 Opcodes

Ranges: `0x00` core, `0x01` texture, shared memory, readback and picking
(all handled by RenderCore), `0x02` sprite, `0x03` swarm, `0x04` mask (M3),
`0x05` filter (M3), `0x06–0x7F` reserved, `0x80–0xFF` extensions. Unknown
opcodes are skipped using `payloadBytes`, with one warning per opcode.

The flags column lists every bit a command carries; `DRAW+PASS_BREAK`
(M3, §21.3) means the core ends the open render pass before the command and
asks the owning system which pass to open next.

| opcode | name                         | flags           | payload                                                                                                                       |
| ------ | ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0x0000 | NOP                          |                 | —                                                                                                                             |
| 0x0001 | FRAME_BEGIN                  |                 | f32 time, f32 dt                                                                                                              |
| 0x0002 | RESIZE                       |                 | f32 cssWidth, f32 cssHeight, f32 resolution                                                                                   |
| 0x0003 | SET_CLEAR_COLOR              |                 | f32 r, g, b, a (straight)                                                                                                     |
| 0x0004 | SET_VIEW                     |                 | f32 a, b, c, d, tx, ty (stage → css px)                                                                                       |
| 0x00FF | FRAME_END                    |                 | —                                                                                                                             |
| 0x0100 | TEXTURE_CREATE               |                 | u32 texId, width, height, formatId, texFlags (bits 24–31: mip level count, M2)                                                |
| 0x0101 | TEXTURE_UPLOAD_PIXELS        |                 | u32 texId, x, y, w, h, u8[w·h·4]                                                                                              |
| 0x0102 | TEXTURE_UPLOAD_BITMAP        |                 | u32 texId, objectIndex, flipY                                                                                                 |
| 0x0103 | TEXTURE_DESTROY              |                 | u32 texId                                                                                                                     |
| 0x0104 | TEXTURE_UPLOAD_BITMAP_REGION |                 | M2. u32 texId, objectIndex, x, y, flipY                                                                                       |
| 0x0105 | TEXTURE_UPLOAD_COMPRESSED    |                 | M2. u32 texId, mipLevel, width, height, objectIndex (ArrayBuffer), byteOffset, byteLength                                     |
| 0x0106 | TEXTURE_GENERATE_MIPMAPS     |                 | M2. u32 texId                                                                                                                 |
| 0x0110 | SHARED_REGISTER              |                 | u32 sharedId, objectIndex                                                                                                     |
| 0x0111 | SHARED_RELEASE               |                 | u32 sharedId                                                                                                                  |
| 0x0120 | READBACK                     |                 | u32 requestId, srcKind (0 sprite buf, 1 swarm hot, 2 swarm cold), srcId, first, count; M2: srcKind 3 = swarm alive count      |
| 0x0121 | PICK                         |                 | M2. u32 requestId, f32 x, f32 y (css px)                                                                                      |
| 0x0200 | SPRITE_BUFFER_ALLOC          |                 | u32 bufferId, capacity                                                                                                        |
| 0x0201 | SPRITE_BUFFER_DESTROY        |                 | u32 bufferId                                                                                                                  |
| 0x0202 | SPRITE_UPLOAD                |                 | u32 bufferId, first, count, u8[count·40]                                                                                      |
| 0x0203 | SPRITE_UPLOAD_SHARED         |                 | u32 bufferId, first, count, sharedId, byteOffset                                                                              |
| 0x0210 | SPRITE_DRAW                  | DRAW            | u32 bufferId, first, count, texId, blendModeId                                                                                |
| 0x0211 | SPRITE_DEFINE_EFFECT         |                 | M3. u32 effectId, u8[96] sprite effect block (color matrix, outline)                                                          |
| 0x0212 | SPRITE_DESTROY_EFFECT        |                 | M3. u32 effectId                                                                                                              |
| 0x0213 | SPRITE_SET_EFFECT            | DRAW            | M3. u32 effectId (0 = none) for the SPRITE_DRAWs that follow in this packet                                                   |
| 0x0300 | SWARM_CREATE                 |                 | u32 swarmId, capacity, texId, blendModeId, renderFlags, paramsBytes, computeSrcBytes, renderSrcBytes, u8[compute], u8[render] |
| 0x0301 | SWARM_DESTROY                |                 | u32 swarmId                                                                                                                   |
| 0x0302 | SWARM_SET_PIPELINE           |                 | like CREATE without capacity                                                                                                  |
| 0x0303 | SWARM_WRITE_HOT              |                 | u32 swarmId, first, count, u8[count·40]                                                                                       |
| 0x0304 | SWARM_WRITE_COLD             |                 | u32 swarmId, first, count, u8[count·16]                                                                                       |
| 0x0305 | SWARM_SPAWN                  | COMPUTE         | u32 swarmId, u8[112] SpawnParams                                                                                              |
| 0x0306 | SWARM_KILL_RANGE             | COMPUTE         | u32 swarmId, first, count                                                                                                     |
| 0x0307 | SWARM_KILL_LIST              | COMPUTE         | u32 swarmId, n, u32[n]                                                                                                        |
| 0x0308 | SWARM_SET_PARAMS             |                 | u32 swarmId, byteOffset, byteLength, u8[byteLength]                                                                           |
| 0x0309 | SWARM_STEP                   | COMPUTE         | u32 swarmId, f32 dt, u32 substeps, u32 activeCount                                                                            |
| 0x030A | SWARM_DRAW                   | DRAW            | u32 swarmId, f32 a, b, c, d, tx, ty, f32 alpha, u32 drawCount                                                                 |
| 0x030B | SWARM_SET_FRAMES             |                 | u32 swarmId, count, f32[count·4] (u0, v0, u1, v1)                                                                             |
| 0x030C | SWARM_SET_PICK               |                 | M2. u32 swarmId, pickId (Swarm node id; 0 = not pickable)                                                                     |
| 0x030D | SWARM_SET_SOURCE             |                 | M2.5. u32 swarmId, hotExternalId (0 = own buffers), coldExternalId (0 = own), flags (SIMULATE=1)                              |
| 0x030E | SWARM_SET_CURVES             |                 | M3. u32 swarmId, u8[64] over-life curves (stops, color, size, alpha)                                                          |
| 0x0400 | MASK_BUFFER_ALLOC            |                 | M3. u32 bufferId, capacity (mask quads, 40 B each)                                                                            |
| 0x0401 | MASK_BUFFER_DESTROY          |                 | M3. u32 bufferId                                                                                                              |
| 0x0402 | MASK_UPLOAD                  |                 | M3. u32 bufferId, first, count, u8[count·40]                                                                                  |
| 0x0403 | MASK_UPLOAD_SHARED           |                 | M3. u32 bufferId, first, count, sharedId, byteOffset                                                                          |
| 0x0410 | MASK_PUSH_SCISSOR            | DRAW            | M3. u32 maskId, f32 x, y, width, height (css px), u32 flags                                                                   |
| 0x0411 | MASK_PUSH_STENCIL            | DRAW+PASS_BREAK | M3. u32 maskId, bufferId, first, count, texId, flags, f32 threshold                                                           |
| 0x0412 | MASK_PUSH_ALPHA              | DRAW+PASS_BREAK | M3. u32 maskId, bufferId, first, count, texId, flags, f32 x, y, width, height, resolution                                     |
| 0x0418 | MASK_POP                     | DRAW+PASS_BREAK | M3. u32 maskId (PASS_BREAK only when it ends a stencil or alpha segment)                                                      |
| 0x0500 | FILTER_DEFINE                |                 | M3. u32 filterId, passCount, uniformBytes, flags, srcBytes, u8[srcBytes]                                                      |
| 0x0501 | FILTER_DESTROY               |                 | M3. u32 filterId                                                                                                              |
| 0x0502 | FILTER_SET_UNIFORMS          |                 | M3. u32 filterId, byteOffset, byteLength, u8[byteLength]                                                                      |
| 0x0510 | FILTER_BEGIN                 | DRAW+PASS_BREAK | M3. u32 groupId, f32 x, y, width, height (css px), f32 resolution, u32 flags                                                  |
| 0x0511 | FILTER_END                   | DRAW+PASS_BREAK | M3. u32 groupId, blendModeId, f32 alpha, u32 count, u32[count] filterIds                                                      |

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
- M2.5 `SWARM_SET_SOURCE` is only emitted in main-thread mode (external ids
  exist only there, §19.4). The draw count keeps travelling in
  `SWARM_DRAW.drawCount` (and `SWARM_STEP.activeCount` when simulating).

### 3.5 Core to front messages

These are defined in `src/types/transport.ts`: `ready{caps}`,
`frameDone{frameId, buffer}`, `readback{requestId, data, code?, message?}`,
`pick{requestId, objectId, instance, userId?, code?, message?}` (M2;
`userId` M2.5, absent = 0),
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
  user:  u32,       // 12 M2.5: instance user id (PickHit.userId); custom behaviors may read it
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

Pick target `PICK_TARGET_FORMAT` = `rgba32uint` (M2.5; `rg32uint` in M2),
one texel. A pick fragment writes `vec4u(objectId, instance + 1, userId,
0)` (u32 indices `PICK_TEXEL_OBJECT` = 0, `PICK_TEXEL_INSTANCE` = 1,
`PICK_TEXEL_USER` = 2). Sprites write `(pickId, 0, 0, 0)`, so instance
decodes to -1 and the front supplies `SceneNode.userId`; a Swarm writes its
`cold.user` as userId. objectId 0 is a miss. Texels whose premultiplied
alpha is below `PICK_ALPHA_THRESHOLD` (0.5) are discarded. Readback is
`PICK_RESULT_BYTES` = 16.

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
`init`). M2: `init` loads the sprite shaders for `caps.shaderLanguage` with a
dynamic import (`src/sprites/shadersWGSL.ts` or `shadersGLSL.ts`), so a page
carries only one language (§18.1). It caches a `Uint8Array` view per sharedId (created at register
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
  module, opcode routing and (M2.5) the external-buffer table (§19.4).
- **M2.5 RHI additions**: the `rgba32uint`
  format (pick texel), `createReadbackRing` (§19.6), `native()`,
  `importBuffer()` and `resetState()` (§19.4).

### 7.1 Readback pacing (M2.5, as built)

Not part of the RHI: RenderCore duck-types optional backend members
(`FramePacer` in `RenderCore.ts`): `backlogged()`, `whenCaughtUp(callback)`
and the `onReadbackLanded` callback slot (§19.6).

- Pacing is on **only while a readback is in flight** (a ring slot
  mapping, `readBuffer` or `readTexture`). Once `PACE_FRAMES` = 3 frames were
  submitted since it started, `backlogged()` is true (WebGL2: only while its
  fence is still unsignalled).
- In `ack()` (the frame acknowledgement), if `backlogged()` is true the core
  does not post `frameDone` yet; it passes it to `whenCaughtUp`, so
  `transport.busy` stays true and the front skips frames (`skippedFrames`)
  instead of queueing more GPU work in front of the readback.
- A held frame costs a display tick in uncapped Chrome, so RenderCore
  answers finished picks when it releases a held frame
  (`RenderCoreImpl.releaseHeld`), not only at the start of a packet.
- WebGPU releases a held frame when the last in-flight map lands
  (`landed()`); WebGL2 re-checks ring fences on a 1 ms timer while a frame
  is held (no packet runs meanwhile, so nothing else would poll them).
- There are no queue fences any more: `PACE_FAST_MS`, `PACE_MAX_LAG_MS`,
  `PACE_WINDOW_MS` and `paceReadbacks()` are gone from both backends and
  RenderCore. A vsync-paced loop or a page without readbacks never holds a
  frame.
- A device loss releases a held acknowledgement at once.
- **Known limit:** without a readback in flight, uncapped submits can
  outrun the GPU without bound (measured: a 2.2 s queue on WebGPU and 4.5 s
  on WebGL2 in the A3 churn bench). The first readback after such a run
  waits behind that queue (the A3 finish-phase `aliveCount()`, or the first
  WebGL2 pick in A2u: one 3 s outlier in two of three runs). Always-on
  frame limiting would fix it but holds frames with nothing read back; not
  done.

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
6. A loss noticed while restoring (a DEVICE_LOST thrown by a re-created
   resource, or a new loss notification) restarts the restore from step 3,
   at most `MAX_LOSS_RETRIES` = 3 times for thrown DEVICE_LOST errors
   (`RenderCore.recover()`; WebGL2 program creation can see the lost context
   before `webglcontextlost` fires). If restore fails for good, the core
   posts `error{DEVICE_LOST}`, the renderer becomes `destroyed`, and the
   front calls `onDeviceLost({ willRestore: false })`.
7. M2.5: the front also emits the `deviceLost` / `deviceRestored` events
   (§19.2) right after the callbacks, and the core drops every external
   buffer registration on loss (§19.4).

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

| scenario                                                                                                     | budget                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Steady-state JS allocations per frame (all examples, both modes)                                             | **0** (heap-sampling bench asserts < 1 KB per 600 frames)                                                            |
| `render()` front CPU, 100k static sprites, nothing dirty                                                     | < 0.5 ms                                                                                                             |
| `render()` front CPU, 100k sprites all moving                                                                | < 6 ms (pack + transforms); M2 bulk API < 3 ms                                                                       |
| Sprite upload, 100k all moving                                                                               | ≤ 4 MB/frame, ≤ 8 writeBuffer calls                                                                                  |
| Draw calls, sprites                                                                                          | one per contiguous (texture, blend) run                                                                              |
| Swarm 1M objects, velocity + acceleration + bounds (WebGPU)                                                  | ≥ 60 fps; front CPU < 0.3 ms/frame; packet < 1 KB/frame                                                              |
| Swarm 4M objects (discrete GPU, `limits: 'max'`)                                                             | ≥ 60 fps                                                                                                             |
| Swarm 250k objects on WebGL2 (integrated GPU)                                                                | ≥ 60 fps; front CPU < 0.3 ms/frame                                                                                   |
| 100k moving sprites on WebGL2                                                                                | < 6 ms front CPU; ≥ 60 fps                                                                                           |
| Swarm spawn of 1M objects                                                                                    | one command, < 1 ms front CPU                                                                                        |
| `renderer.pick()`                                                                                            | ≤ 2 frames latency; 0 cost in frames without picks; M2.5: no library allocation per pick beyond the returned promise |
| Asset load of a 2048² PNG                                                                                    | no main-thread stall > 4 ms (decode off-thread, upload by transfer)                                                  |
| Command overhead                                                                                             | 8 B header; typical command ≤ 64 B                                                                                   |
| Worker mode                                                                                                  | ≤ 1 frame latency; main-thread busy loop of 8 ms must not drop core frames; 0 allocations per frame with the ring    |
| `createRenderer` (excluding first pipeline compile)                                                          | < 150 ms                                                                                                             |
| Bundle (min+gzip), minimal program: createRenderer + Texture + Sprite, WebGPU, including the chunks it loads | ≤ 44 KB (end of M3)                                                                                                  |
| Bundle, same minimal program on WebGL2                                                                       | ≤ 46 KB (end of M3)                                                                                                  |
| Bundle, each lazily loaded feature chunk                                                                     | its own budget (§18.3): measured size + 0.5 KB                                                                       |
| Bundle, no growth: every fixture and feature chunk                                                           | ≤ `scripts/size-baseline.json` + 0.5 KB                                                                              |
| Bundle, all exports (sum of every chunk)                                                                     | reported only (no absolute budget since M2.5); no-growth checked                                                     |
| Worker bundle: `dist/cozygpu.worker.js` + the backend chunk it loads                                         | ≤ 25 KB (WebGPU) / ≤ 26 KB (WebGL2, end of M3)                                                                       |
| M2.5 hooks (§19): `commit()`, events, interop, pick polling                                                  | 0 allocations per frame; no events per frame                                                                         |

M1 measurements (Apple M4, Chrome 152 headless; see
`benchmarks/results/m1-final.md`): Swarm 1M
144 fps / 0.23 ms front CPU / 108 B packet; Swarm 2M beats Three TSL
compute by 16%; 100k static sprites 0.54 ms frame (0.03 ms CPU); 100k
moving sprites 1.46 ms frame (1.33 ms CPU, 8–16% behind the best
competitor); minimal program 28.4 KB, all exports 46.0 KB, worker bundle
20.0 KB; worker mode allocates 18–25 KB per frame (ring fixes it, §17);
Swarm 400–750 B per frame.

**Bundle budgets (decided 2026-09-18, in force from M2.5).** M2 measured
the minimal program at 39.6 KB (WebGPU) and 41.6 KB (WebGL2) and the M1
budgets (30 / 30 / 45 KB) could not be met without making parts of the sync
API async (M2 report §5). The user chose to keep the API and change the
budgets:

- Minimal program ≤ **40 KB** on WebGPU and ≤ **42 KB** on WebGL2.
- **No growth:** `scripts/size.mjs` fails when any fixture or feature chunk
  grows more than 0.5 KB over its value in `scripts/size-baseline.json`.
  Refresh the baseline (`--update-baseline`) only after the growth was
  reviewed and accepted.
- The single all-exports budget is replaced by **one budget per lazily
  loaded feature chunk** (§18.3), each set to its size at the M2.5 freeze
  plus 0.5 KB. all-exports is still measured and reported.
- Worker bundle (entry + one backend) ≤ **25 KB**.

Measured at the M2.5 freeze (2026-09-19, with the M2.5 stubs in place):

| fixture        | min+gzip | budget |
| -------------- | -------- | ------ |
| minimal-webgpu | 39.9 KB  | 40 KB  |
| minimal-webgl2 | 41.8 KB  | 42 KB  |
| all-exports    | 97.2 KB  | —      |
| worker-webgpu  | 21.9 KB  | 25 KB  |
| worker-webgl2  | 23.9 KB  | 25 KB  |

Measured at the end of M2.5 (2026-09-19, every hook built; the baseline
was refreshed after review):

| fixture        | min+gzip | budget |
| -------------- | -------- | ------ |
| minimal-webgpu | 39.9 KB  | 40 KB  |
| minimal-webgl2 | 41.7 KB  | 42 KB  |
| all-exports    | 104.3 KB | —      |
| worker-webgpu  | 21.6 KB  | 25 KB  |
| worker-webgl2  | 23.4 KB  | 25 KB  |

**M3 freeze (2026-09-22).** Measured with the M3 contracts and stubs in
place, before any M3 feature is built:

| fixture        | M2.5 end | M3 freeze | budget         |
| -------------- | -------- | --------- | -------------- |
| minimal-webgpu | 39.9 KB  | 40.4 KB   | 41 KB (was 40) |
| minimal-webgl2 | 41.7 KB  | 42.3 KB   | 43 KB (was 42) |
| all-exports    | 104.3 KB | 108.2 KB  | —              |
| worker-webgpu  | 21.6 KB  | 21.9 KB   | 25 KB          |
| worker-webgl2  | 23.4 KB  | 23.7 KB   | 25 KB          |

The minimal program grew 0.5 KB although no M3 feature is on it. About
0.4 KB of that is **chunk-splitting cost**: the four new lazy features pull
shared modules (errors, ids, the lazy-system registry) out of the entry
chunk into one more shared chunk, and every chunk boundary costs gzip
efficiency; the entry chunk itself shrank from 18.2 to 17.9 KB. The rest is
the contract code that had to be on the path (the PASS_BREAK branch in
RenderCore, two `LazyCoreSystem` placeholders, the new sprite/swarm opcode
keys). Mask and filter opcodes were moved into their own `MaskOp` /
`FilterOp` tables for the same reason (§21.6), which recovered 0.1 KB.

The minimal budgets were therefore raised by 1 KB each, to 41 KB (WebGPU)
and 43 KB (WebGL2), leaving about 0.6 KB of headroom for the M3 build.
**The no-growth check is what actually holds the line**: every fixture and
chunk is pinned to `scripts/size-baseline.json` + 0.5 KB, so an M3 feature
that leaks onto the minimal path fails the gate even under the raised
budget. The M3 feature chunks are seeded in the baseline at their target
budget (they are stubs today); refresh them down to the measured size when
the feature is done.

**End of M3 (2026-09-22).** Every feature built, baseline refreshed after
review:

| fixture        | M3 freeze | end of M3 | budget         |
| -------------- | --------- | --------- | -------------- |
| minimal-webgpu | 40.4 KB   | 43.5 KB   | 44 KB (was 41) |
| minimal-webgl2 | 42.3 KB   | 45.6 KB   | 46 KB (was 43) |
| all-exports    | 108.2 KB  | 144.1 KB  | —              |
| worker-webgpu  | 21.9 KB   | 23.2 KB   | 25 KB          |
| worker-webgl2  | 23.7 KB   | 25.3 KB   | 26 KB (was 25) |

No mask, filter, text or particle module is on the minimal path (verified
with an esbuild metafile over the minimal fixture: its reachable chunks
contain none of `src/masks/**`, `src/filters/**`, `src/text/**`,
`src/particles/**`). The 3.1 KB the minimal program did grow, measured by
swapping single files back to their M3-freeze version in the fixture build:

| source                                                      | min+gzip |
| ----------------------------------------------------------- | -------- |
| `sprites/core.ts` — cheap-effect routing (§22.7)            | +0.41 KB |
| `scene/bulk.ts` — paired column copy (1.9× faster `commit`) | +0.34 KB |
| `sprites/front.ts` — the render-group seam (§21.4)          | +0.16 KB |
| `RenderCore.ts` — `mainPass`, MSAA store, pass-break count  | +0.09 KB |
| `commands/encoder.ts` — the shared-slot `utf8` scratch      | +0.08 KB |
| `lazySystems.ts` — the `passBreak` forwarder                | +0.03 KB |
| backend chunks — GL stencil, queue pacing, the MSDF branch  | +0.52 KB |
| four more lazy roots: shared-chunk splitting overhead       | +1.3 KB  |

The splitting overhead is the same effect the freeze already measured, at
the scale of four real features: exporting `Group`, `Particles` and `Text`
moves shared modules into more, smaller chunks, and each boundary costs
gzip efficiency. It is **not** feature code — a build with those three
export lines removed still contains no feature module, only fewer chunks.

One real leak was found and fixed rather than budgeted: the particle
emitter compiler imported `swarm/behaviors`, which is also a static export
of the library entry. A module reachable both statically from the entry and
from a lazy chunk lands in a chunk the entry loads eagerly, so the behavior
table, the shader composer and 9 KB of swarm WGSL were on the minimal path
(50.0 KB WebGPU). `src/swarm/velocity.ts` now holds the one behavior the
emitter needs and imports nothing, which took 6.5 KB back off the path.
**The rule for later milestones:** a lazily loaded chunk must not import a
module that the library entry also reaches statically, unless that module
is tiny.

M2.5 added about 1.3 KB to the minimal path (events, userId, columns,
picking poll, interop stub). It was recovered without API
changes: the pick client (`picking.ts`) and the core half of interop
(`coreInterop.ts`) became lazy chunks, `readTexture` (both backends),
WebGL2 `readBuffer` and the texel-rect check moved into the readback-ring
chunks, WGSL compilation-message formatting became a lazy chunk, and
diagnostics text on the minimal path was shortened (TextureRegistry,
encoder, decoder, backend errors). Headroom is now about 0.1 KB (WebGPU)
and 0.3 KB (WebGL2): the next feature on the minimal path needs a budget
decision or more savings first.

At the freeze the minimal program had **0.1 KB (WebGPU) and 0.2 KB (WebGL2)
of headroom**.
M2.5 code on the minimal path (Renderer, Container, NodeBase, the store)
must therefore pay for itself: keep it tiny, move anything optional behind
a dynamic import (as `interop()` does, §19.4), or recover bytes elsewhere on
the path first (the M2 report lists about 1.2 KB of error-message text and
1.5–2 KB of tiny shared esbuild chunks). Where the M2 bytes are, in
minified bytes: `sprites/front.ts` about 13 KB, `RenderCore.ts` 12 KB,
`Renderer.ts` 8.7 KB, `TextureRegistry.ts` 6.7 KB, `bulk.ts` 4.4 KB, the
encoder and decoder 7 KB.

Hot-path rules:

- No closures, arrays, objects, or `for…of` iterators per frame or per
  node. The decoder exposes whole-packet views plus absolute offsets
  (`reader.blob(n)`), so the core never creates views per command. The
  encoder may create one subarray per bulk upload.
- Use typed arrays and index loops.
- No string building per frame.
- Pipelines and bind groups are created on change, not per frame.

## 11. Source layout

Modules talk to each other only through the entry points below.

Cross-module call graph:

```
scene    → (Group only) masks/mask.ts:createMaskBinding, filters/filters.ts:createFilterBinding (both dynamic)
masks    → filters/targets.ts:createTargetPool (alpha masks share the filter target pool)
text     → scene/Container.ts, scene/Sprite.ts (glyph children), assets (font atlas)
particles→ swarm/Swarm.ts (owns one), swarm/types.ts
renderer → assets/proxy.ts:createAssetsProxy, renderer/lazySystems.ts:isCoreSystemReady,
           backend/createBackend.ts → import('./webgpu/WebGPUBackend') | import('./webgl2/WebGL2Backend'),
           worker/LocalTransport.ts:createLocalTransport (Transport.interop)
scene    → commands (encoder types), types/core.ts (FrontFrame, CustomDrawable)
swarm    → scene/Texture.ts:ensureTextureUploaded, math/color.ts, commands, renderer/lazySystems.ts,
           types/interop.ts (ExternalInstanceBuffer), CoreContext.getExternalBuffer (core side)
assets   → scene/Texture.ts:Texture.fromProvider, types/core.ts:RendererHost (_addFrameHook, _emit)
worker   → renderer/RenderCore.ts:createRenderCore, renderer/systems.ts, commands
```

## 12. M2 overview

_Historical (M2 contract freeze). The M2.5 contract additions are listed in
§19.9._

M2 widens reach (WebGL2), adds the asset loader and picking, closes the
M1 budget gaps (worker allocations, bundle size, moving-sprite CPU), and
adds GPU free lists to Swarm. The contracts were designed first; during
the build the implementation files were stubs that threw
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

Seams wired into the shared files (each module fills in its own
implementation): `src/renderer/picking.ts`, `src/renderer/pickingCore.ts`,
`src/assets/proxy.ts`, `src/assets/Assets.ts`,
`src/backend/webgl2/WebGL2Backend.ts`, the three `TextureRegistry` M2
methods, `isCoreSystemReady` in `lazySystems.ts`, `Container.bulkChildren`,
`NodeBase.pickable`, `Texture.fromProvider`, `Swarm.aliveCount`, and
WebGPU `readTexture`.

## 13. WebGL2 backend (M2)

Owner in M2: webgl2 (M2.5: renderer-hooks). Files: `src/backend/webgl2/**`.
This section describes the backend as built. It implements the same RHI
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
- **`FLUSH_EVERY_DRAWS` = 4096** (`commands.ts`): a render pass calls
  `gl.flush()` after every 4096 draws. ANGLE over Metal records a whole
  frame into one command buffer; about 200k unbatched draws in one frame
  exhausted its host memory (`GL_OUT_OF_MEMORY`) and lost the context.
  Normal frames (a few hundred draws) never reach the threshold.

### 13.2 RHI method mapping

| RHI                                                 | WebGL2                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBuffer`                                      | `createBuffer`; target chosen from usage (VERTEX/INDEX/UNIFORM; STORAGE and INDIRECT throw UNSUPPORTED); `bufferData(size, DYNAMIC_DRAW)`                                                                                                                                                                         |
| `writeBuffer`                                       | `bufferSubData(target, offset, view, srcOffset, length)` (no copies; works with SAB views)                                                                                                                                                                                                                        |
| `readBuffer`                                        | `fenceSync` + `clientWaitSync` polled via `setTimeout`, then `getBufferSubData` into a new ArrayBuffer; counts as a readback in flight for pacing (§7.1)                                                                                                                                                          |
| `createTexture`                                     | `texStorage2D` (immutable) with mip count; multisampled targets become renderbuffers; `r32uint`/`rg32uint`/`rgba32uint` (M2.5) integer targets for picking                                                                                                                                                        |
| `writeTexture`                                      | `texSubImage2D` (UNPACK_ALIGNMENT 1) or `compressedTexSubImage2D` per level                                                                                                                                                                                                                                       |
| `copyExternalImage`                                 | `texSubImage2D(…, destX, destY, RGBA, UNSIGNED_BYTE, source)` with `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`, `UNPACK_FLIP_Y_WEBGL = flipY`, `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`                                                                                                                            |
| `generateMipmaps`                                   | `generateMipmap`                                                                                                                                                                                                                                                                                                  |
| `readTexture`                                       | FBO + `readPixels` into a PIXEL_PACK buffer (`RGBA_INTEGER, UNSIGNED_INT` for integer formats), fence, then `getBufferSubData`, packed to the RHI's tight layout; paced like `readBuffer` (§7.1). M2.5: the readback ring replaces it for picking (§19.6)                                                         |
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
  `caps.shaderLanguage`. As built, every shader set loads per language with
  a dynamic import: the sprite core imports `src/sprites/shadersWGSL.ts` or
  `shadersGLSL.ts` in `init`, and the swarm front imports the GLSL
  templates (`src/swarm/glsl.ts`) only when `caps.shaderLanguage ===
'glsl300es'`, so a page carries one language (§18.1).
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

- **Early loss report.** `webglcontextlost` is dispatched as a task, so a
  GL call can see `gl.isContextLost()` first. The backend then reports the
  loss at once (`noticeLoss()` → `markLost()`) before rejecting the failing
  call with DEVICE_LOST, so the core treats that rejection as part of a
  loss it already knows about instead of as fatal. The late event only
  calls `preventDefault()`. A loss also releases a frame held by pacing.
- A second loss during a restore is retried by RenderCore
  (`MAX_LOSS_RETRIES`, §9.1).

### 13.7 Transform feedback and framebuffers (as built)

ANGLE over Metal: after a transform-feedback draw, a framebuffer created
earlier silently stops taking clears and draws (its cached render target
goes stale). Picking after a Swarm draw therefore kept answering its first
value. The backend counts feedback passes in `feedbackSerial` (bumped when a
`FeedbackPass` ends); each render-target texture remembers the serial at
which its color attachment was last bound (`fboFeedbackSerial`), and
binding it as a target after newer feedback re-attaches color 0 (detach,
then attach). The cost is two GL calls per render-target pass after
feedback; the canvas framebuffer is unaffected.

## 14. Swarm in M2: WebGL2 and GPU free lists

Owner in M2: swarm (M2.5: swarm-hooks). As built.

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

Asset events are described in §19.2. Contract: `src/assets/types.ts`. Public entry:
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

`src/renderer/TextureRegistry.ts` implements
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

Owner in M2: sprites (M2.5: scene-hooks for §16.1–§16.2, renderer-hooks for
the picking modules in §16.3).

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
rebuild. Invariant tests (`dirty.property.test.ts`,
`structure.property.test.ts`) compare the incremental result with a full
rebuild byte for byte.

As built, the patcher lives in `src/sprites/frontPatch.ts` and loads with a
dynamic import on the first structure change; until it has loaded, every
structure change takes the full rebuild, which is always correct. Programs
whose tree never changes after the first frame never fetch it.

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
first PICK. As built, `pickingCore.ts` is a small proxy
(`LazyCorePicking`): it imports `pickingCoreImpl.ts` (targets, pick pass,
readback) on the first PICK and queues requests until it lands, so they
render one packet later than a warm pick. Pick pipelines are shared state
in `pickingPipelines.ts` (`pickPipelinesPending`). Behavior:

- Owns 1×1 `PICK_TARGET_FORMAT` textures (RENDER_TARGET | COPY_SRC), up to 4
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
  request; post `pick{requestId, objectId, instance: second - 1}`. As
  built, each of the up to 4 request slots per packet has its own texture
  and View uniform, so picks in one frame never overwrite each other. This
  allocates a staging buffer, a copy and promises per pick (about 30 KB
  per frame while picking); M2.5 replaces it with the polled readback ring
  (§19.6).
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
- **Lazy swarm core in the worker (as built).** The worker bundle is
  code-split too: `src/worker/entry.ts` registers the swarm core loader
  (`import('../swarm/core')`, about 10 KB gz) instead of importing it. The
  front never waits on `isSystemReady` in worker mode, so the host checks
  each packet (`pendingLoad`, a header walk that stops once the core is
  loaded): the first packet with SWARM commands is held, unacknowledged,
  until the chunk has loaded, then executed. The front sees a busy
  transport and skips frames meanwhile; no command is dropped. A
  sprite-only worker never fetches the chunk.
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

Build configuration lives in `rollup.config.cjs` and `scripts/**`;
§18.1 lists the chunks as built.

### 18.1 Dynamic imports

| module (chunk)                                    | loaded by             | when                                                                |
| ------------------------------------------------- | --------------------- | ------------------------------------------------------------------- |
| `backend/webgpu/WebGPUBackend`                    | `createBackend`       | WebGPU selected                                                     |
| `backend/webgl2/WebGL2Backend`                    | `createBackend`       | WebGL2 selected or fallback                                         |
| `sprites/shadersWGSL` / `sprites/shadersGLSL`     | sprite core `init`    | per `caps.shaderLanguage` (one language per page)                   |
| `sprites/frontPatch` (incremental structure pass) | scene packer          | first structure change (full rebuilds until loaded, §16.2)          |
| `renderer/pickingCoreImpl`                        | `pickingCore` proxy   | first PICK (requests queue until loaded, §16.3)                     |
| `worker/WorkerTransport`                          | `createRenderer`      | `worker: true`                                                      |
| `swarm/core`                                      | `lazySystems` loader  | first swarm command (local mode; worker: first SWARM packet, §17)   |
| `swarm/glsl` (GLSL templates + composer)          | swarm front           | first swarm on a GLSL renderer                                      |
| `assets/Assets`                                   | `assets/proxy`        | first async `renderer.assets` call                                  |
| `renderer/interopImpl` + `coreInterop` (M2.5)     | `renderer.interop()`  | first `interop()` call (§19.4)                                      |
| `renderer/picking` (pick client, M2.5)            | `renderer.pick()`     | first `pick()` (it encodes in a render after the chunk loaded)      |
| `backend/*/readbackRing` (M2.5)                   | backend               | first pick (`loadReadbackRing`), `readTexture`, WebGL2 `readBuffer` |
| `backend/webgpu/compileMessages` (M2.5)           | WebGPU backend        | a shader reports compilation messages                               |
| `masks/mask` + `masks/core` (M3)                  | `Group`               | first `group.mask = …` (worker: a loader in the worker entry)       |
| `filters/filters` + `filters/core` (M3)           | `Group`               | first `group.filters = …` (worker: a loader in the worker entry)    |
| `filters/builtin` (M3)                            | filter front          | first chain that uses a built-in filter                             |
| `text/layout` (M3)                                | `Text`                | first layout                                                        |
| `text/msdf` (M3)                                  | `Text`, `assets/font` | first MSDF text, or a `kind: 'font'` asset                          |
| `text/canvas` (M3)                                | `Text`                | first `SystemFont` style                                            |
| `assets/font` (M3)                                | `Assets`              | a `kind: 'font'` load                                               |
| `particles/emitter` (M3)                          | `Particles`           | construction                                                        |

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

`scripts/size.mjs` (`npm run size`) builds fixtures with esbuild (bundle,
code splitting, minify; shaders minified like the Rollup build), gzips each
chunk (level 9) and runs three checks. It exits non-zero when any fails.
`benchmarks/build.mjs --sizes` stays as the cross-library comparison.

**1. Fixtures** (what a program actually loads):

| fixture                                            | counts                                        | budget  |
| -------------------------------------------------- | --------------------------------------------- | ------- |
| minimal-webgpu (createRenderer + Texture + Sprite) | entry + chunks loaded when WebGPU is selected | ≤ 40 KB |
| minimal-webgl2                                     | entry + chunks loaded when WebGL2 is selected | ≤ 42 KB |
| all-exports (`import * as GPU` using every export) | every chunk                                   | none    |
| worker-webgpu                                      | worker entry + the WebGPU backend chunk       | ≤ 25 KB |
| worker-webgl2                                      | worker entry + the WebGL2 backend chunk       | ≤ 25 KB |

**2. Feature chunks** (each lazily loaded chunk of the all-exports build,
found by the source module it contains; budget = size at the M2.5 freeze +
0.5 KB, rounded up to 0.1 KB; the chunks added during M2.5 are budgeted at
their size at the end of M2.5 + 0.5 KB):

| chunk            | module                                  | freeze (gz) | budget  |
| ---------------- | --------------------------------------- | ----------- | ------- |
| backend-webgpu   | `src/backend/webgpu/WebGPUBackend.ts`   | 8.4 KB      | 8.8 KB  |
| backend-webgl2   | `src/backend/webgl2/WebGL2Backend.ts`   | 10.4 KB     | 10.8 KB |
| sprite-wgsl      | `src/sprites/shadersWGSL.ts`            | 0.8 KB      | 1.3 KB  |
| sprite-glsl      | `src/sprites/shadersGLSL.ts`            | 0.7 KB      | 1.2 KB  |
| structure-patch  | `src/sprites/frontPatch.ts`             | 2.0 KB      | 2.5 KB  |
| picking-core     | `src/renderer/pickingCoreImpl.ts`       | 1.6 KB      | 2.1 KB  |
| assets           | `src/assets/Assets.ts`                  | 10.9 KB     | 11.4 KB |
| swarm-core       | `src/swarm/core.ts`                     | 10.6 KB     | 11.1 KB |
| swarm-glsl       | `src/swarm/glsl.ts`                     | 3.3 KB      | 3.8 KB  |
| worker-transport | `src/worker/WorkerTransport.ts`         | 2.5 KB      | 3.0 KB  |
| interop (M2.5)   | `src/renderer/interopImpl.ts`           | 0.9 KB      | 1.5 KB  |
| pick-client      | `src/renderer/picking.ts`               | 0.9 KB      | 1.4 KB  |
| readback-webgpu  | `src/backend/webgpu/readbackRing.ts`    | 1.5 KB      | 2.1 KB  |
| readback-webgl2  | `src/backend/webgl2/readbackRing.ts`    | 2.1 KB      | 2.7 KB  |
| wgsl-diagnostics | `src/backend/webgpu/compileMessages.ts` | 0.4 KB      | 1.0 KB  |

M3 chunks are budgeted differently: their number is a **target ceiling**
set at the contract freeze, not a measured size plus slack, and the feature
has to fit it. They are re-measured, and only lowered, when the feature is
built.

| chunk (M3)      | module                     | target |
| --------------- | -------------------------- | ------ |
| mask-core       | `src/masks/core.ts`        | 5.0 KB |
| filter-core     | `src/filters/core.ts`      | 7.0 KB |
| filters-builtin | `src/filters/builtin.ts`   | 6.0 KB |
| text-core       | `src/text/layout.ts`       | 4.0 KB |
| text-msdf       | `src/text/msdf.ts`         | 5.0 KB |
| text-canvas     | `src/text/canvas.ts`       | 4.0 KB |
| particles       | `src/particles/emitter.ts` | 5.0 KB |

Each M3 chunk also carries what only it reaches: `mask-core` and
`filter-core` hold their front half as well as the core system, and
`text-msdf` is shared by `Text` and the `assets/font` chunk.

**3. No growth:** every fixture and feature chunk against
`scripts/size-baseline.json` (min+gzip bytes). More than 0.5 KB over the
recorded value fails, even under the absolute budget. A new chunk without a
baseline entry is reported as new. Run
`node scripts/size.mjs --update-baseline` only after the growth was reviewed.

## 19. Integration hooks (M2.5)

Decided 2026-09-18: cozygpu stays a pure graphics wrapper with zero runtime
dependencies. ECS and event libraries (cozyECS, cozyEvent or any other) are
wired together in the separate cozyJS suite. cozygpu only offers
**library-neutral hooks**, and every hook follows the same rules
(normative):

- **Register once, commit per frame.** Setup calls (bind, register, create)
  may allocate and validate; the per-frame call is a plain method with
  numbers only and allocates nothing.
- **No per-frame events.** The events sink sees rare lifecycle events only.
- **No WebGPU or WebGL types** in any public `.d.ts`: native objects are
  `unknown`.
- **Minimal-path bytes are scarce** (§10: 0.1 KB headroom on WebGPU). Hook
  code that the minimal program does not need goes behind a dynamic import.

Contracts live in `src/scene/types.ts` (§19.1, §19.3),
`src/types/events.ts` (§19.2), `src/types/interop.ts`,
`src/swarm/types.ts` (§19.4), `src/types/renderer.ts`,
`src/types/core.ts`, `src/types/transport.ts`, `src/types/layouts.ts`,
`src/backend/types.ts` and `src/commands/opcodes.ts`. §19.9 lists them.

### 19.1 External columns for sprites

```ts
// columns owned by the caller (an ECS archetype, or plain typed arrays)
const binding = layer.bindColumns({
  x: px,
  y: py,
  rotation: rot,
  tint,
  userId: entity,
});
// every frame, after the ECS systems ran:
binding.commit(count); // rows [0, count) → children [0, count)
// after the ECS replaced its arrays (an archetype grew):
binding.rebind({
  x: px2,
  y: py2,
  rotation: rot2,
  tint: tint2,
  userId: entity2,
});
// interleaved [x0, y0, x1, y1, …] storage:
layer.bindColumns({
  x: { array: xy, offset: 0, stride: 2 },
  y: { array: xy, offset: 1, stride: 2 },
});
```

- `container.bindColumns(columns, options?)` binds caller-owned typed
  arrays to the container's **direct children**: row i drives child i, the
  same indexing as `bulkChildren`. It returns the container's single reused
  `ColumnBinding` and never copies at bind time.
- Columns (`SpriteColumns`): `x`, `y` (required, `Float32Array`),
  `rotation`, `scaleX`, `scaleY`, `alpha` (`Float32Array`), `tint`,
  `frame`, `userId` (`Uint32Array`). Each is a dense array (row i at index
  `i × stride`, `options.stride` default 1) or `{ array, offset?, stride? }`
  for interleaved storage (row i at `offset + i × stride`). Units match the
  setters.
- `frame` indexes `options.frames` (TextureHandles). Frames of one source
  are an instance rewrite (`Dirty.SPRITE`); a change to another source moves
  a batch boundary (structure bump).
- `userId` writes `SceneNode.userId` (§19.3) and marks nothing dirty.
- **Semantics = `BulkChildren.commit`.** `commit(count, first = 0, fields =
binding.fields)` copies rows [first, first + count) of the bound columns
  into the node store in one tight loop per column, sets the same dirty bits
  as the bulk path (x, y only → `Dirty.POSITION`, so the packer keeps the
  §5.2 translation fast path) and bumps `touch` once. The next render()
  therefore emits one dirty range and one bulk upload, exactly as for
  `bulkChildren`. `fields` takes `BulkField` bits (M2.5 adds `FRAME` and
  `USER_ID`, which `bulkChildren` ignores).
- Implementation rule: **one copy path.** Generalize the `ChildBulk`
  (`src/scene/bulk.ts`) loops to strided sources, so a dense writer is the
  stride-1, offset-0 case; do not add a second set of loops (bytes, §10).
- Validation at bind time: array types, `stride ≥ 1`, `frames` present when
  `frame` is bound. At commit: `first + count ≤ children.length` and every
  bound column long enough for row `first + count - 1`; otherwise
  INVALID_ARGUMENT. DESTROYED after the container is destroyed.
- Re-bind whenever an array **object** is replaced (the binding keeps
  references, it cannot detect a swap). Growing the children list needs no
  re-bind; rows beyond `children.length` are rejected by `commit`.
- `unbind()` drops the references so the arrays can be collected.
- Budget: 100k moving sprites committed from columns < 3 ms front CPU (the
  bulk budget), 0 allocations per frame.

### 19.2 Events sink

```ts
const renderer = await GPU.createRenderer({ canvas, events: bus }); // any { emit(name, payload) }
// a typed bus: declare it as Bus<GPU.Events>
```

- `RendererOptions.events` accepts any object with
  `emit(name: string, payload: unknown): void`. cozygpu calls nothing else
  on it.
- `GPU.Events` (type-only export, `src/types/events.ts`) maps names to
  payloads: `ready`, `fallback`, `deviceLost` (WebGL context loss is folded
  in; there is no separate contextLost), `deviceRestored`, `resize`,
  `assetProgress`, `assetError`, `error`.
- Emission order: `fallback` (if any), then `ready`, both before
  `createRenderer()` resolves. `deviceLost` / `deviceRestored` right after
  the `onDeviceLost` / `onDeviceRestored` callbacks. `resize` when
  `renderer.resize()` accepts a new size (autoResize included), not per
  frame. `error` for the core's non-fatal `error` messages (they are still
  logged). `assetProgress` per finished asset or bundle entry and
  `assetError` per failed load, emitted by the asset manager through
  `RendererHost._emit`.
- Each emit gets a fresh plain payload; a throwing sink is caught and
  logged once per event name. Main thread only, both renderer modes.
- **Nothing per frame.** Frame-rate data stays in `renderer.stats`.

### 19.3 User ids and the pick texel

- `SceneNode.userId` (u32, default 0, `NodeOptions.userId`, coerced with
  `>>> 0`) is stored per node slot (a `Uint32Array` column in the node
  store, grown with it). It never affects drawing, so writes set no dirty
  bit. Columns write it in bulk (§19.1).
- Swarm instances use `cold.user` (`SC_USER`), written by
  `SpawnOptions.user` or `write()`. Custom behaviors may still read it.
- The pick target is `rgba32uint` (§4.7): texel `(objectId, instance + 1,
userId, 0)`. The swarm pick fragment writes `cold.user` (a flat varying
  from the vertex stage; WGSL and GLSL); sprites write 0.
- `pick{…, userId?}` carries `texel[PICK_TEXEL_USER]`. The front resolves
  `PickHit.userId`: the message value for a Swarm hit, `node.userId` for a
  sprite hit (read when the answer arrives).
- Instance user ids only need `write()` or `spawn()`; there is no
  per-instance setter in M2.5 (it would need a new opcode).

### 19.4 Device interop and external instance sources

Main-thread mode only: the device must live in the caller's thread.

```ts
const interop = await renderer.interop(); // rejects UNSUPPORTED in worker mode
const device = interop.device as GPUDevice; // or WebGL2RenderingContext
const hot = device.createBuffer({
  size: n * 40,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
});
const ext = interop.registerInstanceBuffer(hot, {
  layout: 'swarm-hot',
  capacity: n,
});
swarm.setSource({ hot: ext, count: n }); // draw-only; the caller's compute moves them
// per frame: submit the caller's compute on device.queue, then:
swarm.setSourceCount(liveCount);
renderer.render();
```

- `renderer.interop(): Promise<RendererInterop>` resolves an opaque handle:
  `backend`, `device: unknown` (GPUDevice or WebGL2RenderingContext),
  `registerInstanceBuffer(buffer, { layout, capacity })` and
  `invalidateState()`. Async because the implementation is its own lazy
  chunk (`src/renderer/interopImpl.ts`, §18.1); the minimal program pays
  only for the method stub. It rejects with UNSUPPORTED in worker mode and
  DESTROYED after destroy.
- Plumbing (as built): `Renderer` → lazy `interopImpl` chunk →
  `Transport.interop?(createCoreInterop)` (local transport only; it calls
  `create` with its core, so the core half, `src/renderer/coreInterop.ts`,
  ships in the interop chunk and neither the minimal program nor the worker
  bundle carries it; `RenderCore.interop?` stays optional and unused) →
  `CoreInterop` (`device()`,
  `registerBuffer(externalId, native, desc)`, `releaseBuffer`,
  `invalidateState`, `lossEpoch`) → RHI `Backend.native()`,
  `importBuffer(native, { size, usage })` (wraps without ownership),
  `resetState()`. Registration is synchronous (same thread); the core keeps
  a table read by `CoreContext.getExternalBuffer(externalId)`. Ids come
  from `ids.external`.
- Layouts (`ExternalLayout`): `'swarm-hot'` (40 B, §4.2; WebGL2 the
  interleaved form), `'swarm-cold'` (16 B, §4.3). `'sprite-instance'`
  (§4.1) is reserved: no consumer in M2.5, rejected with UNSUPPORTED.
- **Swarm sources:** `swarm.setSource({ hot, cold?, count, simulate? })`
  emits `SWARM_SET_SOURCE(swarmId, hotId, coldId, flags)`. The core draws
  from the external hot buffer (and cold, when given; else the swarm's own
  cold). `simulate: true` also runs the swarm's behaviors on it (WebGPU
  only: STORAGE read_write). **WebGL2 has no external sources in M2.5:**
  `setSource` throws UNSUPPORTED once the swarm has run there; a source set
  before the first WebGL2 frame disables the swarm with one UNSUPPORTED
  console error, and its readbacks reject (a draw-only path is a later
  addition). `setSource(null)` returns to the own
  buffers, whose contents were kept. While a source is set, `spawn`,
  `kill`, `killList`, `write` and `clear` throw INVALID_ARGUMENT and
  allocation `'gpu'` is refused. `setSourceCount(n)` sets the draw (and
  step) range; it travels in the existing `SWARM_DRAW.drawCount` /
  `SWARM_STEP.activeCount`, so it costs nothing extra per frame. Picking
  works as for own buffers.
- **Ordering:** external work must be submitted on the same queue before
  `renderer.render()`; cozygpu submits inside render(), so queue order
  makes it visible. WebGL2 callers must call `interop.invalidateState()`
  after their own GL calls and before the next render().
- **Device loss:** the core drops every registration (`lossEpoch` bumps,
  `ExternalInstanceBuffer.valid` turns false), and the Swarm drops its source
  with them, so it is back on its own (now empty) buffers. `onRestore`
  therefore runs with `spawn` / `write` available and must refill the cold
  records a draw-only source still reads colour, frame and user id from; a
  swarm that only re-registered its hot buffer would draw fully transparent
  quads. After the `deviceRestored` event the caller reads `interop.device`
  again, recreates its buffers, registers them and calls `setSource` again —
  the pre-loss handles are invalid, so a missed re-registration throws
  instead of drawing nothing. `examples/swarm/external.ts` is the reference.
- cozygpu never writes, resizes or destroys an external buffer. Releasing
  a registered buffer that a swarm still uses makes that swarm draw
  nothing until a new source is set.
- Readbacks (`readHot`, `readCold`, `aliveCount`) of an external source
  need COPY_SRC (WebGPU); otherwise they reject with UNSUPPORTED. A
  released or lost source rejects with UNSUPPORTED ('source unreadable'); an
  `aliveCount` asked while the source is gone waits until the swarm has
  buffers again. The range is clamped to min(capacity, hot records, cold
  records).
- **Switch ordering (as built):** a source switch never lands after a
  dispatch in the same frame. Spawns and writes queued before `setSource()`
  go to the own buffers and the switch takes effect the next frame; a step
  queued in that frame is dropped (the deferred-write rule). `activeCount`
  keeps meaning the own buffers' active range.
- WebGL2 `importBuffer` accepts a buffer only if `gl.isBuffer()` does (it
  must have been bound once). An imported buffer's usage is STORAGE
  (WebGPU) or VERTEX (WebGL2), plus COPY_SRC when the native GPUBuffer has
  it.

### 19.5 Readback pacing tuning

The M2 pacing (§7.1) fixed uncapped pick latency but skips 11–24% of frames
in the A3 churn bench, and on WebGL2 it seems to trigger when the queue is
not really behind. With the readback ring (§19.6) a pick no longer waits on
a promise chain, so pacing can be narrowed:

- Pace only while a pick or readback is **in flight** (not for a fixed
  1000 ms window after the last request).
- Re-measure `PACE_FAST_MS` / `PACE_MAX_LAG_MS` (WebGPU) and `PACE_FRAMES`
  (WebGL2) against A2u (uncapped pick latency) and A3 (churn skipped
  frames). Target: A3 skips < 2% of frames, A2u not worse than M2
  (26.7 ms WebGPU, 10.8 ms WebGL2).
- A vsync-paced loop must still never hold a frame.

**As built (§7.1):** pacing only while a readback is in flight,
`PACE_FRAMES` = 3 on both backends, no queue fences. Measured (Apple M4,
Chrome headless, `benchmarks/results/m25-a3s2.md`, `m25-pick.md`): A3 skips
**0 frames inside the measured window** on every backend (the harness now
reports `measuredSkippedFrames`); every whole-run skip falls in the finish
phase, where the final `aliveCount()` waits behind the queue built up by
uncapped submits. A2u (uncapped pick latency, avg / p50): WebGPU 4.2 /
3.9 ms, WebGL2 p50 7.7 ms (avg 8.0 ms in the clean run; see §7.1 for the
first-pick outlier), worker 3.7 ms, all better than M2 (26.7 / 10.8 ms).

### 19.6 Picking staging ring

M2 picking allocates a staging buffer, a copy and promises per pick (about
30 KB per frame while picking, M2 report §6). M2.5 replaces
`readTexture` in picking with a persistent ring:

- RHI: `backend.createReadbackRing({ slots, slotBytes })` →
  `RhiReadbackRing` with `acquire()`, `copyTexture(list, slot, texture, x,
y, w, h)`, `poll(slot)` → `ReadbackState` (FREE, PENDING, READY,
  FAILED), `data(slot)` (a reused `Uint32Array`), `release(slot)`.
  WebGPU: MAP_READ|COPY_DST buffers; the list's `submit()` starts
  `mapAsync` for the slots copied in that list, and `poll` checks
  `mapState === 'mapped'`, copies the bytes into the persistent view and
  unmaps. WebGL2: PIXEL_PACK buffers plus `fenceSync`; `poll` checks the
  fence without blocking, then `getBufferSubData` into the view.
- Core picking: `render()` renders the pick pass per request and records
  `copyTexture` into an acquired slot (4 slots, `PICK_RESULT_BYTES` each;
  requests wait when every slot is busy). `CorePicking.poll()` runs at the
  start of every packet (§2, step 0), posts `pick` for READY slots (a
  reused message object in local mode) and fails FAILED slots with
  DEVICE_LOST.
- Result: no library allocation per pick beyond the promise that
  `renderer.pick()` returns (and what the native API itself returns:
  WebGPU's `mapAsync` promise, WebGL2's sync object).
- **Answered when the readback lands (as built):** besides the poll at the
  start of every packet, RenderCore sets the backend's `onReadbackLanded`
  once picking exists; WebGPU calls it from the ring slot's existing
  `mapAsync` handler, WebGL2 from a 1 ms fence watch that runs only while a
  ring slot is in flight (one pre-bound callback, nothing allocated per
  tick). The pick is answered then instead of in a later render(). A2
  (vsync) latency: WebGPU 4.0 ms, WebGL2 4.8 ms, worker 3.5 ms (M2: 6.4 /
  8.1 / 6.2 ms; answering only in the next render() measured about 18 ms).
- The ring (and `readTexture`, and WebGL2 `readBuffer`) is a lazy chunk:
  `Backend.loadReadbackRing()` must resolve before `createReadbackRing`; the
  picking proxy awaits it with `pickingCoreImpl`. The front pick client is
  lazy too (§18.1): the first `pick()` is encoded in a render() after its
  chunk loaded.
- `CorePicking.afterSubmit` is unused since M2.5 (the ring maps inside the
  command list's submit).
- `Backend.readTexture` stays for other callers and tests.

### 19.7 Swarm CPU measurement check

M2 report §4: on the WebGPU Swarm bench, "CPU" rose from 0.19 to 4.84 ms at
1M while frame time did not change and front CPU is 0; the likely cause is
the wait for the next swap texture (`getCurrentTexture`) falling inside the
timed callback. Verify it: time `render()` with the swap-texture
acquisition excluded (or moved before the timer), confirm front and core
CPU at 1M are back near 0.2–0.3 ms, and report the numbers.

**Answered (M2.5):** it was the swap-texture wait, not work. WebGPU S2,
vsync off, Apple M4, Chrome headless:

| objects | harness CPU | inside `getCurrentTexture` | real core + front CPU |
| ------: | ----------: | -------------------------: | --------------------: |
|    100k |    0.025 ms |                   0.016 ms |              ≈0.01 ms |
|      1M |     6.59 ms |       6.55 ms (max 243 ms) |              ≈0.05 ms |
|      2M |    16.08 ms |                   16.06 ms |              ≈0.02 ms |

At 1M, `queue.submit` is 0.043 ms per frame and `writeBuffer` 0.002 ms;
front CPU is 0.005 ms. The harness now wraps
`GPUCanvasContext.prototype.getCurrentTexture` for every WebGPU library,
reports that time as **swap wait** and subtracts it from CPU
(`benchmarks/src/harness.ts`; S2 1M after the change: CPU 0.07 ms, swap
wait 6.0 ms).

### 19.8 Recipe: using cozygpu with an ECS

`docs/recipes/ecs.md` and `examples/ecs-columns/` (built automatically:
any `examples/<name>/main.ts`, linked from `examples/index.html`). The
example uses **plain typed arrays** as its "ECS" (no dependency); the prose
names cozyECS as one option and shows where its columns plug in. It must
show:

- Entities as rows of `Float32Array` / `Uint32Array` columns; one container
  whose children are interchangeable sprite slots; `bindColumns` once,
  `commit(count)` per frame.
- Removal by swap-remove: the ECS moves the last row into the hole, the
  example removes the last child, and the next commit rewrites the moved
  row. Growth: new arrays, `binding.rebind(...)`, add children.
- `userId` = entity id, so `await renderer.pick(x, y)` answers with
  `hit.userId` directly (and a Swarm instance's `cold.user`).
- An events sink that is a tiny object with `emit(name, payload)`
  forwarding to the app's own bus; `GPU.Events` for typing.
- Zero allocations per frame in the loop (a note on how to check it).
- `?backend=` and `?worker=1` like every example (`bindColumns` and events
  work in worker mode; interop does not).

### 19.9 Frozen M2.5 contract additions

| file                         | additions                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/scene/types.ts`         | `NodeOptions.userId`, `SceneNode.userId`; `ContainerNode.bindColumns`; `BulkField.FRAME`, `USER_ID`; `ColumnSource`, `SpriteColumns`, `BindColumnsOptions`, `ColumnBinding`                                         |
| `src/types/events.ts` (new)  | `EventSink`, `Events`, `EventName`                                                                                                                                                                                  |
| `src/types/interop.ts` (new) | `ExternalLayout`, `ExternalInstanceBufferDesc`, `ExternalInstanceBuffer`, `RendererInterop`                                                                                                                         |
| `src/types/renderer.ts`      | `RendererOptions.events`, `PickHit.userId`, `Renderer.interop()`                                                                                                                                                    |
| `src/types/core.ts`          | `RendererHost._emit`, `CoreContext.getExternalBuffer?`, `CorePicking.poll?`, `RenderCore.interop?`, `CoreInterop`; pick texel doc on `CoreSystem.drawPick`                                                          |
| `src/types/transport.ts`     | `pick.userId?`, `Transport.interop?` (as built: `interop?(create)`, §19.4)                                                                                                                                          |
| `src/types/layouts.ts`       | `PICK_TARGET_FORMAT` = `'rgba32uint'`, `PICK_RESULT_BYTES` = 16, `PICK_TEXEL_OBJECT/INSTANCE/USER`; `SC_USER` doc                                                                                                   |
| `src/types/ids.ts`           | `ids.external`                                                                                                                                                                                                      |
| `src/swarm/types.ts`         | `SpawnOptions.user` doc (instance user id), `SwarmNode.setSource`, `setSourceCount`, `SwarmExternalSource`                                                                                                          |
| `src/backend/types.ts`       | format `rgba32uint`; `ReadbackRingDesc`, `ReadbackState`, `RhiReadbackRing`, `Backend.createReadbackRing` (+ `loadReadbackRing?`, as built); `ImportBufferDesc`, `Backend.native`, `importBuffer`, `resetState`     |
| `src/commands/opcodes.ts`    | `PROTOCOL_VERSION` 3; `SWARM_SET_SOURCE` (0x030D); `SwarmSourceFlag`                                                                                                                                                |
| `src/index.ts`               | type exports `Events`, `EventName`, `EventSink`, `RendererInterop`, `ExternalInstanceBuffer(Desc)`, `ExternalLayout`, `SpriteColumns`, `ColumnSource`, `BindColumnsOptions`, `ColumnBinding`, `SwarmExternalSource` |

**All implemented by the end of M2.5** (see §19.1–§19.7 "as built"). As
frozen, the stubs that threw `CozyGPUError('NOT_IMPLEMENTED')` (or rejected
with it) so `tsc` and `jest` passed were: `NodeBase.userId` (get and set),
`Container.bindColumns`, `Swarm.setSource`, `Swarm.setSourceCount`,
`RendererImpl.interop`, `createReadbackRing` / `native` / `importBuffer` /
`resetState` in both backends. `RendererImpl._emit` is a no-op stub (so
callers may use it already), `PickHit.userId` is 0 in `picking.ts` until
renderer-hooks resolves it, and the recording `FakeBackend` implements
`native` / `importBuffer` / `resetState` (its ring throws).

Conformance edits made with the freeze so the tree keeps working: the
`rgba32uint` format in both backends (`convert.ts`, `commands.ts`,
`formats.ts`, `glconst.ts`, `utils.ts`) and `vec4u` pick outputs in
`sprite.wgsl` and `render.wgsl` (the GLSL pick shaders already wrote
`uvec4`). The Swarm pick texel's user id is still 0 until swarm-hooks
fills it.

## 20. Later milestones (design notes only)

The following are **not** part of M2 or M2.5. Masking, filters, text and
particles were designed and frozen for M3: see §21–§24.

- **Per-renderer dirty tracking.** Dirty bits are process-wide, so one
  node tree drawn by two renderers can miss updates.
- **External sprite instances.** A consumer for the reserved
  `'sprite-instance'` external layout (an instanced sprite drawable fed by
  outside GPU code, §19.4).
- **Bounds readback, camera API** (`SET_VIEW` from a public camera),
  custom blend factors, a public render-to-texture API (M3 has the pooled
  targets but keeps them internal, §22.4), WebGPU compatibility-mode swarm
  fallback via transform-style ping-pong textures.
- **Masks and filters in picking** (§21.5): the pick pass ignores both in
  M3, so a pick inside a masked group hits unclipped geometry.
- **Text shaping** beyond kerning: no bidi, no complex-script shaping and
  no ligatures. The Canvas2D path inherits whatever the browser does per
  glyph, not per run.

## 21. Masking (M3)

Files: `src/masks/**`, `src/shaders/mask/**`, `examples/masking/**`, plus
the render-group seam in the scene packer (§21.4) and the stencil additions
to the RHI (§21.3). Public API: `docs/API.md` "Group: masks and filters".

### 21.1 Shape of the feature

A mask clips the subtree of a **`Group`** (`src/scene/Group.ts`, §21.4), not
of every Container: an effect is a batch boundary and may cost a render
target, and keeping it off `Container` keeps every byte of mask and filter
code out of programs that never use one (§22.8).

```ts
const panel = new GPU.Group();
panel.mask = shapeSprite; // pixels of a sprite
panel.mask = { x: 0, y: 0, width: 300, height: 200 }; // a rect
panel.mask = { source: shapeSprite, invert: true, mode: 'stencil' };
panel.mask = null; // remove
```

The mask source is a `SceneNode` (its drawn pixels) or a rect in the
group's parent space. A node used as a mask does not have to be in the
scene tree; when it is, it also draws normally.

### 21.2 Choosing the implementation (normative)

`mode: 'auto'` (the default) picks the cheapest implementation that is
correct for the mask:

| condition                                                                             | implementation                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| a rect, or a single sprite whose world 2×2 has no rotation/skew and no negative scale | **scissor** — `RenderPass.setScissor`, no draw, no target |
| any other geometry, with `caps.stencil`                                               | **stencil**                                               |
| `caps.stencil` false, or the mask has soft edges (`mode: 'alpha'`)                    | **alpha** (render to texture)                             |

- A mask whose texels are binary (scissor, stencil) uses
  `threshold` (default `MASK_ALPHA_THRESHOLD`) to decide what masks.
- An explicit `mode` that the backend cannot do falls back to 'alpha' and
  emits one `error` event (§19.2); it never silently draws unclipped.
- `invert` flips the test. Scissor cannot invert a rect that does not touch
  the canvas edge, so an inverted rect mask goes to stencil (or alpha).
- **'auto' cannot see a soft edge.** It looks at geometry, not texels, so an
  unrotated sprite with a feathered texture resolves to scissor and clips to
  a hard rectangle. Ask for `mode: 'alpha'` by name when the mask's own alpha
  ramp is the point (`examples/masking` does).
- **As built, 'auto' never picks stencil on WebGPU.** WebGPU binds stencil
  state to the pipeline and forbids a pipeline without a depth-stencil state
  in a pass that has a depth-stencil attachment, so attaching the buffer
  mid-frame would invalidate every sprite and swarm draw. Until those
  pipelines declare stencil state, WebGPU masks resolve to scissor or alpha
  and an explicit `mode: 'stencil'` falls back to alpha. WebGL2 uses stencil
  as described. Cost of lifting it: the sprite and swarm pipelines are
  created with `depthFormat: MASK_STENCIL_FORMAT` and `stencil: { compare:
'equal', writeMask: 0 }`, and RenderCore always attaches a
  `depth24plus-stencil8` target to the main pass — one canvas-sized
  depth-stencil texture per renderer, on every program whether it masks or
  not.

### 21.3 Core side and the pass break

The mask core system (`src/masks/core.ts`, range `0x04`) owns:

- **Mask instance buffers.** The front packs mask quads into a buffer with
  the ordinary sprite instance layout (`SPRITE_INSTANCE_BYTES`) and uploads
  them with `MASK_UPLOAD`. Masks are small (1–50 quads), so this
  buffer is separate from the sprite one and is only rewritten when the
  mask moves. `MASK_UPLOAD_SHARED` stays in the opcode table but is never
  emitted and the core does not handle it: a few dozen quads always travel
  inline, so the shared-memory path would only add code.
- **The scissor stack.** `MASK_PUSH_SCISSOR` intersects with the rect
  already in force and `MASK_POP` restores the previous one. Nesting is
  therefore free.
- **The stencil attachment.** The main pass has no depth/stencil buffer, so
  the first `MASK_PUSH_STENCIL` of a frame carries `CommandFlag.PASS_BREAK`:
  RenderCore ends the open pass, calls `CoreSystem.passBreak`, and the mask
  system returns a `RenderPassDesc` for the same color target with
  `load: 'load'` plus `depth: { target: stencilTexture, stencilLoad:
'clear' }`. Everything after that draws with the stencil attached, so at
  most **one break per frame** is needed however many stencil masks there
  are. Masked draws use pipelines with `stencil.compare: 'equal'` and
  `writeMask: 0`; the mask itself draws with `passOp: 'increment-clamp'`
  and `colorWriteDisabled`, and `setStencilReference(depth)` selects the
  nesting level (up to `MASK_MAX_DEPTH`).
- **Alpha masks.** `MASK_PUSH_ALPHA` breaks to a pooled target (the pool
  belongs to filters, §22.4, so there is one pool in the library), the
  subtree renders there, and `MASK_POP` breaks back and composites the
  target multiplied by the mask's alpha. This is the only mask that costs
  a target, and it is the only one that is continuous rather than binary.

`CommandFlag.PASS_BREAK` (bit 2) is the general mechanism, also used by
filters:

1. RenderCore replays DRAW commands in stream order as before.
2. A command with PASS_BREAK whose system has `passBreak`: the open pass is
   ended, `passBreak(reader, list, frame)` runs (it may record whole passes
   on the frame's CommandList), and the pass it returns is opened — `null`
   means "the frame's main pass again, with `load: 'load'`".
3. The command's own `draw` then runs inside that new pass.

With `antialias: true` every break resolves the MSAA target, so a frame
with many groups costs one resolve per break; §22.4 keeps the count low by
merging adjacent groups' passes where it can. Two things follow from MSAA
and are implemented:

- A pass that will be reopened must keep its multisampled attachment.
  RenderCore counts the PASS_BREAK commands of the packet while it collects
  the draw offsets and sets `RenderPassDesc.color.keepMultisampled` on the
  main pass when there is at least one; otherwise the attachment is
  discarded after its resolve, as before. Without this the first break
  throws away everything drawn before it.
- A capture target that the group's own sprites draw into has to match the
  main pass' sample count, because those sprites use the main pipelines. An
  alpha mask and a filter capture therefore acquire a multisampled
  attachment that resolves into the single-sampled texture everything
  downstream samples. `KEEP_TARGET` cannot load a multisampled attachment
  from a resolved texture, so under MSAA a kept filter target starts each
  frame cleared.
- `CoreContext.mainPass` is the descriptor of the frame's main pass, with
  its colour attachment and resolve target already set. A system's
  `passBreak` copies that colour entry when it reopens the main pass
  differently — the mask system adds its `depth` entry to it, which is what
  makes stencil masks work under MSAA.

### 21.4 The render-group seam in the packer

`Group` implements `RenderGroup` (`src/types/core.ts`):
`_emitGroupBegin(frame, world, worldOffset, worldAlpha) → boolean` and
`_emitGroupEnd(frame)`. The scene packer (`src/sprites/front.ts`) treats a
group like a `CustomDrawable` that has children:

- the structure pass gives it its own kind (`KIND_GROUP`) and **ends the
  current batch** at both the begin and the end of the group, exactly as a
  CustomDrawable does — a group is never merged into a neighbouring batch;
- the draw pass calls `_emitGroupBegin` with the group's world transform
  (already computed by the transform pass) before the subtree's batches, and
  `_emitGroupEnd` after them. Commands are emitted in draw order, exactly as
  a CustomDrawable's `_emitDraw` is;
- when `_emitGroupBegin` returns false the whole subtree is skipped for
  that frame (nothing is emitted, no instance indices move): the group's
  effect chunk or its core system has not loaded yet. A mask must never
  flash unclipped content. The packer skips forward to the matching
  `BATCH_GROUP_END`, counting nested begins, so an inner group is skipped
  with its outer one.

Nesting works because push/pop are stream commands: masks nest up to
`MASK_MAX_DEPTH`, and a group can carry both a mask and filters (the
filter capture opens first, the mask applies inside it).

**A live group puts the packer on full structure rebuilds.** A group spans a
range of batches, and the incremental splice (§16.2) describes a batch by
one flat index, which cannot express a range that the patched region may sit
inside, contain, or end exactly at. `nodeStore.groups` counts live `Group`
nodes and `pack()` takes the full rebuild while it is non-zero. Groups are a
handful of nodes in a scene, so this costs a DFS of the tree on structure
changes; the 100k-sprite incremental path is untouched for scenes without
groups. Lifting it means giving the batch list a begin/end pair the splice
can move as a unit.

### 21.5 Interaction with picking and batching

- Picking ignores masks and filters in M3: the pick pass replays the same
  DRAW commands, and the mask and filter systems have no `drawPick`, so a
  pick inside a masked group hits the unclipped geometry. This is a known
  limitation; the alternative (replaying mask state into the 1×1 pick pass)
  is cheap for scissor and stencil and should be the first improvement.
- Every group costs at least two extra commands and one batch split. A
  screen full of individually masked sprites is the wrong shape for this
  API; mask one group of many sprites instead.

### 21.6 Loading, worker mode and readiness

Masks are lazy in both modes:

- **Main thread.** `Group` imports `src/masks/mask.ts` on the first `mask`
  assignment. That module registers the core system factory
  (`registerCoreSystemFactory`) and both halves travel in the `mask-core`
  chunk, so the renderer can take MASK commands as soon as the chunk lands.
  `group.ready` resolves then; `GPU.loadEffects()` preloads.
- **Worker.** `src/worker/entry.ts` registers a _loader_ for the mask and
  filter ranges, and the worker host holds a packet that carries commands
  of a range whose chunk is still loading (the mechanism swarm has used
  since M2, §17). The front therefore never waits on `isSystemReady` for
  these ranges.
- Mask and filter opcodes live in their own `MaskOp` / `FilterOp` tables
  rather than in `Op`, because a const object is tree-shaken as a whole and
  its properties are not.

## 22. Filters (M3)

Files: `src/filters/**`, `src/shaders/filter/**`, `examples/filters/**`,
plus the sprite-effect branch in the sprite shaders and the effect binding
in the sprite core (§22.7). Public API: `docs/API.md` "Group: masks and
filters".

### 22.1 Shape of the feature

```ts
const world = new GPU.Group();
world.filters = [
  GPU.filters.blur({ strength: 4 }),
  GPU.filters.colorMatrix().saturate(0.5),
];
world.filterOptions = { resolution: 0.5 };
```

A chain applies to the group's whole subtree. Full-screen effects wrap the
scene in a group (`renderer.stage` itself stays a plain Container, so the
minimal program carries nothing).

### 22.2 The pass structure (normative)

1. `FILTER_BEGIN` (DRAW | PASS_BREAK) — the core acquires a target for the
   group's **filter area** and opens a pass into it, cleared to transparent
   black (or kept, with `keepTarget`). The group's own draw commands follow
   in the stream and land there unchanged.
2. `FILTER_END` (DRAW | PASS_BREAK) — `passBreak` records one full-screen
   pass per enabled filter (per `passes` of its definition), ping-ponging
   between two pooled targets, then returns the pass that was interrupted;
   the command's `draw` composites the final target with one quad, using
   `filterOptions.blendMode` and the group's world alpha.

Filters run in **physical pixels** on premultiplied data. The view uniform
is bound at group 0 as everywhere else, the source texture + sampler at
group 1, and the per-pass uniform (prelude `FILTER_PASS_BYTES`, then the
filter's own params) at group 2 with a dynamic offset.

### 22.3 Custom filters

`GPU.defineFilter({ name, params, defaults, wgsl, glsl, passes, padding })`
returns a factory, mirroring `defineBehavior`. The fragment entry, the
bindings and the `$params.<name>` rewrite are specified on
`FilterDefinition` in `src/filters/types.ts`; a filter without a shader for
the renderer's `caps.shaderLanguage` reports UNSUPPORTED once and is
skipped while the rest of the chain runs. Sources travel to the core with
`FILTER_DEFINE` once per filter (and again after a device loss); uniform
changes are `FILTER_SET_UNIFORMS`, never a recompile.

### 22.4 Target pool, area and resolution (normative)

`src/filters/targets.ts` keeps one pool per renderer, keyed by
(width, height, format, sampleCount) after rounding each dimension up to
`FILTER_TARGET_GRANULARITY` (64) physical pixels, so a group that changes
size a little keeps the same texture. Targets are acquired for the duration
of a frame and released in `endFrame`; a target unused for
`TARGET_IDLE_FRAMES` frames is destroyed. **Nothing is allocated in a
steady-state frame.**

- **Area.** By default the group's bounds, grown by the chain's largest
  `padding` and clipped to the canvas. `filterOptions.area` overrides it,
  which is also how an app avoids recomputing bounds for a group it already
  knows the extent of. As built, `area` is read in canvas/css space rather
  than the group's parent space; the two differ only once a camera
  `SET_VIEW` is in play, which M3 has no public API for.
- **Resolution.** The target is `area × dpr × filterOptions.resolution`
  (default 1); `FilterFlag.HALF_RESOLUTION` halves it again for the passes
  of one filter. Blur chains normally run at 0.5.
- The pool is also what alpha masks use (§21.3), so the library never holds
  two pools.
- **As built, the capture target is canvas-sized, scissored to the filter
  area, not area-sized.** The group's own sprites are drawn by the sprite
  pipeline with the frame's View uniform bound at group 0, and nothing in
  the RHI or `CoreContext` lets a system rebind group 0 for one pass, so an
  area-sized target would move every sprite (a negative viewport origin, the
  other way out, is invalid in WebGPU). Only the area's texels are ever
  shaded and the pool means every group at one resolution shares two or
  three textures, so the cost is bounded — but memory is canvas-sized.
  Making it area-sized needs a dynamic-offset View bind group or a
  `CoreContext.viewBindGroupFor(area)`.
- The intermediate chain targets are never multisampled: the chain
  pipelines are single-sampled and the composite draw is a single quad. The
  **capture** attachment is the exception — see §21.3.

### 22.5 Front side

`src/filters/filters.ts` resolves each `Filter` to a program (loading
`filters-builtin` when the chain uses a built-in), keeps the uniform
mirrors, computes the area, and emits the commands. It has zero allocations
per frame once the chain stopped changing: values are written into a
per-filter `Float32Array` mirror and uploaded only when dirty.

### 22.6 Built-ins

| filter         | passes                      | cheap   | notes                                                                                                                                                                                                 |
| -------------- | --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blur`         | 2 (separable) or 4 (Kawase) | no      | `quality: 'fast'` = dual Kawase down/up, much cheaper at large radii; `axis` limits it to one direction                                                                                               |
| `colorMatrix`  | 1                           | yes     | chainable helpers (`saturate`, `hue`, `contrast`, `tint`, …) build a 4×5 matrix                                                                                                                       |
| `displacement` | 1                           | no      | samples a map texture, offsets by two channels                                                                                                                                                        |
| `outline`      | 1 (+ padding)               | not yet | the in-batch path needs a text-only signal the packer does not give the front, so it always runs as one pass; correct for every kind of content, but it costs a target where §22.6 promises otherwise |
| `glow`         | blur + additive composite   | no      | `innerStrength` keeps the source on top                                                                                                                                                               |

### 22.7 Cheap effects: staying inside the sprite batch (normative)

A chain whose entries are **all cheap** never takes a render target. The
filter front compiles it into one `SPRITE_EFFECT_BYTES` block (a 4×5 color
matrix plus outline color/width and glow softness), sends it with
`SPRITE_DEFINE_EFFECT`, and the group emits `SPRITE_SET_EFFECT(effectId)`
before its subtree and `SPRITE_SET_EFFECT(0)` after it. The sprite core
binds the effect uniform (dynamic offset, stride 256) for the draws in
between and the sprite fragment shader applies it:

- `color' = clamp(matrix · color + offset)` on straight-alpha color, before
  premultiplication — so tint, saturation, hue, contrast and grayscale cost
  one mat4 multiply and no pass;
- with `SpriteInstanceFlag.SDF_OUTLINE` (text) the same block's outline
  color/width draw the glyph's outline band from the distance field.

Rules:

- Cheap and expensive filters can be mixed: the leading run of cheap
  filters folds into the batch and the rest still takes a target.
- The effect is per batch, not per instance: a group with a cheap chain
  splits the batch at its edges, like any other group, but adds no
  per-instance bytes (the instance record stays 40 B).
- `SPRITE_SET_EFFECT` is only emitted by a scene that uses effects; every
  packet starts at effect 0.

### 22.8 Why effects live on `Group`

Measured at the M3 freeze: putting `mask` and `filters` accessors on
`Container` costs the minimal program about 0.2 KB min+gzip and pulls the
resolution logic onto the minimal path, for a feature most programs never
use. `Group` is exported from `src/index.ts` as a value, so a program that
does not reference it is tree-shaken clean, and the mask and filter code is
only reachable through it (§18.1).

## 23. Text (M3)

Files: `src/text/**`, `src/shaders/text/**` (if a variant ever needs its
own program), `examples/text/**`, `src/assets/font.ts` and the MSDF branch
of the sprite shaders (§23.3). Public API: `docs/API.md` "Text".

### 23.1 Shape of the feature

```ts
const font = await renderer.assets.load<GPU.FontAsset>({
  url: 'fonts/inter.json',
  kind: 'font',
});
const label = new GPU.Text('Score: 0', { font: font.value, size: 24 });
stage.addChild(label);
label.text = 'Score: 1'; // re-lays out the tail only
```

`style.font` is either a loaded `FontAsset` (MSDF, the default path) or a
`SystemFont` descriptor (`{ family: 'Menlo' }`), which selects the Canvas2D
path (§23.5).

### 23.2 A Text is a Container of glyph sprites (normative)

`Text extends Container` and owns its children: one `Sprite` per visible
glyph, in reading order. This is deliberate:

- glyph quads are ordinary sprite instances, so they upload through the
  sprite instance buffer, **batch with the sprites around them** when they
  share the atlas page, and cost nothing new in the packer;
- picking, `userId`, masks and filters work on text with no extra code;
- transforms, alpha and tint come from the existing node store.

The cost is one node per glyph (about 200 B of store). Text is a UI
feature; a scene with 100k glyphs should use several `Text` nodes, not one
per character. Whitespace produces no child.

### 23.3 MSDF rendering

An MSDF font asset is the atlas JSON of msdf-atlas-gen / msdfgen plus its
page image. `kind: 'font'` (§15.2) loads the JSON, resolves the page
through the same `AssetsApi` (so it is cached, refcounted and budgeted like
any texture) and parses metrics in `src/text/msdf.ts`.

Glyph sprites from an MSDF page set `SpriteInstanceFlag.MSDF`. The sprite
fragment shader (both languages) gains one branch:

```
coverage = clamp((median(t.r, t.g, t.b) - 0.5) * distanceScale + 0.5, 0, 1)
```

**As built, `distanceScale` is derived from `fwidth` of the sampled median
alone** — the screen-space derivative of the field itself — not from the
font's `distanceRange` through the per-batch effect block. That is a
deliberate deviation from the first draft of this section: it needs no
uniform, no pipeline variant per font and no effect bound at all, which is
what lets glyph sprites batch with plain sprites. `FontAsset.distanceRange`
is still parsed and exposed. Following the original wording later means
`clamp(sd * screenPxRange + 0.5, 0, 1)` with `screenPxRange` from the effect
block. WGSL rejects `fwidth` in non-uniform control flow, so all three
sprite shaders evaluate the coverage before branching on the flag.

`SpriteInstanceFlag.SDF_OUTLINE` is specified but **not implemented**:
nothing sets the flag and the shaders do not read it. It needs the outline
colour and width from the per-batch sprite effect block
(`SE_OUTLINE_COLOR` / `SE_OUTLINE_WIDTH` / `SE_GLOW`, which the filter work
does pack and bind) plus a `stroke` / `strokeWidth` pair on `TextStyle`.
The branch is the only text-specific GPU code; there is no text core system
and no text opcode range.

### 23.4 Layout (front, DOM-free)

`src/text/layout.ts` (chunk `text-core`) does line breaking (`wrap: 'word' |
'char' | 'none'`), alignment (including `justify`), baseline placement,
`letterSpacing` / `wordSpacing`, kerning, `maxLines` and `ellipsis`, and
writes the resulting quads into the glyph sprites. It runs on the front in
both renderer modes and touches no DOM.

**Incremental updates.** Assigning `text` compares the new string with the
old one from the front, finds the first differing code point, and re-lays
out from there: glyph sprites before it keep their positions and are not
even marked dirty. Glyph children are reused in place, the list only grows
or shrinks at the tail, so a counter that changes its last two digits
rewrites two instances and moves no batch boundary.

`text.metrics` reports width, height, line count, first baseline and glyph
count as of the last layout; `text.ready` resolves after the first layout
(the chunks and, for a canvas font, the first rasterisation).

### 23.5 Canvas2D fallback

`src/text/canvas.ts` (chunk `text-canvas`) rasterises glyphs on demand at
`SystemFont.atlasSize` into shared atlas pages with the asset loader's
skyline packer, uploads them through the normal texture path and hands the
layout pass ordinary sub-textures. It covers arbitrary installed fonts,
emoji and scripts no pre-baked atlas has.

- Front side only. It uses `OffscreenCanvas` when the page has it, a canvas
  element otherwise — never in core code, so worker mode is unaffected (the
  front is the main thread in both modes).
- Canvas glyphs do not set the MSDF flag: they are ordinary alpha texels
  and blur when scaled far past their atlas size.
- A missing glyph makes `GlyphSource.ensure` return a promise; the Text
  re-lays out when it resolves. Steady-state frames return null and
  allocate nothing.

### 23.6 Device loss and worker mode

The font atlas is an asset, so `Assets` reloads it after
`deviceRestored` like any texture (§15.7) and glyph sprites keep their
handles. Canvas atlas pages are re-rasterised from the cached glyph list.
Nothing about text is core-side, so worker mode needs no text code in the
worker bundle.

## 24. Particles (M3)

Files: `src/particles/**`, `examples/particles/**`, and the over-life curve
support in `src/swarm/**` and `src/shaders/swarm/**` (§24.4). Public API:
`docs/API.md` "Particles".

### 24.1 Shape of the feature

```ts
const fx = new GPU.Particles({
  capacity: 200_000,
  texture: spark,
  emitter: {
    rate: 5000,
    shape: { disc: { radius: 20 } },
    speed: [40, 120],
    life: [0.4, 1.2],
  },
  over: { color: ['#fff', '#f80', '#00000000'], size: [4, 0] },
});
stage.addChild(fx);
fx.emitter().moveTo(x, y);
```

`Particles` owns a `Swarm` (`fx.swarm`) and forwards the scene node
surface to it. Everything it adds compiles down to what Swarm already
does — there is no second simulation path.

### 24.2 What compiles to what (normative)

| declarative                                                    | compiles to                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `shape`, `speed`/`direction`, `size`, `life`, `color`, `frame` | `SpawnOptions` + `SpawnFlag` bits (disc position, polar velocity, uniform scale)                                |
| `rate`                                                         | a fractional accumulator; one `SWARM_SPAWN` per emitter per frame                                               |
| `burst`                                                        | a scheduled count added to the same accumulator                                                                 |
| `color` / `alpha` / `size` over life                           | the `SWARM_CURVE_BYTES` block, evaluated in the RENDER shader                                                   |
| `rotation` / `drag` over life                                  | generated behaviors (WGSL + GLSL) appended before the user's                                                    |
| `group`                                                        | `SpawnOptions.group` → `cold.flags` bits, so one Particles can run several populations with different behaviors |

### 24.3 The zero-CPU-per-object rule

Per frame the front does, per **emitter** (not per particle): advance the
accumulator, write at most one SpawnParams block, emit one `SWARM_SPAWN`.
Nothing walks particles, nothing uploads per-particle data, and the packet
stays a few hundred bytes at any capacity — the Swarm budgets of §10 hold
unchanged. `moveTo` writes two floats into the emitter's spawn block.

### 24.4 Over-life curves

Curves are 4 stops (`SWARM_CURVE_STOPS`) at normalized ages, uploaded once
with `SWARM_SET_CURVES` and read by the render shader when
`SwarmRenderFlag.CURVES` is set: `t = age / life`, then a piecewise-linear
lookup for packed color, size multiplier and alpha multiplier. This keeps
color animation off the simulation entirely — there is no per-frame write
to the cold buffer, and immortal objects simply stay at stop 0. It
supersedes the M1 `fadeOut` / `shrink` flags, which remain as the cheap
special cases.

Curves that must affect motion (`rotation`, `drag`) cannot live in the
render shader: they compile to generated behaviors whose params carry the
stops, so they run in the step shader like any other behavior and work on
both backends.

### 24.5 Backends and allocation

- **WebGPU.** Anything Swarm supports: `allocation: 'ring'` by default,
  `'gpu'` when the app wants a free list (mortal particles reusing slots
  without CPU knowledge, §14.3).
- **WebGL2.** Transform feedback only: `allocation: 'ring'`, capacity
  within `SWARM_GL_MAX_CAPACITY`, every generated behavior must have its
  GLSL variant (the compiler emits both, always). Particles therefore need
  a finite `life`; `life: 'immortal'` with a `rate` is refused with
  INVALID_ARGUMENT because a ring of immortal objects never frees slots.
- Deaths are GPU-side in every mode; `fx.swarm.aliveCount()` is the way to
  observe them, never a per-frame CPU count.

### 24.6 Presets

`GPU.particlePresets.fire/smoke/sparks/rain/confetti(options?)` return full
`ParticlesOptions` (emitter + curves + behaviors) that the caller can
spread and edit. They are data, not a second API: a preset is exactly what
the user could have written.

## 25. M3 contract additions

Every file below is settled for M3: implement against it, do not change a
signature. Where an implementation is missing it is a stub that throws
`CozyGPUError('NOT_IMPLEMENTED')` (or rejects with it), so `tsc` and `jest`
pass while the four features are built in parallel.

| file                           | additions                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/commands/opcodes.ts`      | `PROTOCOL_VERSION` 4; `CommandFlag.PASS_BREAK`; `OpcodeRange.MASK` / `FILTER`, `FIRST_LAZY_RANGE`; `SPRITE_DEFINE_EFFECT` / `SPRITE_DESTROY_EFFECT` / `SPRITE_SET_EFFECT`; `SWARM_SET_CURVES`; `MaskOp`, `FilterOp`, `MaskFlag`, `FilterFlag` |
| `src/types/layouts.ts`         | `SpriteInstanceFlag.MSDF` / `SDF_OUTLINE`; `SPRITE_EFFECT_BYTES` + `SE_*` + `SpriteEffectFlag`; `MASK_STENCIL_FORMAT`, `MASK_MAX_DEPTH`, `MASK_ALPHA_THRESHOLD`; `FILTER_*` + `FP_*`; `SWARM_CURVE_BYTES` + `SCV_*`, `SwarmRenderFlag.CURVES` |
| `src/backend/types.ts`         | `caps.stencil`; `CompareFunction`, `StencilOperation`, `StencilState`; `RenderPipelineDesc.stencil` / `.colorWriteDisabled`; `RenderPassDesc.depth.stencilLoad` / `.stencilClearValue`; `RenderPass.setStencilReference`                      |
| `src/types/core.ts`            | `RenderGroup`, `isRenderGroup`; `CoreSystem.passBreak?`                                                                                                                                                                                       |
| `src/scene/types.ts`           | `NodeKind` gains `'group'`; `GroupNode`, `GroupOptions`                                                                                                                                                                                       |
| `src/masks/types.ts` (new)     | `MaskRect`, `MaskSource`, `MaskSpec`, `MaskMode`, `MaskTarget`, `MaskBinding`, `CreateMaskBinding`                                                                                                                                            |
| `src/filters/types.ts` (new)   | `FilterParam*`, `FilterDefinition`, `Filter`, `ColorMatrixFilter`, `BuiltinFilters`, `FilterOptions`, `FilterBinding`, `CreateFilterBinding`                                                                                                  |
| `src/text/types.ts` (new)      | `GlyphMetrics`, `FontAsset`, `SystemFont`, `GlyphSource`, `TextStyle`, `TextOptions`, `TextMetrics`, `TextNode`                                                                                                                               |
| `src/particles/types.ts` (new) | `EmitterShape`, `EmitterOptions`, `Emitter`, `OverLife`, `ParticlePreset(s)`, `ParticlesOptions`, `ParticlesNode`                                                                                                                             |
| `src/assets/types.ts`          | `AssetKind` gains `'font'`; `FontAssetOptions`; `AssetDescriptor.font`                                                                                                                                                                        |
| `src/index.ts`                 | values `Group`, `loadEffects`, `filters`, `defineFilter`, `Text`, `Particles`, `particlePresets`, `loadParticles`; the matching types                                                                                                         |
| `scripts/size.mjs`             | minimal budgets 41 / 43 KB; seven M3 chunk targets                                                                                                                                                                                            |

Seams already wired into the shared files (fill in the implementation in
the named module; the call sites stay where they are):

- `src/scene/Group.ts` — stores `mask` / `filters` / `filterOptions`, loads
  the chunks, implements `RenderGroup` by delegating to `MaskBinding` and
  `FilterBinding`. Only those two bindings are yours.
- `src/masks/mask.ts` / `src/filters/filters.ts` — register their core
  system factory when loaded; `createMaskBinding` / `createFilterBinding`
  are the stubs to replace.
- `src/renderer/systems.ts` and `src/worker/entry.ts` — the mask and filter
  ranges already have their `LazyCoreSystem` placeholder and their worker
  loader.
- `src/renderer/RenderCore.ts` — the PASS_BREAK branch already calls
  `CoreSystem.passBreak`.
- `src/assets/Assets.ts` — `kind: 'font'` already dispatches to
  `src/assets/font.ts`.
- `src/text/Text.ts` — the shell already loads `layout` plus `msdf` or
  `canvas`; `layoutText` and `createGlyphSource` are the stubs to replace.
- `src/particles/Particles.ts` — the shell and `particlePresets`; the
  compiler in `src/particles/emitter.ts` is the stub to replace.
