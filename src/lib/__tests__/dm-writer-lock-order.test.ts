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

describe("DM 反響 writer のロック順序(PR-B・R47: terminal は Owner FOR UPDATE 先頭)", () => {
  it("手動反響 PATCH: 先読み→Owner FOR UPDATE→親行→更新→再導出", () => {
    const tx = firstTx(
      read("src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts"),
    );
    assertOrder("reaction PATCH", tx, [
      "tx.propertyDmLog.findFirst", // 先読み(ロックなし・所有者集合の把握)
      "lockOwnersForUpdate",
      "lockPropertyRecordForWrite",
      "tx.propertyDmLog.update",
      "syncSaleDmReaction",
    ]);
  });

  it("outcome route: ブリッジ行先読み→Owner FOR UPDATE→親行→draft行→更新→同期", () => {
    const tx = firstTx(
      read("src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts"),
    );
    assertOrder("outcome", tx, [
      "tx.propertyDmLog.findMany", // ブリッジ行の所有者集合の先読み
      "lockOwnersForUpdate",
      "lockPropertyRow",
      "FROM dm_recipient_drafts", // draft 行 FOR UPDATE(親→子)
      "tx.dmRecipientDraft.update",
      "syncSaleDmReaction",
    ]);
  });

  it("公開LP追跡: 親行ロック→draft更新→同期(allowTerminal:false=Ownerロック不要)", () => {
    const src = read("src/lib/sale-dm-letter/tracking-record.ts");
    // import 文を含めない: 関数本体だけで順序を検証する
    const body = src.slice(src.indexOf("export async function recordTrackingHit"));
    assertOrder("tracking", body, [
      "lockPropertyRow",
      "tx.dmRecipientDraft.update",
      "syncSaleDmReaction",
      "allowTerminal: false",
    ]);
    expect(body).not.toMatch(/lockOwnersForUpdate/);
  });

  it("同期ヘルパー: terminal は Owner FOR UPDATE→再読取→適用(変化なしはロックしない)", () => {
    const src = read("src/lib/dm-reaction/sync.ts");
    const body = src.slice(src.indexOf("export async function syncSaleDmReaction"));
    assertOrder("sync", body, [
      "changed.length === 0", // 変化なし=ロック・書込なし
      "lockOwnersForUpdate",
      "\n    logs = await readLogs()", // ロック後の再読取(if ブロック内の再代入)
      "tx.propertyDmLog.update",
    ]);
  });

  it("orphan PATCH: Owner FOR UPDATE 先頭(親行ロックは親が無いので無し)", () => {
    const src = read("src/app/api/admin/orphan-dm-logs/[logId]/route.ts");
    const tx = firstTx(src);
    assertOrder("orphan PATCH", tx, [
      "tx.propertyDmLog.findFirst",
      "lockOwnersForUpdate",
      "tx.propertyDmLog.update",
    ]);
    expect(src).not.toMatch(/lockPropertyRow|lockPropertyRecordForWrite/);
  });

  it("照合(reconcile): 行ごとの tx で Owner FOR UPDATE→物件親行→子行", () => {
    const src = read("src/lib/dm-reaction/reconcile.ts");
    const start = src.indexOf("export async function reconcileSaleDmReactions");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    assertOrder("reconcile", body, [
      "lockOwnersForUpdate",
      "lockPropertiesForUpdate",
      "syncSaleDmReaction",
    ]);
  });
});
