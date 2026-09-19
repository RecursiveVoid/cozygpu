// Owner: "sprites". Bunnymark: N bouncing sprites from a 4-frame atlas.
//   ?count=100000   initial sprites (default 100k)
//   ?add=5000       sprites added per click / key press
//   ?rotate=1       also spin every sprite (exercises the trig path)
//   ?bulk=1         write positions through container.bulkChildren (M2)
//   ?pick=1         click picks the sprite under the cursor instead of adding
//   ?backend=webgl2 force a backend ('auto' by default, 'webgpu' also valid)
//   ?worker=1       run the core in a worker (needs the worker bundle built)
// The per-frame loop allocates nothing; the HUD text is refreshed twice a second.
import * as GPU from 'cozygpu';

const params = new URLSearchParams(location.search);
const INITIAL = Math.max(0, Number(params.get('count') ?? 100_000) | 0);
const ADD = Math.max(1, Number(params.get('add') ?? 5_000) | 0);
const ROTATE = params.get('rotate') === '1';
const BULK = params.get('bulk') === '1';
const PICK = params.get('pick') === '1';
const backendParam = params.get('backend');
const backend: 'auto' | 'webgpu' | 'webgl2' =
  backendParam === 'webgpu' || backendParam === 'webgl2'
    ? backendParam
    : 'auto';
const WORKER = params.get('worker') === '1';
const GRAVITY = 900;

const FRAME = 16;
const COLORS = [0xffb3c7, 0xa8e6ff, 0xfff0a8, 0xb9ffb0];

/** 4 × 16×16 bunny-ish frames in one atlas (one texture → one draw call). */
function atlasPixels(): Uint8Array {
  const w = FRAME * COLORS.length;
  const px = new Uint8Array(w * FRAME * 4);
  for (let f = 0; f < COLORS.length; f++) {
    const c = COLORS[f];
    for (let y = 0; y < FRAME; y++) {
      for (let x = 0; x < FRAME; x++) {
        const cx = x + 0.5 - 8;
        const body = Math.hypot(cx, y + 0.5 - 11) < 5;
        const ears = Math.abs(Math.abs(cx) - 2.5) < 1.2 && y > 1 && y < 8;
        const eye =
          Math.abs(Math.abs(cx) - 2) < 0.8 && Math.abs(y + 0.5 - 10) < 0.8;
        const i = (y * w + f * FRAME + x) * 4;
        if (!(body || ears)) continue;
        px[i] = eye ? 20 : (c >> 16) & 255;
        px[i + 1] = eye ? 20 : (c >> 8) & 255;
        px[i + 2] = eye ? 30 : c & 255;
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const renderer = await GPU.createRenderer({
    canvas,
    background: 0x0d0d14,
    backend,
    worker: WORKER ? { url: '/build/examples/cozygpu.worker.js' } : false,
  });

  // Dev handle for the headless verification driver (examples only).
  (globalThis as { __renderer?: unknown }).__renderer = renderer;

  const atlas = GPU.Texture.fromPixels(
    FRAME * COLORS.length,
    FRAME,
    atlasPixels(),
    { nearest: true },
  );
  const frames: GPU.Texture[] = [];
  for (let f = 0; f < COLORS.length; f++) {
    frames.push(atlas.sub(f * FRAME, 0, FRAME, FRAME));
  }

  const world = new GPU.Container();
  renderer.stage.addChild(world);

  let count = 0;
  let sprites: GPU.Sprite[] = [];
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let spin = new Float32Array(0);
  // ?bulk=1: one typed-array writer for every child, re-acquired only when
  // the children list changes (M2, ARCHITECTURE §16.1).
  let bulk: GPU.BulkChildren | null = null;
  let pickInfo = '';

  function add(n: number): void {
    const next = count + n;
    if (next > vx.length) {
      const cap = Math.max(next, vx.length * 2);
      const grow = (a: Float32Array) => {
        const b = new Float32Array(cap);
        b.set(a);
        return b;
      };
      vx = grow(vx);
      vy = grow(vy);
      spin = grow(spin);
    }
    for (let i = count; i < next; i++) {
      const s = new GPU.Sprite({
        texture: frames[i % frames.length],
        anchor: 0.5,
        x: Math.random() * renderer.width,
        y: Math.random() * renderer.height * 0.5,
        scale: 1 + Math.random(),
      });
      vx[i] = (Math.random() - 0.5) * 400;
      vy[i] = (Math.random() - 0.5) * 400;
      spin[i] = (Math.random() - 0.5) * 6;
      sprites.push(world.addChild(s));
    }
    count = next;
  }
  add(INITIAL);

  function pickAt(x: number, y: number): void {
    renderer
      .pick(x, y)
      .then(hit => {
        pickInfo = hit
          ? ` · picked #${hit.node.id} at ${hit.x.toFixed(0)},${hit.y.toFixed(0)}`
          : ' · picked nothing';
        if (hit && hit.node.kind === 'sprite') {
          (hit.node as GPU.Sprite).tint = 0xff2020;
        }
        console.log('pick', pickInfo);
      })
      .catch((err: Error) => {
        pickInfo = ` · pick failed: ${err.message}`;
        console.log('pick', pickInfo);
      });
  }

  window.addEventListener('pointerdown', e => {
    if (PICK) pickAt(e.clientX, e.clientY);
    else add(ADD);
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && count > 0) {
      const n = Math.min(ADD, count);
      world.removeChildren(count - n, count);
      for (let i = count - n; i < count; i++) sprites[i].destroy();
      sprites = sprites.slice(0, count - n);
      count -= n;
    } else if (e.key === ' ') {
      add(ADD);
    }
  });

  const ticker = GPU.ticker(renderer);
  let hudTimer = 0;
  let frameMsAvg = 0;
  let updateMsAvg = 0;

  ticker.add(dt => {
    const t0 = performance.now();
    const w = renderer.width;
    const h = renderer.height;
    if (BULK && (bulk === null || bulk.version !== world.childrenVersion)) {
      bulk = world.bulkChildren(GPU.BulkField.POSITION);
      bulk.pull(GPU.BulkField.POSITION);
    }
    const pos = bulk !== null ? bulk.position : null;
    for (let i = 0; i < count; i++) {
      const s = sprites[i];
      let x = pos !== null ? pos[i * 2] : s.x;
      let y = pos !== null ? pos[i * 2 + 1] : s.y;
      x += vx[i] * dt;
      y += vy[i] * dt;
      let vyi = vy[i] + GRAVITY * dt;
      if (x < 0) {
        x = 0;
        vx[i] = -vx[i];
      } else if (x > w) {
        x = w;
        vx[i] = -vx[i];
      }
      if (y > h) {
        y = h;
        vyi = -vyi * 0.85;
        if (Math.random() > 0.5) vyi -= Math.random() * 600;
      } else if (y < 0) {
        y = 0;
        vyi = 0;
      }
      vy[i] = vyi;
      if (pos !== null) {
        pos[i * 2] = x;
        pos[i * 2 + 1] = y;
      } else {
        s.setPosition(x, y);
      }
      if (ROTATE) s.rotation += spin[i] * dt;
    }
    if (bulk !== null) bulk.commit(GPU.BulkField.POSITION);
    const k = 0.05;
    updateMsAvg += (performance.now() - t0 - updateMsAvg) * k;
    frameMsAvg += (dt * 1000 - frameMsAvg) * k;

    hudTimer += dt;
    if (hudTimer >= 0.5) {
      hudTimer = 0;
      const st = renderer.stats;
      hud.textContent =
        `sprites ${count} · fps ${ticker.fps.toFixed(0)} · frame ${frameMsAvg.toFixed(2)} ms` +
        ` · update ${updateMsAvg.toFixed(2)} ms · render cpu ${st.cpuMs.toFixed(2)} ms` +
        ` · draws ${st.drawCalls} · packet ${(st.packetBytes / 1024).toFixed(1)} KB` +
        (BULK ? ' · bulk' : '') +
        pickInfo +
        ` — ${PICK ? 'click: pick' : `click/space: +${ADD}`}, backspace: −${ADD}`;
    }
  });
}

main().catch(err => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = String(err);
});
