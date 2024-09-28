import { Canvas } from "../types/types";

class Renderer {
  
  private _canvas: Canvas;

  constructor(canvas: Canvas) {
    this._canvas = canvas;
  }

  public get canvas() {
    return this._canvas;
  }
}

export { Renderer };
