// Picking Graphics (ARCHITECTURE §26.8): the pick pass draws each pickable
// node's exact geometry, so hits follow the shape, not its bounds.
//
//   circle      SDF fill + stroke
//   ring        stroke only: its hole is not part of the shape
//   hit area    an alpha-0 fill under a stroke: invisible, but it picks
//   star        tessellated mesh (concave): the notches between points miss
//   segment     a thick line with round caps
//   spinner     a rotating, scaled node (an ARC stroke)
//
// Move the pointer over a shape to highlight it; click to log the hit. On
// start the scene probes fixed points once and stores the results in
// `__graphics.probes` ("name:hit" / "name:miss") for the headless check.
import * as GPU from 'cozygpu';
import type { Scene, SceneFactory } from './types';

interface Item {
  name: string;
  node: GPU.Graphics;
  draw(g: GPU.Graphics, hot: boolean): void;
}

const HOT = 0xf59e0b;

export const createPickingScene: SceneFactory = async (
  renderer,
  _params,
  status,
) => {
  const stage = renderer.stage;
  const items: Item[] = [];
  const add = (
    name: string,
    x: number,
    y: number,
    draw: (g: GPU.Graphics, hot: boolean) => void,
  ): GPU.Graphics => {
    const node = new GPU.Graphics({ x, y, pickable: true, label: name });
    node.userId = items.length + 1;
    draw(node, false);
    stage.addChild(node);
    items.push({ name, node, draw });
    return node;
  };

  add('circle', 120, 190, (g, hot) =>
    g
      .clear()
      .circle(0, 0, 50)
      .fill(hot ? HOT : 0x0ea5e9)
      .stroke({ width: 6, color: 0xffffff }),
  );
  add('ring', 300, 190, (g, hot) =>
    g
      .clear()
      .circle(0, 0, 50)
      .stroke({ width: 14, color: hot ? HOT : 0xa78bfa }),
  );
  add('hitarea', 480, 190, (g, hot) =>
    g
      .clear()
      .roundRect(-55, -45, 110, 90, 14)
      .fill({ color: 0xffffff, alpha: 0 })
      .stroke({ width: 3, color: hot ? HOT : 0x94a3b8 }),
  );
  add('star', 120, 390, (g, hot) =>
    g
      .clear()
      .star(0, 0, 5, 70, 28)
      .fill(hot ? HOT : 0xf43f5e)
      .stroke({ width: 3, color: 0xffffff, join: 'round' }),
  );
  add('segment', 300, 390, (g, hot) =>
    g
      .clear()
      .moveTo(-60, 40)
      .lineTo(60, -40)
      .stroke({ width: 18, color: hot ? HOT : 0x22c55e, cap: 'round' }),
  );
  const spinner = add('spinner', 480, 390, (g, hot) =>
    g
      .clear()
      .arc(0, 0, 50, 0, Math.PI * 1.4)
      .stroke({ width: 16, color: hot ? HOT : 0x38bdf8, cap: 'round' }),
  );

  let hot: Item | null = null;
  const setHot = (item: Item | null): void => {
    if (item === hot) return;
    if (hot) hot.draw(hot.node, false);
    hot = item;
    if (hot) hot.draw(hot.node, true);
  };
  const itemOf = (node: unknown): Item | null => {
    for (const item of items) if (item.node === node) return item;
    return null;
  };

  const log: string[] = [];
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let pending = false;
  let px = -1;
  let py = -1;
  canvas.addEventListener('pointermove', e => {
    px = e.offsetX;
    py = e.offsetY;
  });
  canvas.addEventListener('pointerleave', () => {
    px = py = -1;
  });
  canvas.addEventListener('click', e => {
    renderer.pick(e.offsetX, e.offsetY).then(hit => {
      const item = hit ? itemOf(hit.node) : null;
      log.unshift(item ? `${item.name} (userId ${hit!.userId})` : 'miss');
      log.length = Math.min(log.length, 4);
    }, console.error);
  });

  // Headless probes: inside / outside each interesting region.
  const probes: string[] = [];
  status.probes = probes;
  const PROBES: [string, number, number][] = [
    ['circle', 120, 190],
    ['ring-band', 300 + 50, 190],
    ['ring-hole', 300, 190],
    ['hitarea', 480, 190],
    ['star-point', 120, 390 - 60],
    ['star-notch', 120 + 45, 390 - 45],
    ['segment', 300, 390],
    ['empty', 640, 60],
  ];
  // Started once the graphics chunks, pipelines and first frames settled.
  const runProbes = async (): Promise<void> => {
    for (const [name, x, y] of PROBES) {
      const hit = await renderer.pick(x, y);
      const item = hit ? itemOf(hit.node) : null;
      probes.push(`${name}:${item ? item.name : 'miss'}`);
    }
    status.probesDone = true;
  };
  setTimeout(() => {
    runProbes().catch((err: unknown) => {
      status.errors.push(`probe: ${String(err)}`);
    });
  }, 1200);

  const scene: Scene = {
    update(_dt, time) {
      spinner.rotation = time * 1.5;
      spinner.setScale(1 + 0.15 * Math.sin(time * 2));
      if (!pending && px >= 0) {
        pending = true;
        renderer.pick(px, py).then(
          hit => {
            pending = false;
            setHot(hit ? itemOf(hit.node) : null);
          },
          () => {
            pending = false;
          },
        );
      } else if (px < 0) {
        setHot(null);
      }
    },
    hud() {
      return (
        `hover: ${hot ? hot.name : '-'} · clicks: ${log.join(', ') || '-'}\n` +
        `probes: ${probes.join(' ')}`
      );
    },
  };
  return scene;
};
