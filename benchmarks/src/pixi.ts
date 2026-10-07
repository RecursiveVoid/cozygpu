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
 * M3 (variants in parentheses):
 *   T1 text: 200 labels of 50 glyphs, 20 replaced per frame (msdf: BitmapText
 *      on the same MSDF atlas, converted to a BMFont .fnt by build.mjs;
 *      text: Text, Canvas2D raster + texture upload per change).
 *   F1 filtered: [BlurFilter (strength 8, default quality 4), ColorMatrixFilter]
 *      on a Container of Sprites (sprite) or a ParticleContainer (particle),
 *      filterArea = the canvas (no per-frame bounds walk).
 *   M1m masked-moving: 10k Sprites in a Container sliding under a fixed mask
 *      (rect / circle: Graphics stencil masks; sprite: alpha mask).
 *   P1 particles: ParticleContainer + a CPU emitter (spawn in a disc, age,
 *      move, alpha and scale over life, swap-remove), stepped with SIM_DT.
 */
import {
  Application,
  Assets,
  BitmapText,
  BlurFilter,
  ColorMatrixFilter,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Text,
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
  estimateTextureBytes,
  m1Offset,
  p1Capacity,
  p1Rate,
  pixelsToCanvas,
  rng,
  textPool,
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

  // M3: per-frame work of the T1/F1/M1m/P1 scenarios (set by populate).
  let m3Frame: (() => void) | null = null;
  let m3Frames = 0;
  let m3Alive: () => number = () => NaN;
  let m3SpawnPerFrame = NaN;

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

      if (scenario === 'text') {
        const msdf = params.variant === 'msdf';
        if (msdf) await Assets.load('./dist/fonts/cozy.fnt');
        const perLabel = Math.round(params.count / T1_LABELS);
        const pool = textPool(params.seed, T1_POOL, perLabel);
        const labels: (BitmapText | Text)[] = [];
        const rows = T1_LABELS / T1_COLUMNS;
        const colW = params.width / T1_COLUMNS;
        for (let i = 0; i < T1_LABELS; i++) {
          const text = pool[i & (T1_POOL - 1)];
          const t = msdf
            ? new BitmapText({
                text,
                style: { fontFamily: 'cozy', fontSize: T1_SIZE, fill: T1_FILL },
              })
            : new Text({
                text,
                style: {
                  fontFamily: 'monospace',
                  fontSize: T1_SIZE,
                  fill: T1_FILL,
                },
              });
          t.position.set(
            4 + Math.floor(i / rows) * colW,
            4 + (i % rows) * T1_ROW,
          );
          app.stage.addChild(t);
          labels.push(t);
        }
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
          tool: msdf ? 'BitmapText (MSDF .fnt)' : 'Text (Canvas2D)',
        };
      }

      const texture = Texture.from(pixelsToCanvas(pixels, SPRITE_TEXTURE_SIZE));

      if (scenario === 'particles') {
        const cap = p1Capacity(params.count);
        const pc = new ParticleContainer({
          texture,
          dynamicProperties: {
            position: true,
            vertex: true,
            rotation: false,
            uvs: false,
            color: true,
          },
        });
        const px = new Float32Array(cap);
        const py = new Float32Array(cap);
        const pvx = new Float32Array(cap);
        const pvy = new Float32Array(cap);
        const page = new Float32Array(cap);
        const plife = new Float32Array(cap);
        const psize = new Float32Array(cap);
        const pAlive = new Int32Array(cap);
        const pFree = new Int32Array(cap);
        const pool: Particle[] = [];
        for (let i = 0; i < cap; i++) {
          pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5 }));
          pFree[i] = cap - 1 - i;
        }
        let nFree = cap;
        let nAlive = 0;
        let debt = 0;
        const perFrame = p1Rate(params.count) * SIM_DT;
        const cx0 = params.width / 2;
        const cy0 = params.height / 2;
        const list = pc.particleChildren;
        const inv = 1 / SPRITE_TEXTURE_SIZE;
        m3Frame = () => {
          debt += perFrame;
          const n = Math.floor(debt);
          debt -= n;
          for (let k = 0; k < n && nFree > 0; k++) {
            const s = pFree[--nFree];
            const rr = P1_RADIUS * Math.sqrt(rand());
            const ra = rand() * Math.PI * 2;
            px[s] = cx0 + Math.cos(ra) * rr;
            py[s] = cy0 + Math.sin(ra) * rr;
            const speed = P1_SPEED[0] + rand() * (P1_SPEED[1] - P1_SPEED[0]);
            const dir = rand() * Math.PI * 2;
            pvx[s] = Math.cos(dir) * speed;
            pvy[s] = Math.sin(dir) * speed;
            page[s] = 0;
            plife[s] = P1_LIFE_MIN + rand() * (P1_LIFE_MAX - P1_LIFE_MIN);
            psize[s] = (P1_SIZE[0] + rand() * (P1_SIZE[1] - P1_SIZE[0])) * inv;
            pAlive[nAlive] = s;
            list[nAlive] = pool[s];
            nAlive++;
          }
          for (let j = 0; j < nAlive; j++) {
            const s = pAlive[j];
            const age = page[s] + SIM_DT;
            if (age >= plife[s]) {
              pFree[nFree++] = s;
              nAlive--;
              pAlive[j] = pAlive[nAlive];
              list[j] = list[nAlive];
              j--;
              continue;
            }
            page[s] = age;
            const t = age / plife[s];
            const x = px[s] + pvx[s] * SIM_DT;
            const y = py[s] + pvy[s] * SIM_DT;
            px[s] = x;
            py[s] = y;
            const p = pool[s];
            p.x = x;
            p.y = y;
            p.alpha = 1 - t;
            const sc = psize[s] * (1 - (1 - P1_END_SCALE) * t);
            p.scaleX = sc;
            p.scaleY = sc;
          }
          list.length = nAlive;
          pc.update();
        };
        m3Alive = () => nAlive;
        m3SpawnPerFrame = Math.round(perFrame);
        app.stage.addChild(pc);
        return { cpuSim: false, tool: 'ParticleContainer + CPU emitter' };
      }

      if (scenario === 'filtered' || scenario === 'masked-moving') {
        const scale = SPRITE_SIZE / SPRITE_TEXTURE_SIZE;
        let world: Container;
        if (scenario === 'filtered' && params.variant === 'particle') {
          const pc = new ParticleContainer({
            texture,
            dynamicProperties: {
              position: false,
              vertex: false,
              rotation: false,
              uvs: false,
              color: false,
            },
          });
          const list = pc.particleChildren;
          for (let i = 0; i < sim.count; i++) {
            list.push(
              new Particle({
                texture,
                x: sim.x[i],
                y: sim.y[i],
                scaleX: scale,
                scaleY: scale,
                anchorX: 0.5,
                anchorY: 0.5,
              }),
            );
          }
          pc.update();
          world = pc;
        } else {
          world = new Container();
          for (let i = 0; i < sim.count; i++) {
            const s = new Sprite(texture);
            s.anchor.set(0.5);
            s.scale.set(scale);
            s.position.set(sim.x[i], sim.y[i]);
            world.addChild(s);
          }
        }
        app.stage.addChild(world);
        if (scenario === 'filtered') {
          const cm = new ColorMatrixFilter();
          cm.saturate(F1_SATURATE - 1, false);
          cm.hue(F1_HUE, true);
          world.filters = [new BlurFilter({ strength: F1_BLUR }), cm];
          world.filterArea = new Rectangle(0, 0, params.width, params.height);
          return {
            cpuSim: false,
            tool: `${params.variant === 'particle' ? 'ParticleContainer' : 'Sprite'} + [BlurFilter, ColorMatrixFilter]`,
          };
        }
        let mask: Container;
        if (params.variant === 'rect') {
          mask = new Graphics()
            .rect(M1_RECT.x, M1_RECT.y, M1_RECT.width, M1_RECT.height)
            .fill(0xffffff);
        } else if (params.variant === 'circle') {
          mask = new Graphics()
            .circle(params.width / 2, params.height / 2, M1_RADIUS)
            .fill(0xffffff);
        } else {
          const disc = new Sprite(texture);
          disc.anchor.set(0.5);
          disc.scale.set((M1_RADIUS * 2) / SPRITE_TEXTURE_SIZE);
          disc.position.set(params.width / 2, params.height / 2);
          mask = disc;
        }
        app.stage.addChild(mask);
        world.mask = mask;
        m3Frame = () => {
          world.x = m1Offset(m3Frames);
        };
        return {
          cpuSim: false,
          tool: `Container mask (${params.variant === 'sprite' ? 'Sprite, alpha' : `Graphics ${params.variant}, stencil`})`,
        };
      }
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
      if (m3Frame !== null) {
        m3Frame();
        m3Frames++;
      } else if (cpuSim) {
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
      if (scenario === 'particles') {
        out.aliveAtEnd = m3Alive();
        out.spawnPerFrame = m3SpawnPerFrame;
      }
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
