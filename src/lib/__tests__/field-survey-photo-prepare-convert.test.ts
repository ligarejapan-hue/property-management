/**
 * prepareFieldSurveyPhotoForUpload の変換本体を browser API モックで実行検証。
 *
 * ソース静的検証だけでは decode → canvas → toBlob → File 生成の orchestration
 * 破損を検知できない (Codex P2)。createImageBitmap / document.createElement を
 * vi.stubGlobal でモックし、成功・ラダー再試行・失敗分岐を実際に呼んで固定する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  prepareFieldSurveyPhotoForUpload,
  PHOTO_TOO_LARGE_MESSAGE,
} from "@/lib/field-survey-photo-prepare";
import { MAX_FILE_SIZE } from "@/lib/storage/types";

interface FakeCtx {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (kind: string) => FakeCtx | null;
  toBlob: (
    cb: (b: Blob | null) => void,
    type?: string,
    quality?: number,
  ) => void;
  ctx: FakeCtx;
  toBlobCalls: { type?: string; quality?: number; width: number; height: number }[];
}

/** document.createElement("canvas") のモック。toBlob の挙動を注入できる。 */
function stubCanvasDocument(
  toBlobImpl: (canvas: FakeCanvas, attemptIndex: number) => Blob | null,
): { canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];
  let attemptIndex = 0;
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement: ${tag}`);
      const ctx: FakeCtx = {
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      };
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: (kind: string) => (kind === "2d" ? ctx : null),
        toBlob: (cb, type, quality) => {
          canvas.toBlobCalls.push({
            type,
            quality,
            width: canvas.width,
            height: canvas.height,
          });
          cb(toBlobImpl(canvas, attemptIndex++));
        },
        ctx,
        toBlobCalls: [],
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  return { canvases };
}

function stubBitmap(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  return { close };
}

const smallJpegBlob = () =>
  new Blob([new Uint8Array(1000)], { type: "image/jpeg" });
const oversizedBlob = () =>
  new Blob([new Uint8Array(MAX_FILE_SIZE + 1)], { type: "image/jpeg" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareFieldSurveyPhotoForUpload — 実行検証 (browser API モック)", () => {
  it("8MB 以内の JPEG は browser API に触れず同一 File を返す", async () => {
    const file = new File([new Uint8Array(100)], "ok.jpg", {
      type: "image/jpeg",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file).toBe(file);
      expect(r.converted).toBe(false);
    }
  });

  it("HEIC は decode → 縮小 → JPEG File になり、bitmap は release される", async () => {
    const { close } = stubBitmap(4000, 3000);
    const { canvases } = stubCanvasDocument(() => smallJpegBlob());
    const file = new File([new Uint8Array(100)], "IMG_0001.HEIC", {
      type: "image/heic",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.converted).toBe(true);
      expect(r.file.type).toBe("image/jpeg");
      expect(r.file.name).toBe("IMG_0001.jpg");
      expect(r.file.size).toBeLessThanOrEqual(MAX_FILE_SIZE);
    }
    // 初回 attempt: 長辺 2560 (4000x3000 → 2560x1920)・白敷き・描画済み
    expect(canvases.length).toBe(1);
    expect(canvases[0].toBlobCalls[0]).toMatchObject({
      type: "image/jpeg",
      quality: 0.85,
      width: 2560,
      height: 1920,
    });
    expect(canvases[0].ctx.fillRect).toHaveBeenCalled();
    expect(canvases[0].ctx.drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("8MB 超の JPEG も縮小対象になり、成功時は 8MB 以下の JPEG になる", async () => {
    stubBitmap(8000, 6000);
    stubCanvasDocument(() => smallJpegBlob());
    const big = new File([new Uint8Array(64)], "big.jpg", {
      type: "image/jpeg",
    });
    Object.defineProperty(big, "size", { value: MAX_FILE_SIZE + 1 });
    const r = await prepareFieldSurveyPhotoForUpload(big);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.converted).toBe(true);
      expect(r.file.type).toBe("image/jpeg");
    }
  });

  it("生成 blob が大きい間はラダーを降りて 3 段目で採用する", async () => {
    stubBitmap(6000, 4000);
    const { canvases } = stubCanvasDocument((_canvas, attemptIndex) =>
      attemptIndex < 2 ? oversizedBlob() : smallJpegBlob(),
    );
    const file = new File([new Uint8Array(100)], "p.heif", {
      type: "image/heif",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.converted).toBe(true);
    // 3 attempt = canvas 3 枚。quality と長辺が段階的に下がる
    const calls = canvases.map((c) => c.toBlobCalls[0]);
    expect(calls.map((c) => c.quality)).toEqual([0.85, 0.8, 0.7]);
    expect(calls.map((c) => c.width)).toEqual([2560, 2048, 1600]);
  });

  it("全段で 8MB 超のままなら PHOTO_TOO_LARGE_MESSAGE で失敗する", async () => {
    stubBitmap(6000, 4000);
    stubCanvasDocument(() => oversizedBlob());
    const file = new File([new Uint8Array(100)], "p.heic", {
      type: "image/heic",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(PHOTO_TOO_LARGE_MESSAGE);
  });

  it("toBlob が常に null (環境起因) ならサイズ文言でなく形式案内で失敗する", async () => {
    stubBitmap(6000, 4000);
    stubCanvasDocument(() => null);
    const file = new File([new Uint8Array(100)], "p.heic", {
      type: "image/heic",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toBe(PHOTO_TOO_LARGE_MESSAGE);
      expect(r.error).toMatch(/互換性優先/);
    }
  });

  it("decode 不能 (createImageBitmap 失敗 + DOM なし) は端末設定の案内で失敗する", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );
    // document は stub しない (node = undefined) → <img> fallback も不可
    const file = new File([new Uint8Array(100)], "IMG_0002.heic", {
      type: "image/heic",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/互換性優先/);
      expect(r.error).toMatch(/Android/);
    }
  });

  it("非画像 (PDF 等) の decode 不能は形式案内 (HEIC 誘導なし) で失敗する", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );
    const file = new File([new Uint8Array(100)], "doc.pdf", {
      type: "application/pdf",
    });
    const r = await prepareFieldSurveyPhotoForUpload(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/JPEG\/PNG/);
      expect(r.error).not.toMatch(/互換性優先/);
    }
  });
});
