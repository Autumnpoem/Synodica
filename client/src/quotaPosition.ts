export interface Point { x: number; y: number }
export interface DockRect { left: number; top: number; right: number; bottom: number }

/** Bottom edge reserved for the dock and launcher, with a 12px gap above the composer. */
export function dockSafeBottom(composerTop: number | null, viewportHeight: number): number {
  return composerTop === null ? viewportHeight - 8 : Math.max(8, Math.min(viewportHeight - 8, composerTop - 12))
}

/** Bound a dragged or restored dock against its actual anchored rectangle. */
export function clampDockPosition(next: Point, current: Point, rect: DockRect, viewport: { width: number; height: number }, composerTop?: number): Point {
  const bottom = dockSafeBottom(composerTop ?? null, viewport.height)
  return {
    x: Math.min(Math.max(next.x, current.x + 8 - rect.left), current.x + viewport.width - 8 - rect.right),
    y: Math.min(Math.max(next.y, current.y + 8 - rect.top), current.y + bottom - rect.bottom),
  }
}
