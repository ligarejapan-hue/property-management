import { describe, expect, it } from "vitest";
import { buildApprovedDuplicateGuard } from "@/lib/registry-fetch/duplicate-guard";

/**
 * 「承認したときに警告が無かったもの」を、課金を直列化するロックと**同じ一文**で検査する条件。
 *
 * ⚠なぜ要るか(@codex #399 R5 P2): 画面で取り直した警告は**別の問い合わせ**なので、
 *   相手の処理がまだ確定していない一瞬に読むと「警告なし」と返り、その直後に確定されると
 *   **既にある謄本をもう一度買ってしまう**。ロックを取る一文に条件を混ぜれば、
 *   相手が物件行を押さえている間はこちらが待たされ、確定後に再評価されて弾ける。
 * ⚠**承認した項目だけ**を条件にする。警告を見たうえで意図して買い直す運用は従来どおり許す。
 */
describe("buildApprovedDuplicateGuard", () => {
  it("承認が無ければ何も足さない(従来の挙動)", () => {
    expect(buildApprovedDuplicateGuard(undefined)).toEqual({});
    expect(buildApprovedDuplicateGuard(null)).toEqual({});
  });

  it("『取得済みではなかった』で承認したなら、取得済みになっていたら弾く", () => {
    const g = buildApprovedDuplicateGuard({
      registryObtained: false,
      hasRegistryAttachment: true,
      hasOwners: true,
    });
    expect(g.registryStatus).toEqual({ notIn: ["scheduled", "obtained"] });
    // 承認済み(true)の項目は条件にしない=意図した買い直しを止めない。
    expect(g.attachments).toBeUndefined();
    expect(g.propertyOwners).toBeUndefined();
  });

  it("『添付が無かった』で承認したなら、謄本PDFが付いていたら弾く", () => {
    const g = buildApprovedDuplicateGuard({
      registryObtained: true,
      hasRegistryAttachment: false,
      hasOwners: true,
    });
    expect(g.attachments).toEqual({
      none: { targetType: "property", type: "registry", isDeleted: false },
    });
    expect(g.registryStatus).toBeUndefined();
  });

  it("『所有者が居なかった』で承認したなら、所有者が入っていたら弾く", () => {
    const g = buildApprovedDuplicateGuard({
      registryObtained: true,
      hasRegistryAttachment: true,
      hasOwners: false,
    });
    expect(g.propertyOwners).toEqual({ none: {} });
  });

  it("すべて警告なしで承認したなら、3つとも条件にする", () => {
    const g = buildApprovedDuplicateGuard({
      registryObtained: false,
      hasRegistryAttachment: false,
      hasOwners: false,
    });
    expect(Object.keys(g).sort()).toEqual([
      "attachments",
      "propertyOwners",
      "registryStatus",
    ]);
  });

  it("⚠取得済みの条件は『予約中』も外さない(既存の二重実行ガードを弱めない)", () => {
    const g = buildApprovedDuplicateGuard({
      registryObtained: false,
      hasRegistryAttachment: false,
      hasOwners: false,
    });
    expect(g.registryStatus?.notIn).toContain("scheduled");
  });
});
