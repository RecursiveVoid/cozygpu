/**
 * Pixi.js v8 adapter.
 *   renderer: webgpu | webgl  (Application preference; the actual backend is
 *             verified and reported — a silent fallback fails the run)
 *   variant:  sprite   → Sprite children in a Container (the general path)
 *             particle → ParticleContainer + Particle (Pixi's fastest path)
 * S2 (swarm): Pixi has no GPU simulation, so the best CPU path is used
 * (ParticleContainer, CPU-stepped BounceSim).
 * A1: Assets.load of 200 PNGs, or of the same BC1 blocks as KTX 1.1 files
 *     (Pixi's KTX2 loader rejects raw BC KTX2; it only reads RGBA8/Basis).
 * A2: S3 sprites + EventBoundary.hitTest (Pixi's CPU hit testing) at one point
 *     per frame.
 * A3: ParticleContainer churn on the CPU: a Particle pool, CHURN_SPAWN_PER_FRAME
 *     spawns per frame, life/age, bounce and swap-remove of dead particles.
 */
import {
  Application,
  Assets,
  Container,
  Particle,
  ParticleContainer,
  Sprite,
  Texture,
  VERSION,
  detectCompressed,
  extensions,
  loadKTX,
  resolveCompressedTextureUrl,
} from 'pixi.js';
import {
  type Adapter,
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
  estimateTextureBytes,
  pixelsToCanvas,
  rng,
} from './common';
import { start } from './harness';

function createPixiAdapter(ctx: BenchContext): Adapter {
  const { params } = ctx;
  const scenario = params.scenario;
  const app = new Application();
  const sprites: Sprite[] = [];
  const particles: Particle[] = [];
  let container: ParticleContainer | null = null;
  let assetInfo: Record<string, unknown> = {};

  // A2
  const picks = new PickStats();
  let pickOrder: Uint32Array | null = null;
  let pickCursor = 0;

  // A3 churn state (SoA by pool slot)
  let churn = false;
  let cx: Float32Array, cy: Float32Array, cvx: Float32Array, cvy: Float32Array;
  let clife: Float32Array;
  let alive: Int32Array, free: Int32Array;
  let aliveN = 0;
  let freeN = 0;
  const rand = rng(params.seed);

  return {
    async init() {
      await app.init({
        canvas: ctx.canvas,
        width: params.width,
        height: params.height,
        resolution: 1,
        autoDensity: false,
        antialias: false,
        backgroundColor: BACKGROUND,
        powerPreference: 'high-performance',
        preference: params.renderer === 'webgl' ? 'webgl' : 'webgpu',
        autoStart: false,
        sharedTicker: false,
      });
      app.ticker.stop();
      if (app.renderer.name !== params.renderer) {
        throw new Error(
          `Pixi fell back to ${app.renderer.name} (requested ${params.renderer})`,
        );
      }
    },

    async populate() {
      const { sim, pixels } = ctx;

      if (scenario === 'assets-png' || scenario === 'assets-ktx2') {
        const kind = scenario === 'assets-png' ? 'png' : 'ktx2';
        // Pixi's KTX2 loader only reads RGBA8 or Basis-supercompressed KTX2
        // ("Unsupported VkFormat: 131" for raw BC1), so the compressed case
        // loads the same BC1 blocks as KTX 1.1 through Pixi's KTX loader.
        const file = kind === 'png' ? 'png' : 'ktx';
        if (kind === 'ktx2') {
          // What `import 'pixi.js/ktx'` does (that subpath has no types).
          extensions.add(
            loadKTX,
            resolveCompressedTextureUrl,
            detectCompressed,
          );
        }
        const urls: string[] = [];
        for (let i = 0; i < params.count; i++) {
          urls.push(new URL(assetUrl(file, i), location.href).href);
        }
        const t0 = performance.now();
        const loaded = (await Assets.load(urls)) as Record<string, Texture>;
        const loadMs = performance.now() - t0;
        const world = new Container();
        let bytes = 0;
        const formats = new Set<string>();
        for (let i = 0; i < urls.length; i++) {
          const tex = loaded[urls[i]];
          const src = tex.source;
          formats.add(src.format);
          let levelW = src.pixelWidth;
          let levelH = src.pixelHeight;
          for (let l = 0; l < Math.max(1, src.mipLevelCount); l++) {
            bytes += estimateTextureBytes(src.format, levelW, levelH);
            levelW = Math.max(1, levelW >> 1);
            levelH = Math.max(1, levelH >> 1);
          }
          const s = new Sprite(tex);
          const c = assetCell(i);
          s.position.set(c.x, c.y);
          world.addChild(s);
        }
        app.stage.addChild(world);
        assetInfo = {
          loadMs,
          assets: urls.length,
          formats: [...formats].join(','),
          gpuBytes: bytes,
          gpuBytesEstimated: true,
        };
        return {
          cpuSim: false,
          tool: `Assets.load (${kind === 'png' ? 'png' : 'BC1 as KTX1'})`,
        };
      }

      const texture = Texture.from(pixelsToCanvas(pixels, SPRITE_TEXTURE_SIZE));
      const size =
        scenario === 'swarm' || scenario === 'swarm-churn'
          ? SWARM_SIZE
          : SPRITE_SIZE;
      const scale = size / SPRITE_TEXTURE_SIZE;
      const moving = scenario === 'sprites-moving' || scenario === 'swarm';

      if (scenario === 'swarm-churn') {
        churn = true;
        const cap = sim.count;
        container = new ParticleContainer({
          texture,
          dynamicProperties: {
            position: true,
            vertex: false,
            rotation: false,
            uvs: false,
            color: false,
          },
        });
        cx = new Float32Array(cap);
        cy = new Float32Array(cap);
        cvx = new Float32Array(cap);
        cvy = new Float32Array(cap);
        clife = new Float32Array(cap);
        alive = new Int32Array(cap);
        free = new Int32Array(cap);
        for (let i = 0; i < cap; i++) {
          particles.push(
            new Particle({
              texture,
              scaleX: scale,
              scaleY: scale,
              anchorX: 0.5,
              anchorY: 0.5,
            }),
          );
          free[i] = cap - 1 - i;
        }
        freeN = cap;
        app.stage.addChild(container);
        return { cpuSim: false, tool: 'ParticleContainer churn (CPU pool)' };
      }

      const useParticles =
        params.variant === 'particle' || scenario === 'swarm';
      if (useParticles) {
        container = new ParticleContainer({
          texture,
          dynamicProperties: {
            position: moving,
            vertex: false,
            rotation: false,
            uvs: false,
            color: false,
          },
        });
        const list = container.particleChildren;
        for (let i = 0; i < sim.count; i++) {
          const p = new Particle({
            texture,
            x: sim.x[i],
            y: sim.y[i],
            scaleX: scale,
            scaleY: scale,
            anchorX: 0.5,
            anchorY: 0.5,
          });
          particles.push(p);
          list.push(p);
        }
        container.update();
        app.stage.addChild(container);
        return { cpuSim: moving, tool: 'ParticleContainer' };
      }

      const world = new Container();
      const picking = scenario === 'picking';
      for (let i = 0; i < sim.count; i++) {
        const s = new Sprite(texture);
        s.anchor.set(0.5);
        s.scale.set(scale);
        s.position.set(sim.x[i], sim.y[i]);
        if (picking) s.eventMode = 'static';
        sprites.push(s);
        world.addChild(s);
      }
      app.stage.addChild(world);
      if (picking) {
        app.renderer.events.rootBoundary.rootTarget = app.stage;
        const r = rng(params.seed + 7);
        pickOrder = new Uint32Array(4096);
        for (let i = 0; i < pickOrder.length; i++) {
          pickOrder[i] = Math.floor(r() * sim.count);
        }
        return { cpuSim: false, tool: 'Sprite + EventBoundary.hitTest (CPU)' };
      }
      return { cpuSim: moving, tool: 'Sprite' };
    },

    frame(_ctx, cpuSim) {
      if (cpuSim) {
        const { x, y, count } = ctx.sim;
        if (container) {
          for (let i = 0; i < count; i++) {
            const p = particles[i];
            p.x = x[i];
            p.y = y[i];
          }
        } else {
          for (let i = 0; i < count; i++) {
            sprites[i].position.set(x[i], y[i]);
          }
        }
      } else if (churn) {
        const list = container!.particleChildren;
        const w = params.width;
        const h = params.height;
        // spawn
        for (let k = 0; k < CHURN_SPAWN_PER_FRAME && freeN > 0; k++) {
          const s = free[--freeN];
          cx[s] = rand() * w;
          cy[s] = rand() * h;
          const speed = SPEED_MIN + rand() * (SPEED_MAX - SPEED_MIN);
          const angle = rand() * Math.PI * 2;
          cvx[s] = Math.cos(angle) * speed;
          cvy[s] = Math.sin(angle) * speed;
          clife[s] =
            CHURN_LIFE_MIN + rand() * (CHURN_LIFE_MAX - CHURN_LIFE_MIN);
          alive[aliveN] = s;
          list[aliveN] = particles[s];
          aliveN++;
        }
        // age, kill (swap-remove), move + bounce
        for (let j = 0; j < aliveN; j++) {
          const s = alive[j];
          const life = clife[s] - SIM_DT;
          if (life <= 0) {
            free[freeN++] = s;
            aliveN--;
            alive[j] = alive[aliveN];
            list[j] = list[aliveN];
            j--;
            continue;
          }
          clife[s] = life;
          let nx = cx[s] + cvx[s] * SIM_DT;
          let ny = cy[s] + cvy[s] * SIM_DT;
          if (nx < 0) {
            nx = 0;
            cvx[s] = -cvx[s];
          } else if (nx > w) {
            nx = w;
            cvx[s] = -cvx[s];
          }
          if (ny < 0) {
            ny = 0;
            cvy[s] = -cvy[s];
          } else if (ny > h) {
            ny = h;
            cvy[s] = -cvy[s];
          }
          cx[s] = nx;
          cy[s] = ny;
          const p = list[j];
          p.x = nx;
          p.y = ny;
        }
        list.length = aliveN;
        container!.update();
      } else if (pickOrder !== null) {
        const k = pickOrder[pickCursor++ & 4095];
        const t0 = performance.now();
        const hit = app.renderer.events.rootBoundary.hitTest(
          ctx.sim.x[k],
          ctx.sim.y[k],
        );
        picks.add(performance.now() - t0, 0, !!hit);
      }
      app.renderer.render(app.stage);
    },

    measureStart() {
      picks.reset();
    },

    info() {
      const out: Record<string, unknown> = {
        backend: app.renderer?.name,
        version: VERSION,
        ...assetInfo,
      };
      if (pickOrder !== null) out.pick = picks.summary();
      if (churn) {
        out.aliveAtEnd = aliveN;
        out.spawnPerFrame = CHURN_SPAWN_PER_FRAME;
      }
      return out;
    },

    destroy() {
      app.destroy(false, { children: true });
    },
  };
}

start(createPixiAdapter);
