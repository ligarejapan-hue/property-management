import { describe, expect, it, vi } from "vitest";
import { DOC_FILE_ACCEPT_BYTES, DOC_FILE_MAX_BYTES, DOC_PDF_COMPRESS_TIMEOUT_MS, DOC_PDF_UPLOAD_MAX_BYTES } from "../constants";
import { fitSubmittedPdf } from "../fit-pdf";

const MB = 1024 * 1024;
const pdf = (bytes: number) => Buffer.alloc(bytes, 1);
// ⚠大きい Buffer を toEqual で比べると1バイトずつ見て遅いので、同じものかを toBe で見る。
type Fitted = Awaited<ReturnType<typeof fitSubmittedPdf>>;
const expectKept = (r: Fitted, buffer: Buffer, compressed: boolean) => {
  if (!r.ok) throw new Error(r.reason);
  expect(r.buffer).toBe(buffer);
  expect(r.compressed).toBe(compressed);
};

describe("お客様の PDF を縮める(2026-11-06 発注者「8MBを超えたら自動圧縮」)", () => {
  it("上限の数: 縮める目標は 8MB・受け取るのは 30MB まで・縮まなくても 20MB までは保存", () => {
    expect(DOC_FILE_MAX_BYTES).toBe(8 * MB);
    expect(DOC_PDF_UPLOAD_MAX_BYTES).toBe(30 * MB);
    expect(DOC_FILE_ACCEPT_BYTES).toBe(20 * MB);
  });
  it("8MB 以下には手を触れない(圧縮の部品を呼ばない)", async () => {
    const compress = vi.fn();
    const input = pdf(DOC_FILE_MAX_BYTES);
    expectKept(await fitSubmittedPdf(input, compress), input, false);
    expect(compress).not.toHaveBeenCalled();
  });
  it("8MB を超えたら、8MB を目標・20MB を受け取りの上限にして縮める", async () => {
    const small = pdf(3 * MB);
    const compress = vi.fn(async () => ({ ok: true as const, buffer: small, level: "jpeg85" as const, inBytes: 12 * MB, outBytes: 3 * MB }));
    const input = pdf(12 * MB);
    expectKept(await fitSubmittedPdf(input, compress), small, true);
    const args = compress.mock.calls[0] as unknown[];
    expect(args[0]).toBe(input);
    expect(args.slice(1)).toEqual([DOC_FILE_MAX_BYTES, undefined, DOC_FILE_ACCEPT_BYTES, DOC_PDF_COMPRESS_TIMEOUT_MS]);
  });
  it("お客様のファイルの圧縮は 60 秒で止める(社内の添付の 2 分より短く・2026-11-06 発注者)", () => {
    expect(DOC_PDF_COMPRESS_TIMEOUT_MS).toBe(60_000);
  });
  it("縮められなくても、元が 20MB 以下なら元のまま保存する", async () => {
    const compress = vi.fn(async () => ({ ok: false as const, reason: "too_large" as const, inBytes: 9 * MB, bestBytes: 9 * MB }));
    const input = pdf(9 * MB);
    expectKept(await fitSubmittedPdf(input, compress), input, false);
  });
  it("縮んでいなければ縮めたことにしない(元のまま)", async () => {
    const input = pdf(9 * MB);
    const compress = vi.fn(async () => ({ ok: true as const, buffer: pdf(9 * MB), level: "lossless" as const, inBytes: 9 * MB, outBytes: 9 * MB }));
    expectKept(await fitSubmittedPdf(input, compress), input, false);
  });
  it("8MB を超えたものを元のまま残すのは、PDF として読めて縮みきらなかったときだけ", async () => {
    const input = pdf(9 * MB);
    const fail = (reason: "invalid_pdf" | "encrypted" | "error" | "unavailable") => vi.fn(async () => ({ ok: false as const, reason, inBytes: 9 * MB, bestBytes: null }));
    expect(await fitSubmittedPdf(input, fail("invalid_pdf"))).toEqual({ ok: false, reason: "unreadable" });
    expect(await fitSubmittedPdf(input, fail("encrypted"))).toEqual({ ok: false, reason: "encrypted" });
    expect(await fitSubmittedPdf(input, fail("error"))).toEqual({ ok: false, reason: "too_large" });
    expect(await fitSubmittedPdf(input, fail("unavailable"))).toEqual({ ok: false, reason: "too_large" });
  });
  it("20MB を超えたまま縮められなければ断る(パスワード付きはその理由で)", async () => {
    const input = pdf(25 * MB);
    expect(await fitSubmittedPdf(input, vi.fn(async () => ({ ok: false as const, reason: "too_large" as const, inBytes: 25 * MB, bestBytes: 21 * MB })))).toEqual({ ok: false, reason: "too_large" });
    expect(await fitSubmittedPdf(input, vi.fn(async () => ({ ok: false as const, reason: "encrypted" as const, inBytes: 25 * MB, bestBytes: null })))).toEqual({ ok: false, reason: "encrypted" });
    expect(await fitSubmittedPdf(input, vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const, inBytes: 25 * MB, bestBytes: null })))).toEqual({ ok: false, reason: "too_large" });
  });
});
