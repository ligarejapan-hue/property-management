# Task F Report — Moveable ドラッグ/拡縮/重ね順

## react-moveable installed

- **Version**: 0.56.0  
- **Peer dependencies**: No conflicts (React 19 / Next 16 installed cleanly, `npm install react-moveable` added 20 packages with 0 peer-dep errors).

## context7 API facts confirmed

- `onDrag(e)`: event provides `left`, `top` (element's new position), `transform` string, `dist`, `delta`.  
  Standard pattern: `target.style.left = `${left}px``  
- `onDragEnd(e)`: `isDrag` (boolean), `lastEvent` (OnDrag | undefined) with the last drag position.  
- `onResize(e)`: `width`, `height` (new size), `dist`, `delta`, `drag` (drag sub-event with `left`/`top` for origin shift).  
  Standard pattern: `target.style.width = `${width}px``  
- `onResizeEnd(e)`: `isDrag`, `lastEvent` (OnResize | undefined).  
- `bounds`: `{ left, top, right, bottom }` — constrains drag/resize within a rectangular region.  
- `target`: `HTMLElement | SVGElement | null` — the element Moveable controls.  
- `draggable`, `resizable`: boolean flags to enable each mode.  
- Moveable is browser-only (uses DOM APIs at module init) → **dynamic import with `ssr: false`** required.

## px↔mm helper (`geometry.ts`)

**File**: `src/components/sales-sheet/editor/geometry.ts`

```ts
// Viewport-px → mm  (Moveable reports in the scaled viewport coordinate space)
pxToMm(px, mmToPx, scale) = px / (mmToPx * scale)

// mm → viewport-px  (used for bounds)
mmToViewportPx(mm, mmToPx, scale) = mm * mmToPx * scale
```

Both are pure functions with no side effects or imports.

**Tests**: `src/components/sales-sheet/editor/__tests__/geometry.test.ts` — 13 tests covering:
- 1mm round-trip at DEFAULT_ZOOM (0.75)
- round-trip at zoom=1
- zero input
- round-trip with pxToMm ↔ mmToViewportPx
- A4 landscape width (297mm) and height (210mm)
- Monotonicity (larger zoom → more/fewer px per mm as expected)
All 13 tests GREEN.

## How Moveable wires to the Task D reducer

### Architecture

```
SalesSheetEditor ("use client")
├─ useState<EditorState>
├─ handleMove  → moveElement(state, id, {x, y})
├─ handleResize → resizeElement(state, id, {w, h})
├─ handleBringToFront → bringToFront(state, id)
├─ handleSendToBack   → sendToBack(state, id)
└─ EditorCanvas (props: onMove, onResize, zoom, mmToPx)
    ├─ useState<HTMLDivElement | null> moveableTarget
    │   captured from hit-box onClick (event handler, not ref read during render)
    ├─ MoveableNoSSR (dynamic, ssr:false)
    │   target = moveableTarget
    │   onDragEnd → pxToMm(lastEvent.left/top, mmToPx, zoom) → onMove()
    │   onResizeEnd → pxToMm(lastEvent.width/height, mmToPx, zoom) → onResize()
    │              → pxToMm(lastEvent.drag.left/top, mmToPx, zoom) → onMove()
    │   bounds = mmToViewportPx(page.width/height, mmToPx, zoom)
    └─ z-order buttons (前面/背面) in properties panel (SalesSheetEditor level)
```

### Key design decisions

1. **Target capture via click event**: The Moveable target (`HTMLDivElement`) is stored in `useState` and captured directly from `e.currentTarget` in the hit-box click handler. This avoids both "reading ref during render" (`react-hooks/refs`) and "setState in effect" (`react-hooks/set-state-in-effect`) lint violations.

2. **Dynamic import**: `const MoveableNoSSR = dynamic<any>(() => import("react-moveable"), { ssr: false })` prevents SSR/build failures from Moveable's browser-only APIs.

3. **Coordinate assumption**: Moveable is inside the `scale(DEFAULT_ZOOM)` container. Events (`left`, `top`, `width`, `height`) are assumed to be in viewport (screen) coordinates, so the divisor is `mmToPx * zoom`. Bounds are set in the same viewport-px space: `mmToViewportPx(page.dimension, mmToPx, zoom)`.

4. **Inline style reset**: After `onDragEnd`/`onResizeEnd`, inline px styles applied during drag are cleared (`el.style.left = ""`). React's re-render then applies the reducer-updated mm values, preventing stale px overrides.

5. **Dual dispatch on resize**: Resizing from a top/left corner handle moves the element origin. `onResizeEnd` dispatches BOTH `onResize` (size) and `onMove` (position), chaining the pure reducers.

6. **Backward compatibility**: All new `EditorCanvas` props (`onMove`, `onResize`, `zoom`, `mmToPx`) are optional. Existing tests that render without them continue to pass.

## `npm run build` result

**PASSED** — Next.js build compiled successfully (`✓ Compiled successfully in 11.8s`, 79 static pages generated).
No SSR/bundling issues introduced by the new dependency.

## Files changed

| File | Change |
|---|---|
| `package.json` | Added `react-moveable` dependency |
| `package-lock.json` | Lock file updated (+20 packages) |
| `src/components/sales-sheet/editor/geometry.ts` | **NEW** — pure px↔mm helper functions |
| `src/components/sales-sheet/editor/__tests__/geometry.test.ts` | **NEW** — 13 unit tests |
| `src/components/sales-sheet/editor/EditorCanvas.tsx` | Added "use client", Moveable wiring, new optional props |
| `src/components/sales-sheet/editor/SalesSheetEditor.tsx` | Wired reducers + z-order buttons in properties panel |

## Self-review

- `SalesSheetRenderer` is unchanged ✓  
- Task D reducers are unchanged ✓  
- No new `eslint` warnings/errors in my files (zero new problems) ✓  
- `npx tsc --noEmit` clean ✓  
- `npm test` 7258 tests pass ✓  
- `npm run build` passes ✓  

## Concerns / known limitations

1. **Coordinate scale assumption**: Moveable is inside a `scale(0.75)` CSS transform. Whether Moveable's event coordinates are viewport-px (as assumed) or CSS-px depends on Moveable's internal `getBoundingClientRect` vs `offsetLeft` implementation. If coordinates turn out to be CSS-px, the conversion formula should be `px / mmToPx` (scale=1). This can only be verified in the browser (unit tests prove the math, not the DOM behavior).

2. **Content lag during drag**: The hit-box moves visually but the underlying SalesSheetRenderer content stays at the original mm position during the drag. Content snaps to the new position on `onDragEnd`. This is the "commit on release" pattern, acceptable for Task F.

3. **Keyboard-activated selection**: `onKeyDown` (Enter/Space) triggers `onSelect` but not `setMoveableTarget`, so keyboard-selected elements won't have Moveable handles. This is a known gap; interactive drag/resize inherently requires pointer input, and fixing keyboard activation would require a ref-Map approach with a more relaxed lint configuration.

4. **Task G `zoom` migration**: When Task G adds zoom controls (`DEFAULT_ZOOM` → `useState`), the `zoom` prop is already threaded through `EditorCanvas` for easy migration.

## Fix: resize dispatch + polish

Commit `12bf431` — review-driven fixes applied on top of `7d6999f`.

### Important — resize-move redundant dispatch (fixed)

`handleResizeEnd` now fetches `currentEl = elements.find(e => e.id === selectedId)` from the already-destructured `elements` array (in scope from the component closure) and compares the converted mm `x`/`y` against `currentEl.x` / `currentEl.y` with `ORIGIN_EPSILON = 0.01 mm`. `onMove` is dispatched only when the origin actually shifted (or `currentEl` is not found as a safe fallback). A bottom/right-handle resize no longer fires a redundant `setEditorState` or marks the document dirty. Comment updated to match the new conditional logic.

### Minor: stale-closure guard in SalesSheetEditor (fixed)

`handleBringToFront` / `handleSendToBack` now use `setEditorState(prev => prev.selectedId ? bringToFront(prev, prev.selectedId) : prev)`. The outer `if (editorState.selectedId)` guard and the `!` non-null assertion are removed. The guard now reads `prev.selectedId` inside the updater — always fresh, no stale-closure risk.

### Minor: Moveable render gate prop coupling (fixed)

`{moveableTarget && onMove && (` changed to `{moveableTarget && (onMove || onResize) && (`. The individual handlers (`handleDragEnd`, `handleResizeEnd`) already guard their own callbacks, so there is no behaviour change at the existing call site (which provides both). An `onResize`-only call site would now also receive handles.

### Minor: `dynamic<any>` typing (fixed — properly typed)

`MoveableProps` is exported from `react-moveable` (confirmed in `declaration/types.d.ts`). Changed to `dynamic<MoveableProps>(() => import("react-moveable"), { ssr: false })` and added `MoveableProps` to the existing type-only import. The `eslint-disable-next-line @typescript-eslint/no-explicit-any` comment was removed. `npx tsc --noEmit` passes cleanly with the new type.

### Test + build results

- `npm test`: 7258 passed, 2 skipped — no regressions (geometry tests + all editor tests pass)
- `npx tsc --noEmit`: clean (no output)
- `npm run lint`: zero new problems in changed files (EditorCanvas.tsx, SalesSheetEditor.tsx produce no lint output)
- `npm run build`: `✓ Compiled successfully in 12.1s`, 79 static pages generated — no errors
