/**
 * DM差込CSV出力の2段階化+送付の確定モーダルのUI配線(PR-A・設計書§2.1/§2.2)。
 * vitest は env=node のためソース表明で固定する(このリポのUIテスト規約)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("src/app/(dashboard)/properties/page.tsx");
const MODAL = read("src/components/properties/dm-batch-confirm-modal.tsx");
const CLIENT = read("src/lib/api-client.ts");

describe("出力ボタンの2段階化", () => {
  it("handleExportDm は createDmBatch → batchId の CSV URL へ遷移する", () => {
    expect(PAGE).toMatch(/createDmBatch\(buildFilterParams\(\)\)/);
    expect(PAGE).toMatch(
      /window\.location\.href = `\/api\/properties\/dm-batches\/\$\{res\.batchId\}\/csv`/,
    );
  });

  it("旧 /api/properties/dm-export への参照がソースから消えている", () => {
    expect(PAGE).not.toContain("/api/properties/dm-export");
  });

  it("rowCount=0 は遷移せず案内を出す", () => {
    expect(PAGE).toMatch(/rowCount === 0[\s\S]{0,200}?出力対象がありません/);
  });

  it("「送付の確定」ボタンは出力可否+write 権限でゲートし、モーダルを開く", () => {
    expect(PAGE).toMatch(/canExportDm && canWriteProperty/);
    expect(PAGE).toMatch(/送付の確定/);
    expect(PAGE).toMatch(/setDmConfirmOpen\(true\)/);
    expect(PAGE).toMatch(/<DmBatchConfirmModal open=\{dmConfirmOpen\}/);
  });
});

describe("送付の確定モーダル", () => {
  it("一覧は fetchUnconfirmedDmBatches・確定は confirmDmBatch を使う", () => {
    expect(MODAL).toMatch(/fetchUnconfirmedDmBatches\(\)/);
    expect(MODAL).toMatch(/confirmDmBatch\(batchId, sentOn\)/);
  });

  it("投函日は今日既定・max=今日(未来日はUIでも選べない)", () => {
    expect(MODAL).toMatch(/useState\(todayJst\(\)\)/);
    expect(MODAL).toMatch(/max=\{todayJst\(\)\}/);
  });

  it("未DLの控えは「未ダウンロード」バッジ+確定ボタン無効(サーバ409の事前案内)", () => {
    expect(MODAL).toContain("未ダウンロード");
    expect(MODAL).toMatch(/disabled=\{!b\.downloadedAt/);
  });

  it("完了は件数入りのメッセージ(平易な日本語)", () => {
    expect(MODAL).toContain("件の送付を記録しました");
  });
});

describe("api-client の追加ヘルパー", () => {
  it("createDmBatch は safeRandomId で attemptKey を採番(crypto.randomUUID を使わない)", () => {
    expect(CLIENT).toMatch(/attemptKey: safeRandomId\(\)/);
    // コメント中の言及は許容し、実呼び出し(crypto.randomUUID( )だけを禁止する。
    expect(CLIENT).not.toContain("crypto.randomUUID(");
  });

  it("3ヘルパーとも USE_MOCK 分岐を持つ(dev モックで 403 にならない)", () => {
    for (const fn of ["createDmBatch", "fetchUnconfirmedDmBatches", "confirmDmBatch"]) {
      const start = CLIENT.indexOf(`export async function ${fn}(`);
      expect(start, `${fn} が見つからない`).toBeGreaterThan(0);
      const next = CLIENT.indexOf("export async function", start + 1);
      const body = CLIENT.slice(start, next === -1 ? undefined : next);
      expect(body, `${fn} に USE_MOCK 分岐がない`).toMatch(/if \(USE_MOCK\)/);
    }
  });
});
