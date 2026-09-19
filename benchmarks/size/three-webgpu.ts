// Minimal Three.js (WebGPURenderer, three/webgpu) program: one textured quad.
import {
  DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

export async function main(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = new WebGPURenderer({ canvas });
  await renderer.init();
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 800, 0, 600, -1, 1);
  const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  map.needsUpdate = true;
  const quad = new Mesh(
    new PlaneGeometry(16, 16),
    new MeshBasicNodeMaterial({ map }),
  );
  quad.position.set(10, 10, 0);
  scene.add(quad);
  renderer.render(scene, camera);
}
