/**
 * 周辺施設のページを別スレッドで読む(2026-11-11)。worker のコードを差し替えて、結果の受け渡しと時間切れを確かめる。
 */
import { describe, it, expect } from "vitest";
import { readFacilityPageInWorker } from "../facilities-worker";

const reply = (body: string) => `const { parentPort } = require("node:worker_threads"); ${body}`;

describe("readFacilityPageInWorker", () => {
  it("worker が返したページの中身を返す", async () => {
    const page = { lines: ["最寄りの各種施設"], icons: [{ x: 1, y: 2, rgb: [1, 2, 3] }] };
    expect(await readFacilityPageInWorker(Buffer.from("x"), 5000, reply(`parentPort.postMessage({ ok: true, page: ${JSON.stringify(page)} });`))).toEqual(page);
  });
  it("ページが無い・失敗・時間切れは null(下書きは施設なしで作る)", async () => {
    expect(await readFacilityPageInWorker(Buffer.from("x"), 5000, reply(`parentPort.postMessage({ ok: true, page: null });`))).toBeNull();
    expect(await readFacilityPageInWorker(Buffer.from("x"), 5000, reply(`parentPort.postMessage({ ok: false });`))).toBeNull();
    expect(await readFacilityPageInWorker(Buffer.from("x"), 5000, `throw new Error("boom")`)).toBeNull();
    const t0 = Date.now();
    expect(await readFacilityPageInWorker(Buffer.from("x"), 200, `setInterval(() => {}, 1000);`)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
