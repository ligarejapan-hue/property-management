/**
 * extractTextFromPdf の時間の上限(謄本の名義の比べ・2026-11-08 発注者依頼・@codex #681):
 * 上限を渡したときだけ別のスレッド(worker)で読み、時間切れなら worker ごと止めて
 * code=PDF_READ_TIMEOUT を投げる。**本物の pdf-parse を worker で動かす**(作り物にしない)。
 * ⚠同じスレッドの Promise.race では、重い PDF の解析中に時計が回らず上限が効かなかった
 *   (@codex の実測)。ここでは重い PDF でも上限どおりに戻ることを確かめる。
 */
import { describe, it, expect } from "vitest";
import { extractTextFromPdf, PDF_READ_TIMEOUT } from "../pdf-extract";
import { extractTextInWorker } from "../pdf-extract-worker";

/** 1ページに1行の文字を置いた、最小限の本物の PDF(架空の文字だけ)。 */
function buildPdf(pages: number, line = "OWNER TEST"): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  // 1=Catalog 2=Pages 3=Font、4 以降にページと中身
  for (let i = 0; i < pages; i++) {
    const pageNo = 4 + i * 2;
    kids.push(`${pageNo} 0 R`);
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (let i = 0; i < pages; i++) {
    const pageNo = 4 + i * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${line} ${i + 1}) Tj ET`;
    objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
    objs[pageNo + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("extractTextFromPdf の時間の上限(worker)", () => {
  it("上限の中で読めれば全文を返す", async () => {
    const text = await extractTextFromPdf(buildPdf(2), { timeoutMs: 15_000 });
    expect(text).toContain("OWNER TEST 1");
    expect(text).toContain("OWNER TEST 2");
  }, 20_000);

  it("重い PDF でも上限どおりに打ち切る(解析が続いて上限を越えない)", async () => {
    const heavy = buildPdf(12000); // 打ち切らずに読むと数秒かかる重さ
    const started = Date.now();
    const err = await extractTextFromPdf(heavy, { timeoutMs: 100 }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect((err as { code?: unknown }).code).toBe(PDF_READ_TIMEOUT);
    expect(elapsed).toBeLessThan(1_000);
  }, 20_000);

  it("止まらない処理でも worker ごと止める", async () => {
    const started = Date.now();
    const err = await extractTextInWorker(Buffer.from("x"), 100, "for(;;){}").catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe(PDF_READ_TIMEOUT);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 20_000);

  it("壊れた PDF は読み取りの失敗(時間切れとは別)", async () => {
    const err = await extractTextFromPdf(Buffer.from("not a pdf"), { timeoutMs: 15_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: unknown }).code).toBeUndefined();
  }, 20_000);
});
