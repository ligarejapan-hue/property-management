/**
 * 査定報告書の「周辺施設情報」のページを、別のスレッド(worker)で読む(2026-11-11)。
 * 返すのは、そのページの行の文字と、地図に置かれた小さな画像(アイコン)の位置と色だけ。
 * ⚠重い PDF で止まらないよう、時間の上限で worker ごと止める(pdf-extract-worker と同じ作り)。
 * ⚠pdfjs-dist は serverExternalPackages=node_modules にそのままあるので、作業フォルダの node_modules から読む。
 */
import { Worker } from "node:worker_threads";
import type { FacilityPageRaw } from "./facilities";

export const FACILITY_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
(async () => {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const pdfjs = await import(pathToFileURL(req.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(workerData), isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
  try {
    const O = pdfjs.OPS;
    for (let pn = 1; pn <= Math.min(doc.numPages, 80); pn++) {
      const page = await doc.getPage(pn);
      const tc = await page.getTextContent();
      const flat = tc.items.map((i) => i.str || "").join("").normalize("NFKC").replace(/\\s/g, "");
      if (!flat.includes("最寄りの各種施設")) { page.cleanup(); continue; }
      // 行にまとめる(同じ高さの文字を左から)
      const rows = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = it.transform[5], x = it.transform[4];
        let r = rows.find((q) => Math.abs(q.y - y) < 2.5);
        if (!r) { r = { y, parts: [] }; rows.push(r); }
        r.parts.push({ x, s: it.str, w: it.width || 0 });
      }
      rows.sort((a, b) => b.y - a.y);
      const lines = rows.map((r) => { r.parts.sort((a, b) => a.x - b.x); let out = "", end = null;
        for (const p of r.parts) { if (end !== null && p.x - end > 4) out += " "; out += p.s; end = p.x + p.w; } return out; });
      // 地図に置かれた小さな画像の位置と色
      const ops = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0]; const st = [];
      const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
      const icons = [];
      for (let i = 0; i < ops.fnArray.length && icons.length < 400; i++) {
        const f = ops.fnArray[i], a = ops.argsArray[i];
        if (f === O.save) st.push(ctm); else if (f === O.restore) ctm = st.pop() || [1, 0, 0, 1, 0, 0];
        else if (f === O.transform) ctm = mul(ctm, a);
        else if (f === O.paintImageXObject) {
          const w = ctm[0], h = ctm[3];
          if (!(w > 5 && w < 40 && h > 5 && h < 50 && Math.abs(ctm[1]) < 0.01 && Math.abs(ctm[2]) < 0.01)) continue;
          const img = await new Promise((res) => page.objs.get(a[0], res));
          let rgb = null;
          if (img && img.data && img.width * img.height <= 200 * 200) {
            const n = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 0;
            if (n) { const cnt = new Map();
              for (let p = 0; p + n - 1 < img.data.length; p += n) {
                const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2], al = n === 4 ? img.data[p + 3] : 255;
                if (al > 250 && Math.max(r, g, b) - Math.min(r, g, b) > 60) { const k = (r >> 3) + "," + (g >> 3) + "," + (b >> 3); cnt.set(k, (cnt.get(k) || 0) + 1); } }
              let best = null, bc = 0; for (const [k, c] of cnt) if (c > bc) { bc = c; best = k; }
              if (best) rgb = best.split(",").map((v) => Number(v) * 8 + 4);
            }
          }
          icons.push({ x: ctm[4] + w / 2, y: ctm[5], rgb });
        }
      }
      parentPort.postMessage({ ok: true, page: { lines: lines.slice(0, 400), icons } });
      return;
    }
    parentPort.postMessage({ ok: true, page: null });
  } finally {
    try { await doc.destroy(); } catch {}
  }
})().catch((e) => {
  parentPort.postMessage({ ok: false, name: e && e.name ? String(e.name) : "Error" });
});
`;

/** 周辺施設情報のページを読む。無ければ null。時間切れ・失敗は null(下書きは施設なしで作る)。 */
export function readFacilityPageInWorker(buffer: Buffer, timeoutMs: number, source: string = FACILITY_WORKER_SOURCE): Promise<FacilityPageRaw | null> {
  return new Promise((resolve) => {
    const worker = new Worker(source, { eval: true, workerData: buffer });
    let settled = false;
    const finish = (v: FacilityPageRaw | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.once("message", (m: { ok: boolean; page?: FacilityPageRaw | null }) => finish(m.ok ? (m.page ?? null) : null));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
