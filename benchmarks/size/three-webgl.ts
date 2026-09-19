// Minimal Three.js (WebGLRenderer) program: one textured quad.
import {
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';

export function main(canvas: HTMLCanvasElement): void {
  const renderer = new WebGLRenderer({ canvas });
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 800, 0, 600, -1, 1);
  const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  map.needsUpdate = true;
  const quad = new Mesh(
    new PlaneGeometry(16, 16),
    new MeshBasicMaterial({ map }),
  );
  quad.position.set(10, 10, 0);
  scene.add(quad);
  renderer.render(scene, camera);
}
