/**
 * 所有者の名寄せ(統合)における DM 参照の付け替え(PR-A・設計書§4-5b)。
 * 統合 tx が PropertyDmLog.ownerId / バッチitem.ownerId / draft.representativeOwnerId /
 * 連関3表の owner_id を source→master へ移す(重複行は先に畳む)ことをソース表明で固定する。
 * 実挙動(counts・審査)は owner-merge-execute-route.test.ts の tx mock 経由で担保済み。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const SRC = read("src/app/api/admin/owners/correction/merge/route.ts");

describe("名寄せtxのDM参照付け替え(@codex R11/R12/R32)", () => {
  it("直接参照3つ(ログ/バッチitem/draft代表)を master へ updateMany する", () => {
    expect(SRC).toMatch(
      /propertyDmLog\.updateMany\(\{\s*where: \{ ownerId: sourceFresh\.id \},\s*data: \{ ownerId: masterFresh\.id \}/,
    );
    expect(SRC).toMatch(
      /dmExportBatchItem\.updateMany\(\{\s*where: \{ ownerId: sourceFresh\.id \}/,
    );
    expect(SRC).toMatch(
      /dmRecipientDraft\.updateMany\(\{\s*where: \{ representativeOwnerId: sourceFresh\.id \}/,
    );
  });

  it("連関3表は master 側と重複する source 行を先に消してから移す(複合PK衝突回避)", () => {
    for (const t of [
      "dm_export_batch_item_owners",
      "property_dm_log_owners",
      "dm_recipient_draft_owners",
    ]) {
      expect(SRC).toMatch(new RegExp(`DELETE FROM ${t} s`));
    }
    // DELETE(畳み)が updateMany(移動)より前
    const delIdx = SRC.indexOf("DELETE FROM dm_export_batch_item_owners");
    const moveIdx = SRC.indexOf("dmExportBatchItemOwner.updateMany");
    expect(delIdx).toBeGreaterThan(0);
    expect(delIdx).toBeLessThan(moveIdx);
  });

  it("付け替えは source archive(8.)より前に行う", () => {
    const repointIdx = SRC.indexOf("7b. DM送付管理");
    const archiveIdx = SRC.indexOf("// 8. source を archive");
    expect(repointIdx).toBeGreaterThan(0);
    expect(repointIdx).toBeLessThan(archiveIdx);
  });

  it("監査 detail の付け替え件数キーが sanitize で残る", () => {
    const out = sanitizeAuditDetail("owner_correction_merge", {
      dmLogsMoved: 2,
      dmBatchItemsMoved: 1,
      dmDraftsMoved: 0,
      dmAssociationsMoved: 3,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      dmLogsMoved: 2,
      dmBatchItemsMoved: 1,
      dmDraftsMoved: 0,
      dmAssociationsMoved: 3,
    });
  });
});
