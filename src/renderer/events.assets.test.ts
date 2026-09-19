/**
 * M2.5 events emitted by the asset manager through RendererHost._emit
 * (ARCHITECTURE §19.2): assetProgress per finished asset or bundle entry,
 * assetError per failed load (aborts are not failures).
 */
import { Assets } from '../assets/Assets';
import {
  createFakeServer,
  fakeRenderer,
  FakeHost,
} from '../assets/assets.testutil';

const BASE = 'https://cdn.test/';

function setup() {
  const server = createFakeServer();
  const host = new FakeHost();
  const assets = new Assets(fakeRenderer(host), {
    baseUrl: BASE,
    fetch: server.fetch,
  });
  server.files.set(`${BASE}a.txt`, 'a');
  server.files.set(`${BASE}b.txt`, 'b');
  return { server, host, assets };
}

describe('asset events', () => {
  it('emits assetProgress once per load, with the batch counts for loadAll and loadBundle', async () => {
    const { host, assets } = setup();
    await assets.load('a.txt');
    expect(host.events).toEqual([
      [
        'assetProgress',
        { key: `${BASE}a.txt`, bundle: null, loaded: 1, total: 1, ratio: 1 },
      ],
    ]);
    host.events.length = 0;
    await assets.loadAll(['a.txt', 'b.txt']);
    expect(host.events.map(e => e[0])).toEqual([
      'assetProgress',
      'assetProgress',
    ]);
    expect(host.events[1][1]).toMatchObject({
      bundle: null,
      loaded: 2,
      total: 2,
      ratio: 1,
    });
    host.events.length = 0;
    assets.addBundle('level', { a: 'a.txt', b: 'b.txt' });
    await assets.loadBundle('level');
    expect(host.events.map(e => (e[1] as { bundle: string }).bundle)).toEqual([
      'level',
      'level',
    ]);
    expect(host.events[0][1]).toMatchObject({
      loaded: 1,
      total: 2,
      ratio: 0.5,
    });
  });

  it('emits assetError once per failed load, not for aborts', async () => {
    const { server, host, assets } = setup();
    const failed = assets.load('missing.txt');
    await expect(failed).rejects.toBeDefined();
    const errors = host.events.filter(e => e[0] === 'assetError');
    expect(errors.length).toBe(1);
    expect(errors[0][1]).toMatchObject({
      key: `${BASE}missing.txt`,
      url: `${BASE}missing.txt`,
    });
    expect(typeof (errors[0][1] as { code: string }).code).toBe('string');

    host.events.length = 0;
    server.hold = true;
    const controller = new AbortController();
    const aborted = assets.load('b.txt', { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' });
    server.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.events.filter(e => e[0] === 'assetError')).toEqual([]);
  });
});
