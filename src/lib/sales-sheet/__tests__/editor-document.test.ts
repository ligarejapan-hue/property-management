/**
 * TDD: editor-document reducer tests
 *
 * RED  → run before implementation exists (module not found → all fail)
 * GREEN → after implementation, all tests pass
 */
import { describe, it, expect, vi } from "vitest";
import {
  type EditorState,
  MIN_ELEMENT_SIZE_MM,
  selectElement,
  moveElement,
  resizeElement,
  bringToFront,
  sendToBack,
  setZ,
  deleteElement,
  editText,
  markSaved,
  markSavedIfCurrent,
  exportWithSaveGuard,
} from "../editor-document";
import {
  parseSalesSheetDocument,
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type TextElement,
} from "../document-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 1×1 transparent PNG — offline; no external fetch */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function makeDoc(elements: unknown[] = []): SalesSheetDocument {
  return parseSalesSheetDocument({
    page: A4_LANDSCAPE,
    theme: { fontFamily: "sans-serif", accentColor: "#1f4e79" },
    elements,
  });
}

function makeState(doc?: SalesSheetDocument, overrides: Partial<EditorState> = {}): EditorState {
  return {
    document: doc ?? makeDoc(),
    selectedId: null,
    dirty: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectElement
// ---------------------------------------------------------------------------

describe("selectElement", () => {
  it("sets selectedId to the given id", () => {
    const state = makeState();
    const next = selectElement(state, "el1");
    expect(next.selectedId).toBe("el1");
  });

  it("sets selectedId to null when null is passed", () => {
    const state = makeState(undefined, { selectedId: "el1" });
    const next = selectElement(state, null);
    expect(next.selectedId).toBeNull();
  });

  it("does NOT set dirty (selection is not a document change)", () => {
    const state = makeState();
    const next = selectElement(state, "el1");
    expect(next.dirty).toBe(false);
  });

  it("does not mutate the input state", () => {
    const state = makeState();
    selectElement(state, "changed");
    expect(state.selectedId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// moveElement
// ---------------------------------------------------------------------------

describe("moveElement", () => {
  // A4_LANDSCAPE: width=297, height=210 mm
  // element: w=50, h=10  →  x max=247, y max=200
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "hello" },
  ]);

  it("updates x and y, sets dirty=true", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: 20, y: 30 });
    expect(next.dirty).toBe(true);
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.x).toBe(20);
    expect(el.y).toBe(30);
  });

  it("clamps x to 0 when negative", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: -10, y: 10 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.x).toBe(0);
  });

  it("clamps x to (page.width − element.w) = 247 when too large", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: 9999, y: 10 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.x).toBe(297 - 50); // 247
  });

  it("clamps y to 0 when negative", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: 10, y: -5 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.y).toBe(0);
  });

  it("clamps y to (page.height − element.h) = 200 when too large", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: 10, y: 9999 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.y).toBe(210 - 10); // 200
  });

  it("is a no-op (returns same reference) for unknown id", () => {
    const state = makeState(doc);
    const next = moveElement(state, "no-such-id", { x: 0, y: 0 });
    expect(next).toBe(state);
  });

  it("keeps document parseable after move", () => {
    const state = makeState(doc);
    const next = moveElement(state, "t1", { x: 15, y: 25 });
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("does not mutate the input state document", () => {
    const state = makeState(doc);
    const originalX = doc.elements[0].x;
    moveElement(state, "t1", { x: 99, y: 99 });
    expect(doc.elements[0].x).toBe(originalX);
  });
});

// ---------------------------------------------------------------------------
// resizeElement
// ---------------------------------------------------------------------------

describe("resizeElement", () => {
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "hello" },
  ]);

  it("updates w and h, sets dirty=true", () => {
    const state = makeState(doc);
    const next = resizeElement(state, "t1", { w: 60, h: 15 });
    expect(next.dirty).toBe(true);
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.w).toBe(60);
    expect(el.h).toBe(15);
  });

  it(`clamps w to MIN_ELEMENT_SIZE_MM (${MIN_ELEMENT_SIZE_MM}mm) when too small`, () => {
    const state = makeState(doc);
    const next = resizeElement(state, "t1", { w: 1, h: 15 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.w).toBe(MIN_ELEMENT_SIZE_MM);
  });

  it(`clamps h to MIN_ELEMENT_SIZE_MM (${MIN_ELEMENT_SIZE_MM}mm) when too small`, () => {
    const state = makeState(doc);
    const next = resizeElement(state, "t1", { w: 50, h: 0.5 });
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.h).toBe(MIN_ELEMENT_SIZE_MM);
  });

  it("keeps document parseable after resize (even with tiny input)", () => {
    const state = makeState(doc);
    const next = resizeElement(state, "t1", { w: 0, h: 0 }); // clamped to 5,5
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("is a no-op for unknown id", () => {
    const state = makeState(doc);
    expect(resizeElement(state, "ghost", { w: 10, h: 10 })).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// bringToFront
// ---------------------------------------------------------------------------

describe("bringToFront", () => {
  // z values: t1=1, t2=3, t3=2  →  max=3  →  bringToFront t1 → z=4
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "a" },
    { id: "t2", type: "text", x: 20, y: 20, w: 50, h: 10, z: 3, content: "b" },
    { id: "t3", type: "text", x: 30, y: 30, w: 50, h: 10, z: 2, content: "c" },
  ]);

  it("sets z to max+1 and dirty=true", () => {
    const state = makeState(doc);
    const next = bringToFront(state, "t1");
    expect(next.dirty).toBe(true);
    const el = next.document.elements.find((e) => e.id === "t1")!;
    expect(el.z).toBe(4); // max(1,3,2) + 1 = 4
  });

  it("does not change other elements' z values", () => {
    const state = makeState(doc);
    const next = bringToFront(state, "t1");
    expect(next.document.elements.find((e) => e.id === "t2")!.z).toBe(3);
    expect(next.document.elements.find((e) => e.id === "t3")!.z).toBe(2);
  });

  it("keeps document parseable after bringToFront", () => {
    const next = bringToFront(makeState(doc), "t1");
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("is a no-op for unknown id", () => {
    const state = makeState(doc);
    expect(bringToFront(state, "ghost")).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// sendToBack
// ---------------------------------------------------------------------------

describe("sendToBack", () => {
  // z values: t1=1, t2=3, t3=2  →  min=1  →  sendToBack t2 → z=0
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "a" },
    { id: "t2", type: "text", x: 20, y: 20, w: 50, h: 10, z: 3, content: "b" },
    { id: "t3", type: "text", x: 30, y: 30, w: 50, h: 10, z: 2, content: "c" },
  ]);

  it("sets z to min-1 and dirty=true", () => {
    const state = makeState(doc);
    const next = sendToBack(state, "t2");
    expect(next.dirty).toBe(true);
    const el = next.document.elements.find((e) => e.id === "t2")!;
    expect(el.z).toBe(0); // min(1,3,2) - 1 = 0
  });

  it("keeps document parseable after sendToBack", () => {
    const next = sendToBack(makeState(doc), "t2");
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("is a no-op for unknown id", () => {
    const state = makeState(doc);
    expect(sendToBack(state, "ghost")).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// setZ
// ---------------------------------------------------------------------------

describe("setZ", () => {
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "a" },
  ]);

  it("sets z to the given integer value and dirty=true", () => {
    const state = makeState(doc);
    const next = setZ(state, "t1", 10);
    expect(next.dirty).toBe(true);
    expect(next.document.elements.find((e) => e.id === "t1")!.z).toBe(10);
  });

  it("truncates non-integer values (floor toward zero)", () => {
    const state = makeState(doc);
    const next = setZ(state, "t1", 3.7);
    expect(next.document.elements.find((e) => e.id === "t1")!.z).toBe(3);
  });

  it("keeps document parseable after setZ", () => {
    const next = setZ(makeState(doc), "t1", 5);
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("is a no-op for unknown id", () => {
    const state = makeState(doc);
    expect(setZ(state, "ghost", 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// deleteElement
// ---------------------------------------------------------------------------

describe("deleteElement", () => {
  const doc = makeDoc([
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1, content: "a" },
    { id: "t2", type: "text", x: 20, y: 20, w: 50, h: 10, z: 2, content: "b" },
  ]);

  it("removes the element and sets dirty=true", () => {
    const state = makeState(doc);
    const next = deleteElement(state, "t1");
    expect(next.dirty).toBe(true);
    expect(next.document.elements.find((e) => e.id === "t1")).toBeUndefined();
    expect(next.document.elements).toHaveLength(1);
  });

  it("clears selectedId when the deleted element was selected", () => {
    const state = makeState(doc, { selectedId: "t1" });
    const next = deleteElement(state, "t1");
    expect(next.selectedId).toBeNull();
  });

  it("preserves selectedId when a different element is deleted", () => {
    const state = makeState(doc, { selectedId: "t2" });
    const next = deleteElement(state, "t1");
    expect(next.selectedId).toBe("t2");
  });

  it("is a no-op (same reference) for unknown id", () => {
    const state = makeState(doc);
    expect(deleteElement(state, "ghost")).toBe(state);
  });

  it("keeps document parseable after delete", () => {
    const next = deleteElement(makeState(doc), "t1");
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("does not mutate the input state", () => {
    const state = makeState(doc);
    deleteElement(state, "t1");
    expect(doc.elements).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// editText
// ---------------------------------------------------------------------------

describe("editText", () => {
  const doc = makeDoc([
    {
      id: "t1", type: "text", x: 10, y: 10, w: 50, h: 10, z: 1,
      content: "hello", style: { fontSizePt: 12, color: "#000000" },
    },
    {
      id: "img1", type: "image", x: 20, y: 20, w: 30, h: 30, z: 2,
      src: TINY_PNG, fit: "cover",
    },
  ]);

  it("updates content and sets dirty=true", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { content: "world" });
    expect(next.dirty).toBe(true);
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.content).toBe("world");
  });

  it("applies a valid hex color to style.color", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { color: "#ff0000" });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.color).toBe("#ff0000");
  });

  it("rejects invalid color (expression(...)) — style.color stays unchanged", () => {
    // Start from a state where color is already "#000000"
    const state = makeState(doc);
    const next = editText(state, "t1", { color: "expression(alert(1))" });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.color).toBe("#000000"); // unchanged from original
  });

  it("rejects url()-based color (SSRF vector)", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { color: "url(http://evil.com/x.png)" });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.color).toBe("#000000"); // unchanged
  });

  it("applies a valid fontFamily to style.fontFamily", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { fontFamily: "sans-serif" });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.fontFamily).toBe("sans-serif");
  });

  it("rejects unsafe fontFamily containing url()", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { fontFamily: "url(http://evil.com/)" });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.fontFamily).toBeUndefined();
  });

  it("applies a positive fontSizePt to style.fontSizePt", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { fontSizePt: 18 });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.fontSizePt).toBe(18);
  });

  it("ignores non-positive fontSizePt (would fail schema validation)", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", { fontSizePt: 0 });
    const el = next.document.elements.find((e) => e.id === "t1") as TextElement;
    expect(el.style.fontSizePt).toBe(12); // unchanged from original
  });

  it("is a no-op (same reference) on a non-text element (image)", () => {
    const state = makeState(doc);
    const next = editText(state, "img1", { content: "ignored" });
    expect(next).toBe(state);
  });

  it("is a no-op (same reference) for unknown id", () => {
    const state = makeState(doc);
    const next = editText(state, "ghost", { content: "ignored" });
    expect(next).toBe(state);
  });

  it("keeps document parseable after a combined patch", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", {
      content: "new text",
      color: "#abcdef",
      fontSizePt: 14,
      fontFamily: "Arial",
    });
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("keeps document parseable even when invalid color/font are rejected", () => {
    const state = makeState(doc);
    const next = editText(state, "t1", {
      color: "expression(evil)",
      fontFamily: "</style>",
    });
    expect(() => parseSalesSheetDocument(next.document)).not.toThrow();
  });

  it("does not mutate the input state document", () => {
    const state = makeState(doc);
    const originalContent = (doc.elements[0] as TextElement).content;
    editText(state, "t1", { content: "mutated?" });
    expect((doc.elements[0] as TextElement).content).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// markSaved
// ---------------------------------------------------------------------------

describe("markSaved", () => {
  it("sets dirty to false", () => {
    const state = makeState(undefined, { dirty: true });
    expect(markSaved(state).dirty).toBe(false);
  });

  it("preserves document and selectedId", () => {
    const doc = makeDoc();
    const state: EditorState = { document: doc, selectedId: "t1", dirty: true };
    const next = markSaved(state);
    expect(next.document).toBe(doc); // same reference
    expect(next.selectedId).toBe("t1");
  });

  it("is idempotent when already clean", () => {
    const state = makeState(undefined, { dirty: false });
    expect(markSaved(state).dirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markSavedIfCurrent
// ---------------------------------------------------------------------------

describe("markSavedIfCurrent", () => {
  it("clears dirty when the document is unchanged since the save started", () => {
    const state = makeState(undefined, { dirty: true });
    const next = markSavedIfCurrent(state, state.document);
    expect(next.dirty).toBe(false);
  });

  it("keeps dirty (and the same state) when the document changed mid-save", () => {
    const sent = makeDoc(); // a different document reference than state.document
    const state = makeState(undefined, { dirty: true });
    const next = markSavedIfCurrent(state, sent);
    expect(next.dirty).toBe(true);
    expect(next).toBe(state);
  });
});

describe("exportWithSaveGuard", () => {
  it("dirty=false のときは保存せず export する", async () => {
    const save = vi.fn(async () => true);
    const doExport = vi.fn(async () => {});
    await exportWithSaveGuard({ dirty: false, save, doExport });
    expect(save).not.toHaveBeenCalled();
    expect(doExport).toHaveBeenCalledOnce();
  });

  it("dirty=true で保存がクリーン化したら save→export の順に実行", async () => {
    const calls: string[] = [];
    const save = vi.fn(async () => {
      calls.push("save");
      return true; // クリーンに保存できた
    });
    const doExport = vi.fn(async () => {
      calls.push("export");
    });
    await exportWithSaveGuard({ dirty: true, save, doExport });
    expect(calls).toEqual(["save", "export"]);
  });

  it("保存中に編集があり dirty のままなら export せず throw（stale 出力防止）", async () => {
    const save = vi.fn(async () => false); // 競合編集でクリーン化されず
    const doExport = vi.fn(async () => {});
    await expect(
      exportWithSaveGuard({ dirty: true, save, doExport }),
    ).rejects.toThrow();
    expect(doExport).not.toHaveBeenCalled();
  });
});
