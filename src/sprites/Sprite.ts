/**
 * Lightweight data-only sprite object.
 * All GPU work is handled by SpriteBatch.
 */
class Sprite {
  public x: number = 0;
  public y: number = 0;
  public z: number = 0;
  public rotation: number = 0;
  public scaleX: number = 1;
  public scaleY: number = 1;

  /**
   * Sub-rectangle within the texture atlas: [u, v, width, height] in [0..1] space.
   * Default covers the full texture.
   */
  public uvRect: [number, number, number, number] = [0, 0, 1, 1];

  /**
   * RGBA tint multiplier in [0..1]. Default is opaque white (no tint).
   */
  public tint: [number, number, number, number] = [1, 1, 1, 1];
}

export { Sprite };
