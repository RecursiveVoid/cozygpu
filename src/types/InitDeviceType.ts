import { Canvas } from './types';

interface InitDeviceType {
  canvas: Canvas;
  device: GPUDevice;
  context: GPUCanvasContext;
}

export { InitDeviceType };
