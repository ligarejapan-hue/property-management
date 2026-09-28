/**
 * 取り込み経路でも電話番号を画面と同じ規則でそろえる(発注者決定 2026-09-28)。
 * 以前は画面で入れたとき(所有者の編集・紐付けの新規作成・申込フォーム)だけハイフンが入り、
 * 所有者CSV取込・取込のやり直し・貼り付けて物件化はハイフンなしのまま保存していた。
 * 重複の判定も、保存済みの書き方の違い(ハイフンあり・なし)に左右されないようにする。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildOwnerCreateData } from "../import-row-field-map";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("取込のやり直し(buildOwnerCreateData)", () => {
  it("数字だけの電話番号はハイフン付きで保存する", () => {
    expect(buildOwnerCreateData({ 氏名: "山田太郎", 電話番号: "09012345678" }).phone).toBe("090-1234-5678");
  });
  it("手で区切った番号は区切り位置を変えない", () => {
    expect(buildOwnerCreateData({ 氏名: "山田太郎", 電話番号: "0422-12-3456" }).phone).toBe("0422-12-3456");
  });
  it("電話番号が無ければ phone を書かない", () => {
    expect("phone" in buildOwnerCreateData({ 氏名: "山田太郎" })).toBe(false);
  });
});

describe("配線: 取り込み経路は phoneForStore で保存する", () => {
  it("所有者CSV取込", () => {
    const src = read("src/app/api/import/owner-csv/route.ts");
    expect(src).toContain("createData.phone = phoneForStore(mapped.phone)");
    expect(src).not.toContain("createData.phone = mapped.phone.trim()");
  });
  it("取込のやり直し(共通の組み立て)", () => {
    const src = read("src/lib/import-row-field-map.ts");
    expect(src).toContain("createData.phone = phoneForStore(mapped.phone)");
    expect(src).not.toContain("createData.phone = mapped.phone.trim()");
  });
  it("貼り付けて物件化", () => {
    const src = read("src/app/api/import/paste/commit/route.ts");
    expect(src).toContain("phone: phoneForStore(body.owner.phone)");
    expect(src).not.toContain("phone: body.owner.phone?.trim() || null");
  });
});

describe("配線: 重複の判定は書き方の違いに左右されない", () => {
  it("所有者CSV取込の重複判定", () => {
    const src = read("src/app/api/import/owner-csv/route.ts");
    expect(src).toContain("existing = await findOwnerByNameAndPhone(mapped.name, mapped.phone);");
    expect(src).not.toMatch(/where: \{ name: mapped\.name, phone:/);
  });
  it("取込のやり直しの重複判定(findDuplicateOwner)", () => {
    const src = read("src/lib/owner-dedup.ts");
    expect(src).toContain("const hit = await findOwnerByNameAndPhone(name, phone);");
    // 保存済みの側も数字だけにして比べる(書き方を並べて照らさない)。
    expect(src).toContain("candidates.find((c) => samePhoneNumber(c.phone, phone))");
  });
});
