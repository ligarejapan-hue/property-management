/**
 * geometry.ts
 *
 * Pure px↔mm conversion helpers for the sales-sheet canvas editor.
 *
 * The canvas renders elements using CSS millimetres (1mm = 96/25.4 ≈ 3.7795 px at
 * 96 dpi) and then scales the entire canvas via a CSS `transform: scale(zoom)` wrapper.
 *
 * Moveable tracks drag/resize via pointer events, which are reported in the
 * viewport (screen) coordinate space.  Because the canvas is scaled, converting
 * viewport pixels to mm requires dividing by BOTH the physical dpi ratio
 * (mmToPx) AND the display zoom.
 */

/**
 * Convert a value in viewport (screen) pixels to millimetres.
 *
 * @param px      Pixel value in the scaled (screen) coordinate space, as
 *                reported by Moveable drag/resize events.
 * @param mmToPx  Physical mm→px ratio at 96 dpi (96 / 25.4 ≈ 3.7795).
 * @param scale   Canvas display zoom (e.g. DEFAULT_ZOOM = 0.75).
 * @returns       Equivalent value in millimetres.
 */
export function pxToMm(px: number, mmToPx: number, scale: number): number {
  return px / (mmToPx * scale);
}

/**
 * Convert a millimetre value to viewport (screen) pixels.
 * Exact inverse of pxToMm.
 *
 * @param mm      Value in millimetres.
 * @param mmToPx  Physical mm→px ratio at 96 dpi.
 * @param scale   Canvas display zoom.
 * @returns       Equivalent value in viewport pixels.
 */
export function mmToViewportPx(mm: number, mmToPx: number, scale: number): number {
  return mm * mmToPx * scale;
}
