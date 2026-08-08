/**
 * 物件削除とDM送付履歴の整合(PR-A・設計書§2.4 R49/R52)。
 *  - DELETE tx 内で「所有者の紐づけが全く無い行(ownerId=null かつ 連関0)」だけを行削除する
 *    (所有者付きの行は FK SET NULL で所有者側に残る=所有者横断の再送除外を守る)
 *  - 掃除は property.delete より前・attachment ゴミ箱入りは従来どおり
 *  - 削除確認ダイアログに「所有者に引き継がれる」注意書きがある
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const ROUTE = read("src/app/api/properties/[id]/route.ts");
const DETAIL_PAGE = read("src/app/(dashboard)/properties/[id]/page.tsx");
const LIST_PAGE = read("src/app/(dashboard)/properties/page.tsx");

describe("物件削除tx: 所有者ゼロのDM記録の掃除(R52)", () => {
  it("deleteMany の条件は ownerId=null かつ logOwners none(所有者付き行は消さない)", () => {
    expect(ROUTE).toMatch(
      /propertyDmLog\.deleteMany\(\{\s*where: \{ propertyId: id, ownerId: null, logOwners: \{ none: \{\} \} \},\s*\}\)/,
    );
  });

  it("親行ロック→掃除→property.delete の順(tx 内・attachment処理は従来どおり残る)", () => {
    const lockIdx = ROUTE.indexOf("lockPropertyRow(tx, id)");
    const purgeIdx = ROUTE.indexOf("propertyDmLog.deleteMany");
    const deleteIdx = ROUTE.indexOf("tx.property.delete", purgeIdx);
    const attachmentIdx = ROUTE.indexOf("tx.attachment.updateMany");
    expect(lockIdx).toBeGreaterThan(0); // 親→子の順序統一(#364 R9)
    expect(lockIdx).toBeLessThan(attachmentIdx);
    expect(purgeIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(purgeIdx);
    expect(attachmentIdx).toBeGreaterThan(0);
    expect(attachmentIdx).toBeLessThan(purgeIdx);
  });
});

describe("削除確認ダイアログの注意書き", () => {
  it("物件詳細・一覧(単体/一括)の確認文言に「所有者情報に引き継がれます」がある", () => {
    expect(DETAIL_PAGE).toContain("所有者に紐づくDMの反響・送付履歴は所有者情報に引き継がれます(紐づけの無い記録は削除されます)");
    const hits = LIST_PAGE.split("所有者に紐づくDMの反響・送付履歴は所有者情報に引き継がれます(紐づけの無い記録は削除されます)").length - 1;
    expect(hits).toBe(2); // 単体削除+一括削除
  });
});
