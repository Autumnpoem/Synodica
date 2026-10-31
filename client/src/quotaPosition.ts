export interface Point { x: number; y: number }
export interface DockRect { left: number; top: number; right: number; bottom: number }

/** Bound a dragged or restored dock against its actual anchored rectangle. */
export function clampDockPosition(next: Point, current: Point, rect: DockRect, viewport: { width: number; height: number }): Point {
  return {
    x: Math.min(Math.max(next.x, current.x + 8 - rect.left), current.x + viewport.width - 8 - rect.right),
    y: Math.min(Math.max(next.y, current.y + 8 - rect.top), current.y + viewport.height - 8 - rect.bottom),
  }
}
