/**
 * PDF の文字の抜き出しを**別のスレッド(worker)**で行い、時間の上限で worker ごと止める
 * (謄本の名義の比べ・2026-11-08 発注者依頼・@codex #681 P2)。
 *
 * ⚠同じスレッドで Promise.race しても上限にならない: Node の pdfjs-dist は本物の worker を
 *   使わず、同じスレッドの作り物の worker で解析する。重い PDF ではその細かい処理が続いて
 *   時計の呼び出しが回ってこず、打ち切っても解析は裏で続く(@codex の実測=500ページで上限20ms
 *   が効かず約400msで読み切った)。worker を terminate すれば解析そのものが止まる。
 * ⚠worker のコードは文字列(eval)で渡す(Next の組み立てに別ファイルを入れずに済む)。pdf-parse は
 *   serverExternalPackages=node_modules にそのままあるので、作業フォルダ(本番=/opt/property-management・
 *   systemd の WorkingDirectory)の node_modules から読む。
 */
import { Worker } from "node:worker_threads";
import { PDF_READ_TIMEOUT } from "@/lib/pdf-read-timeout";

/** worker で動かすコード(CommonJS)。workerData=PDF のバイト列。 */
export const PDF_TEXT_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const path = require("node:path");
(async () => {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const { PDFParse } = req("pdf-parse");
  const parser = new PDFParse({ data: Buffer.from(workerData) });
  try {
    const r = await parser.getText();
    parentPort.postMessage({ ok: true, text: r.text });
  } finally {
    try { await parser.destroy(); } catch {}
  }
})().catch((e) => {
  parentPort.postMessage({ ok: false, name: e && e.name ? String(e.name) : "Error" });
});
`;

/**
 * 別のスレッドで全ページの文字を抜き出す。timeoutMs を過ぎたら worker を止め、
 * code=PDF_READ_TIMEOUT を投げる。読み取りの失敗は Error を投げる(謄本由来の文字は載せない)。
 * @param source テスト用(worker で動かすコードを差し替える)
 */
export function extractTextInWorker(
  buffer: Buffer,
  timeoutMs: number,
  source: string = PDF_TEXT_WORKER_SOURCE,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: buffer });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => {
      finish(() => reject(Object.assign(new Error("PDF read timed out"), { code: PDF_READ_TIMEOUT })));
    }, timeoutMs);
    worker.once("message", (m: { ok: boolean; text?: string; name?: string }) => {
      finish(() => {
        if (m.ok) resolve(m.text ?? "");
        else reject(Object.assign(new Error("PDF text extraction failed"), { name: m.name ?? "Error" }));
      });
    });
    worker.once("error", (e) => finish(() => reject(e)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`PDF worker exited (code ${code})`)));
    });
  });
}
