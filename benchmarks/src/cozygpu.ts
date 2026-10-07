/**
 * cozygpu adapter, written against docs/API.md (M1 + M2).
 *   renderer webgpu → main-thread renderer, WebGPU backend
 *   renderer webgl2 → main-thread renderer, WebGL2 backend (M2)
 *   renderer worker → worker mode, WebGPU backend (worker bundle next to this file)
 * A silent backend fallback fails the run (the backend is requested explicitly
 * and checked against renderer.info.backend).
 *
 * S1/S3: GPU.Sprite children of a Container. S2: one GPU.Swarm with velocity +
 * bounds behaviors (compute on WebGPU, transform feedback on WebGL2).
 * A1: renderer.assets.loadAll of 200 PNG / KTX2 files, one Sprite each.
 * A2: S3 + renderer.pick() with one pick outstanding at a time.
 * A3: Swarm allocation 'gpu' (variant gpu) or 'ring' (variant ring), spawning
 * CHURN_SPAWN_PER_FRAME mortal objects every frame, stepped with SIM_DT.
 * S1b (M2.5, variant columns): S1, but the sim's x/y Float32Arrays are bound
 * once with `container.bindColumns` and each frame calls `binding.commit`.
 * M3 (variants in parentheses):
 *   T1 text: 200 GPU.Text labels of 50 glyphs, 20 replaced per frame
 *      (msdf: the example MSDF font via assets kind 'font'; canvas: a system
 *      font descriptor rasterised into a glyph atlas).
 *   F1 filtered: 100k static sprites in a Group with [blur, colorMatrix]
 *      (good: separable Gaussian; fast: dual Kawase), area = the canvas.
 *   M1m masked-moving: 10k sprites in a Group sliding under a fixed mask
 *      (scissor: rect; stencil: circle sprite, mode 'stencil' (WebGPU
 *      resolves it to alpha); alpha: circle sprite, mode 'alpha').
 *   P1 particles: GPU.Particles, one disc emitter, alpha/size over life,
 *      stepped with SIM_DT like the CPU emitter it is compared with.
 * M4 (Graphics; shapes and paths from common.ts, identical in pixi.ts):
 *   G1 graphics-static: N Graphics nodes, one mixed shape each, nothing moves.
 *   G2 graphics-animated: G1 with setPosition + rotation on every node.
 *   G3 graphics-redraw: N nodes, clear() + a resized shape every frame.
 *   G4 graphics-path: one curved path with N holes (cut()), rebuilt per frame.
 */
import * as GPU from 'cozygpu';
import {
  type Adapter,
  A1_SIZE,
  BACKGROUND,
  type BenchContext,
  CHURN_LIFE_MAX,
  CHURN_LIFE_MIN,
  CHURN_SPAWN_PER_FRAME,
  F1_BLUR,
  F1_HUE,
  F1_SATURATE,
  M1_RADIUS,
  M1_RECT,
  P1_END_SCALE,
  P1_LIFE_MAX,
  P1_LIFE_MIN,
  P1_RADIUS,
  P1_SIZE,
  P1_SPEED,
  PickStats,
  SIM_DT,
  SPEED_MAX,
  SPEED_MIN,
  SPRITE_SIZE,
  SPRITE_TEXTURE_SIZE,
  SWARM_SIZE,
  T1_CHANGE,
  T1_COLUMNS,
  T1_FILL,
  T1_LABELS,
  T1_POOL,
  T1_ROW,
  T1_SIZE,
  assetCell,
  assetUrl,
  gDraw,
  gPath,
  gPulse,
  gSpin,
  m1Offset,
  p1Capacity,
  p1Rate,
  rng,
  textPool,
} from './common';
import { start } from './harness';

function createCozyAdapter(ctx: BenchContext): Adapter {
  const { params } = ctx;
  const scenario = params.scenario;
  let renderer: GPU.Renderer | null = null;
  const sprites: GPU.Sprite[] = [];
  let swarm: GPU.Swarm | null = null;
  let columns: GPU.ColumnBinding | null = null;
  let spawnOptions: GPU.SpawnOptions | null = null;
  let aliveAtEnd = NaN;
  let skippedAtStart = 0;
  let measuredSkipped = 0;
  let assetInfo: Record<string, unknown> = {};
  // M3: per-frame work of the T1/F1/M1m/P1 scenarios (set by populate).
  let m3Frame: (() => void) | null = null;
  let group: GPU.Group | null = null;
  let particles: GPU.Particles | null = null;
  let m3Frames = 0;

  // A2 picking
  const picks = new PickStats();
  let pickPending = false;
  let pickT0 = 0;
  let pickFrame0 = 0;
  let frames = 0;
  let pickCursor = 0;
  let pickOrder: Uint32Array | null = null;
  const onPick = (hit: GPU.PickHit | null): void => {
    picks.add(performance.now() - pickT0, frames - pickFrame0, hit !== null);
    pickPending = false;
  };
  const onPickError = (): void => {
    pickPending = false;
  };

  const backend = params.renderer === 'webgl2' ? 'webgl2' : 'webgpu';

  function addSprites(texture: GPU.Texture): GPU.Container {
    const { sim } = ctx;
    const world = new GPU.Container();
    renderer!.stage.addChild(world);
    const scale = SPRITE_SIZE / SPRITE_TEXTURE_SIZE;
    for (let i = 0; i < sim.count; i++) {
      const s = new GPU.Sprite({
        texture,
        anchor: 0.5,
        x: sim.x[i],
        y: sim.y[i],
        scale,
      });
      sprites.push(world.addChild(s));
    }
    return world;
  }

  return {
    async init() {
      renderer = await GPU.createRenderer({
        canvas: ctx.canvas,
        worker:
          params.renderer === 'worker'
            ? { url: new URL('./cozygpu.worker.js', import.meta.url) }
            : false,
        backend,
        autoResize: false,
        width: params.width,
        height: params.height,
        resolution: 1,
        background: BACKGROUND,
        antialias: false,
        powerPreference: 'high-performance',
        limits:
          scenario === 'swarm' ||
          scenario === 'swarm-churn' ||
          scenario === 'particles'
            ? 'max'
            : 'default',
        assets:
          params.variant === 'noatlas'
            ? { atlas: false, gpuBudgetMB: 0 }
            : { gpuBudgetMB: 0 },
      });
      if (renderer.info.backend !== backend) {
        throw new Error(
          `cozygpu fell back to ${renderer.info.backend} (requested ${backend}): ${renderer.info.fallbackReason ?? ''}`,
        );
      }
    },

    async populate() {
      const r = renderer!;
      const { sim } = ctx;

      if (scenario === 'assets-png' || scenario === 'assets-ktx2') {
        const kind = scenario === 'assets-png' ? 'png' : 'ktx2';
        const sources: GPU.AssetSource[] = [];
        for (let i = 0; i < params.count; i++) {
          sources.push(new URL(assetUrl(kind, i), location.href).href);
        }
        const t0 = performance.now();
        const handles = (await r.assets.loadAll(
          sources,
        )) as GPU.AssetHandle<GPU.TextureAsset>[];
        const loadMs = performance.now() - t0;
        const world = new GPU.Container();
        r.stage.addChild(world);
        let entryBytes = 0;
        let packed = 0;
        const formats = new Set<string>();
        for (let i = 0; i < handles.length; i++) {
          const v = handles[i].value;
          entryBytes += v.gpuBytes;
          if (v.packed) packed++;
          formats.add(v.format);
          const c = assetCell(i);
          world.addChild(
            new GPU.Sprite({ texture: v.texture, x: c.x, y: c.y }),
          );
        }
        const s = r.assets.stats;
        assetInfo = {
          loadMs,
          assets: handles.length,
          formats: [...formats].join(','),
          packed,
          gpuBytes: s.gpuBytes,
          entryGpuBytes: entryBytes,
          atlasPages: s.atlasPages,
          textureBytesTheory:
            handles.length *
            (kind === 'png' ? A1_SIZE * A1_SIZE * 4 : (A1_SIZE / 4) ** 2 * 8),
        };
        return {
          cpuSim: false,
          tool: `Assets.loadAll (${kind}${params.variant === 'noatlas' ? ', atlas off' : ''})`,
        };
      }

      if (scenario === 'swarm' || scenario === 'swarm-churn') {
        const churn = scenario === 'swarm-churn';
        swarm = new GPU.Swarm({
          capacity: sim.count,
          shape: 'circle',
          blendMode: 'normal',
          allocation: churn
            ? params.variant === 'gpu'
              ? 'gpu'
              : 'ring'
            : undefined,
          autoStep: !churn,
          behaviors: [
            GPU.behaviors.velocity(),
            GPU.behaviors.bounds({
              x: 0,
              y: 0,
              width: params.width,
              height: params.height,
              mode: 'bounce',
              restitution: 1,
            }),
          ],
        });
        r.stage.addChild(swarm);
        if (churn) {
          spawnOptions = {
            x: [0, params.width],
            y: [0, params.height],
            speed: [SPEED_MIN, SPEED_MAX],
            angle: [0, Math.PI * 2],
            size: SWARM_SIZE,
            color: 0xffffff,
            life: [CHURN_LIFE_MIN, CHURN_LIFE_MAX],
          };
          return {
            cpuSim: false,
            tool: `Swarm churn (allocation '${swarm.allocation}')`,
          };
        }
        swarm.spawn(sim.count, {
          x: [0, params.width],
          y: [0, params.height],
          speed: [SPEED_MIN, SPEED_MAX],
          angle: [0, Math.PI * 2],
          size: SWARM_SIZE,
          color: 0xffffff,
          seed: params.seed,
        });
        return {
          cpuSim: false,
          tool: `Swarm (${backend === 'webgpu' ? 'GPU compute' : 'transform feedback'})`,
        };
      }

      if (scenario === 'text') {
        const msdf = params.variant !== 'canvas';
        const font: GPU.FontAsset | GPU.SystemFont = msdf
          ? (
              await r.assets.load<GPU.FontAsset>({
                url: new URL('./dist/fonts/cozy.json', location.href).href,
                kind: 'font',
              })
            ).value
          : { family: 'monospace' };
        const perLabel = Math.round(params.count / T1_LABELS);
        const pool = textPool(params.seed, T1_POOL, perLabel);
        const labels: GPU.Text[] = [];
        const rows = T1_LABELS / T1_COLUMNS;
        const colW = params.width / T1_COLUMNS;
        for (let i = 0; i < T1_LABELS; i++) {
          const t = new GPU.Text(pool[i & (T1_POOL - 1)], {
            font,
            size: T1_SIZE,
            fill: T1_FILL,
            wrap: 'none',
          });
          t.setPosition(
            4 + Math.floor(i / rows) * colW,
            4 + (i % rows) * T1_ROW,
          );
          r.stage.addChild(t);
          labels.push(t);
        }
        await Promise.all(labels.map(l => l.ready));
        let next = T1_LABELS;
        let cursor = 0;
        m3Frame = () => {
          for (let k = 0; k < T1_CHANGE; k++) {
            labels[cursor].text = pool[next & (T1_POOL - 1)];
            next++;
            cursor = cursor + 1 === T1_LABELS ? 0 : cursor + 1;
          }
        };
        return {
          cpuSim: false,
          tool: msdf ? 'Text (MSDF)' : 'Text (canvas glyph atlas)',
        };
      }

      if (
        scenario === 'graphics-static' ||
        scenario === 'graphics-animated' ||
        scenario === 'graphics-redraw'
      ) {
        await GPU.loadGraphics();
        const world = new GPU.Container();
        r.stage.addChild(world);
        const nodes: GPU.Graphics[] = [];
        for (let i = 0; i < sim.count; i++) {
          const g = new GPU.Graphics({ x: sim.x[i], y: sim.y[i] });
          gDraw(g, i, 1);
          nodes.push(world.addChild(g));
        }
        await nodes[nodes.length - 1].ready;
        if (scenario === 'graphics-animated') {
          m3Frame = () => {
            const { x, y, count } = sim;
            const f = m3Frames;
            for (let i = 0; i < count; i++) {
              const g = nodes[i];
              g.setPosition(x[i], y[i]);
              g.rotation = f * gSpin(i);
            }
          };
          return {
            cpuSim: true,
            tool: 'Graphics nodes, setPosition + rotation',
          };
        }
        if (scenario === 'graphics-redraw') {
          m3Frame = () => {
            const f = m3Frames;
            for (let i = 0; i < nodes.length; i++) {
              const g = nodes[i];
              g.clear();
              gDraw(g, i, gPulse(i, f));
            }
          };
          return { cpuSim: false, tool: 'Graphics nodes, clear() + redraw' };
        }
        return { cpuSim: false, tool: 'Graphics nodes, own context each' };
      }

      if (scenario === 'graphics-path') {
        await GPU.loadGraphics();
        const g = new GPU.Graphics();
        r.stage.addChild(g);
        gPath(g, sim.count, 0);
        await g.ready;
        m3Frame = () => {
          g.clear();
          gPath(g, sim.count, m3Frames);
        };
        return { cpuSim: false, tool: 'Graphics path + cut() holes' };
      }

      if (scenario === 'particles') {
        const texture = GPU.Texture.fromPixels(
          SPRITE_TEXTURE_SIZE,
          SPRITE_TEXTURE_SIZE,
          ctx.pixels,
        );
        particles = new GPU.Particles({
          capacity: p1Capacity(params.count),
          texture,
          autoStep: false,
          emitter: {
            rate: p1Rate(params.count),
            shape: { disc: { radius: P1_RADIUS } },
            x: params.width / 2,
            y: params.height / 2,
            speed: [P1_SPEED[0], P1_SPEED[1]],
            size: [P1_SIZE[0], P1_SIZE[1]],
            life: [P1_LIFE_MIN, P1_LIFE_MAX],
          },
          over: { alpha: [1, 0], size: [1, P1_END_SCALE] },
        });
        r.stage.addChild(particles);
        const fx = particles;
        m3Frame = () => fx.step(SIM_DT);
        return {
          cpuSim: false,
          tool: `Particles (${fx.swarm.allocation})`,
        };
      }

      const texture = GPU.Texture.fromPixels(
        SPRITE_TEXTURE_SIZE,
        SPRITE_TEXTURE_SIZE,
        ctx.pixels,
      );
      if (scenario === 'filtered' || scenario === 'masked-moving') {
        const g = new GPU.Group();
        group = g;
        r.stage.addChild(g);
        const scale = SPRITE_SIZE / SPRITE_TEXTURE_SIZE;
        for (let i = 0; i < sim.count; i++) {
          g.addChild(
            new GPU.Sprite({
              texture,
              anchor: 0.5,
              x: sim.x[i],
              y: sim.y[i],
              scale,
            }),
          );
        }
        let tool: string;
        if (scenario === 'filtered') {
          const fast = params.variant === 'fast';
          g.filterOptions = {
            area: { x: 0, y: 0, width: params.width, height: params.height },
          };
          g.filters = [
            GPU.filters.blur({
              strength: F1_BLUR,
              quality: fast ? 'fast' : 'good',
            }),
            GPU.filters.colorMatrix().saturate(F1_SATURATE).hue(F1_HUE),
          ];
          tool = `Group filters [blur ${fast ? 'fast' : 'good'}, colorMatrix]`;
        } else {
          if (params.variant === 'scissor') {
            g.mask = { ...M1_RECT };
          } else {
            const disc = new GPU.Sprite({
              texture,
              anchor: 0.5,
              x: params.width / 2,
              y: params.height / 2,
              // Stencil keeps texels with alpha >= 0.5, which the soft disc
              // reaches at 5/6 of its radius: grow it so the clip matches
              // Pixi's radius-M1_RADIUS Graphics circle.
              scale:
                ((params.variant === 'stencil' ? 1.2 : 1) * (M1_RADIUS * 2)) /
                SPRITE_TEXTURE_SIZE,
            });
            g.mask = {
              source: disc,
              mode: params.variant === 'stencil' ? 'stencil' : 'alpha',
            };
          }
          m3Frame = () => {
            g.x = m1Offset(m3Frames);
          };
          tool = `Group mask (${params.variant})`;
        }
        await g.ready;
        return { cpuSim: false, tool };
      }
      const world = addSprites(texture);
      if (scenario === 'sprites-moving' && params.variant === 'columns') {
        // M2.5 §19.1: register once, commit per frame.
        columns = world.bindColumns({ x: sim.x, y: sim.y });
        return { cpuSim: true, tool: 'Sprite + bindColumns' };
      }
      if (scenario === 'picking') {
        const rand = rng(params.seed + 7);
        pickOrder = new Uint32Array(4096);
        for (let i = 0; i < pickOrder.length; i++) {
          pickOrder[i] = Math.floor(rand() * sim.count);
        }
        return { cpuSim: false, tool: 'Sprite + renderer.pick()' };
      }
      return { cpuSim: scenario === 'sprites-moving', tool: 'Sprite' };
    },

    frame(_ctx, cpuSim) {
      const r = renderer!;
      if (m3Frame !== null) {
        m3Frame();
        m3Frames++;
      } else if (columns !== null) {
        columns.commit(ctx.sim.count);
      } else if (cpuSim) {
        const { x, y, count } = ctx.sim;
        for (let i = 0; i < count; i++) {
          sprites[i].setPosition(x[i], y[i]);
        }
      } else if (spawnOptions !== null) {
        swarm!.spawn(CHURN_SPAWN_PER_FRAME, spawnOptions);
        swarm!.step(SIM_DT);
      } else if (pickOrder !== null && !pickPending) {
        const k = pickOrder[pickCursor++ & 4095];
        pickPending = true;
        pickT0 = performance.now();
        pickFrame0 = frames;
        r.pick(ctx.sim.x[k], ctx.sim.y[k]).then(onPick, onPickError);
      }
      r.render();
      frames++;
    },

    measureStart() {
      picks.reset();
      skippedAtStart = renderer?.stats.skippedFrames ?? 0;
    },

    async finish() {
      // Skipped frames inside the measured window only (A3, §19.5); the
      // finish phase below may hold frames behind a deep GPU queue.
      measuredSkipped = (renderer?.stats.skippedFrames ?? 0) - skippedAtStart;
      if (particles !== null) {
        const fx = particles;
        let done = false;
        fx.swarm.aliveCount().then(
          v => {
            aliveAtEnd = v;
            done = true;
          },
          () => {
            done = true;
          },
        );
        const t0 = performance.now();
        while (!done && performance.now() - t0 < 5000) {
          fx.step(SIM_DT);
          renderer!.render();
          await new Promise(res => requestAnimationFrame(res));
        }
        return;
      }
      if (swarm === null || spawnOptions === null) return;
      // The readback resolves after a later render(), so keep the same churn
      // frames running (steady state unchanged) until it lands (≤ 5 s).
      let done = false;
      swarm.aliveCount().then(
        v => {
          aliveAtEnd = v;
          done = true;
        },
        () => {
          done = true;
        },
      );
      const t0 = performance.now();
      while (!done && performance.now() - t0 < 5000) {
        swarm.spawn(CHURN_SPAWN_PER_FRAME, spawnOptions);
        swarm.step(SIM_DT);
        renderer!.render();
        await new Promise(res => requestAnimationFrame(res));
      }
    },

    info() {
      const r = renderer;
      if (!r) return { version: GPU.VERSION };
      const s = r.stats;
      const out: Record<string, unknown> = {
        version: GPU.VERSION,
        backend: r.info.backend,
        worker: r.info.worker,
        sharedMemory: r.info.sharedMemory,
        drawCalls: s.drawCalls,
        packetBytes: s.packetBytes,
        frontCpuMs: s.cpuMs,
        skippedFrames: s.skippedFrames,
        measuredSkippedFrames: measuredSkipped,
        frameId: s.frameId,
        ...assetInfo,
      };
      if (pickOrder !== null) out.pick = picks.summary();
      if (group !== null) {
        const binding = (
          group as unknown as {
            _maskBinding: { mode: string } | null;
          }
        )._maskBinding;
        if (binding) out.maskMode = binding.mode;
      }
      if (particles !== null) {
        out.aliveAtEnd = aliveAtEnd;
        out.spawnPerFrame = Math.round(p1Rate(params.count) * SIM_DT);
        out.capacity = particles.swarm.capacity;
      }
      if (spawnOptions !== null) {
        out.aliveAtEnd = aliveAtEnd;
        out.spawnPerFrame = CHURN_SPAWN_PER_FRAME;
        out.activeCount = swarm?.activeCount;
      }
      return out;
    },

    destroy() {
      renderer?.destroy();
    },
  };
}

start(createCozyAdapter);
