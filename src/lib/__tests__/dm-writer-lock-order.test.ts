/**
 * DM writer 全経路のロック順序「Owner → (variant) → 物件親行 → 子行」の横断ソース固定
 * (PR-A・設計書§2.2。型は property-record-scope-align.test.ts を踏襲)。
 *  - 控えCSV(初回GET): Owner FOR SHARE → 物件 FOR SHARE → バッチ FOR UPDATE → items 再読取
 *  - 一括確定: Owner FOR SHARE → 物件 FOR UPDATE → バッチ updateMany → items FOR UPDATE
 *  - mark-sent: Owner FOR SHARE → 親行 FOR UPDATE → 条件付き updateMany → 再読取
 *  - 宛先生成: Owner FOR SHARE → 物件 FOR SHARE → リンク再検証 → draft INSERT
 *  - 個別記録 POST/DELETE: tx 先頭が lockPropertyRecordForWrite
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

/** src 内の指定 tx ブロック(最初の $transaction)を切り出す。 */
function firstTx(src: string): string {
  const start = src.indexOf("$transaction(async (tx)");
  expect(start, "tx が見つからない").toBeGreaterThan(0);
  return src.slice(start);
}

function assertOrder(label: string, text: string, needles: string[]) {
  let last = -1;
  for (const n of needles) {
    const idx = text.indexOf(n);
    expect(idx, `${label}: 「${n}」が見つからない`).toBeGreaterThan(-1);
    expect(idx, `${label}: 「${n}」の順序が規約と逆`).toBeGreaterThan(last);
    last = idx;
  }
}

describe("DM writer のロック順序(Owner→親→子)", () => {
  it("控えCSV 初回GET(凍結tx)", () => {
    const tx = firstTx(read("src/app/api/properties/dm-batches/[id]/csv/route.ts"));
    assertOrder("csv GET", tx, [
      "readItemsWithOwners", // 先読み(ロックなし)
      "lockOwnersForShare",
      "lockPropertiesForShare",
      "FOR UPDATE", // バッチ行
      "checkBatchEligibility",
    ]);
  });

  it("一括確定", () => {
    const tx = firstTx(read("src/app/api/properties/dm-batches/[id]/confirm/route.ts"));
    assertOrder("confirm", tx, [
      "readItemsWithOwners",
      "lockOwnersForShare",
      "lockPropertiesForUpdate",
      "dmExportBatch.updateMany", // 勝者決定=バッチ行ロック
      "FROM dm_export_batch_items",
      "propertyDmLog.createMany",
    ]);
  });

  it("mark-sent(売却DMブリッジ)", () => {
    const tx = firstTx(read("src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts"));
    assertOrder("mark-sent", tx, [
      "lockOwnersForShare",
      "FROM properties", // 親行 FOR UPDATE(R50)
      "dmRecipientDraft.updateMany",
      "propertyDmLog.create",
      "propertyDmLogOwner.createMany",
    ]);
  });

  it("宛先生成(campaigns POST)", () => {
    const tx = firstTx(read("src/app/api/properties/sale-dm/campaigns/route.ts"));
    assertOrder("campaigns", tx, [
      "lockOwnersForShare",
      "lockPropertiesForShare",
      "propertyOwner.findMany", // ロック保持中のリンク再検証
      "dmRecipientDraft.create",
      "dmRecipientDraftOwner.createMany",
    ]);
  });

  it("個別記録 POST/DELETE は tx 先頭が親行ロック", () => {
    for (const [label, p, write] of [
      ["個別記録POST", "src/app/api/properties/[id]/dm-logs/route.ts", "tx.propertyDmLog.create"],
      ["個別記録DELETE", "src/app/api/properties/[id]/dm-logs/[logId]/route.ts", "tx.propertyDmLog.delete"],
    ] as const) {
      const tx = firstTx(read(p));
      assertOrder(label, tx, ["lockPropertyRecordForWrite(tx,", write]);
    }
  });

  it("ロックヘルパーは id を昇順ソートし ORDER BY 付きで取得する(取得順の統一)", () => {
    const src = read("src/lib/dm-batch/locks.ts");
    expect(src).toMatch(/sortUniqueIds/);
    expect(src).toMatch(/ORDER BY id FOR SHARE/);
    expect(src).toMatch(/ORDER BY id FOR UPDATE/);
  });
});
