// src/index.ts

import { CozyGPU } from './CozyGPU';

const cozyGPU = new CozyGPU();

if (typeof window !== 'undefined') {
  //@ts-ignore
  if (!window.cozyGPU) {
    (window as any).cozyGPU = cozyGPU;
  }
}

export { cozyGPU };
