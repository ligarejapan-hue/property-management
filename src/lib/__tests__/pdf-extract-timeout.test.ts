/**
 * extractTextFromPdf の時間の上限(謄本の名義の比べ・2026-11-08 発注者依頼):
 * 上限を渡したときだけ打ち切り、打ち切ったら code=PDF_READ_TIMEOUT を投げて destroy する。
 * 上限を渡さない呼び出しは今までどおり(打ち切らない)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getText, destroy } = vi.hoisted(() => ({ getText: vi.fn(), destroy: vi.fn(async () => {}) }));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getText = getText;
    destroy = destroy;
  },
}));

import { extractTextFromPdf, PDF_READ_TIMEOUT } from "../pdf-extract";
import { hasPendingTimedOutPdfRead } from "../pdf-read-timeout";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractTextFromPdf の時間の上限", () => {
  it("上限の中で読めれば全文を返し、destroy する", async () => {
    getText.mockResolvedValue({ text: "所有者事項" });
    const text = await extractTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 1000 });
    expect(text).toBe("所有者事項");
    expect(getText).toHaveBeenCalledWith();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("時間切れなら code=PDF_READ_TIMEOUT を投げ、destroy は呼ぶ", async () => {
    getText.mockReturnValue(new Promise((resolve) => setTimeout(() => resolve({ text: "" }), 50)));
    const err = await extractTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe(PDF_READ_TIMEOUT);
    expect(destroy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 80)); // 裏の読み取りを終わらせる(次のテストに残さない)
  });

  it("時間切れのあとに読み取りが終わったら、もう一度 destroy する(読み込み中の打ち切りで文書が残らない)", async () => {
    getText.mockReturnValue(new Promise((resolve) => setTimeout(() => resolve({ text: "遅い" }), 60)));
    await extractTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 20 }).catch(() => {});
    expect(destroy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("時間切れの読み取りは、裏で終わるまで「続いている」と数える(@codex #681)", async () => {
    let finish!: (v: { text: string }) => void;
    getText.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    expect(hasPendingTimedOutPdfRead()).toBe(false);
    await extractTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 20 }).catch(() => {});
    expect(hasPendingTimedOutPdfRead()).toBe(true);
    finish({ text: "遅い" });
    await new Promise((r) => setTimeout(r, 10));
    expect(hasPendingTimedOutPdfRead()).toBe(false);
  });

  it("読み取りの失敗はそのまま上がる(時間切れとは別)", async () => {
    getText.mockRejectedValue(new Error("broken"));
    const err = await extractTextFromPdf(Buffer.from("%PDF-"), { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("broken");
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("上限を渡さなければ今までどおり(打ち切らない)", async () => {
    getText.mockResolvedValue({ text: "本文" });
    expect(await extractTextFromPdf(Buffer.from("%PDF-"))).toBe("本文");
    expect(destroy).not.toHaveBeenCalled();
  });
});
