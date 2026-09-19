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
  PickStats,
  SIM_DT,
  SPEED_MAX,
  SPEED_MIN,
  SPRITE_SIZE,
  SPRITE_TEXTURE_SIZE,
  SWARM_SIZE,
  assetCell,
  assetUrl,
  rng,
} from './common';
import { start } from './harness';

function createCozyAdapter(ctx: BenchContext): Adapter {
  const { params } = ctx;
  const scenario = params.scenario;
  let renderer: GPU.Renderer | null = null;
  const sprites: GPU.Sprite[] = [];
  let swarm: GPU.Swarm | null = null;
  let spawnOptions: GPU.SpawnOptions | null = null;
  let aliveAtEnd = NaN;
  let assetInfo: Record<string, unknown> = {};

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

  function addSprites(texture: GPU.Texture): void {
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
          scenario === 'swarm' || scenario === 'swarm-churn'
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

      const texture = GPU.Texture.fromPixels(
        SPRITE_TEXTURE_SIZE,
        SPRITE_TEXTURE_SIZE,
        ctx.pixels,
      );
      addSprites(texture);
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
      if (cpuSim) {
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
    },

    async finish() {
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
        frameId: s.frameId,
        ...assetInfo,
      };
      if (pickOrder !== null) out.pick = picks.summary();
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
