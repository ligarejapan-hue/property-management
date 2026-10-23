/**
 * extractHeadTextFromPdf: 先頭の数ページだけ読み、必ず destroy し、時間切れは null。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getText, destroy } = vi.hoisted(() => ({ getText: vi.fn(), destroy: vi.fn(async () => {}) }));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getText = getText;
    destroy = destroy;
  },
}));

import { extractHeadTextFromPdf } from "../pdf-extract";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractHeadTextFromPdf", () => {
  it("先頭2ページだけ読み、読み終えたら destroy する", async () => {
    getText.mockResolvedValue({ text: "売買契約書" });
    const text = await extractHeadTextFromPdf(Buffer.from("%PDF-"));
    expect(text).toBe("売買契約書");
    expect(getText).toHaveBeenCalledWith({ first: 2 });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("読み取りが失敗しても destroy は呼ばれ、例外はそのまま上がる", async () => {
    getText.mockRejectedValue(new Error("broken"));
    await expect(extractHeadTextFromPdf(Buffer.from("%PDF-"))).rejects.toThrow("broken");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("時間切れなら null(destroy は呼ぶ)", async () => {
    getText.mockReturnValue(new Promise(() => {}));
    const text = await extractHeadTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 20 });
    expect(text).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
