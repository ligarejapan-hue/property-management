/**
 * 物件詳細 API が所有者の「現住所」を返すことを固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §8
 *
 * ⚠なぜテストするのか:
 * この API は所有者の項目を **明示的に列挙して** 取得している。新しい列を足し忘れると、
 * 型は optional なので **コンパイルは通る** が、値が常に undefined になる。すると
 * 所有者カードの編集フォームが **空で初期化され、そのまま保存して登録済みの現住所を消す**。
 *
 * ⚠ **GET と PATCH の両方**で必要。PATCH の応答でもフォームを組み直すため、
 * 片方だけ直すと「保存した直後に現住所が消えたように見える」状態になる。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTE = path.join(
  process.cwd(),
  "src/app/api/properties/[id]/route.ts",
);

describe("物件詳細 API — 所有者の現住所を返す", () => {
  const src = fs.readFileSync(ROUTE, "utf-8");

  it("⚠所有者の select が currentZip / currentAddress を含む", () => {
    expect(src).toContain("currentZip: true");
    expect(src).toContain("currentAddress: true");
  });

  it("⚠GET と PATCH の**両方**に入っている（片方だけの直しを検出する）", () => {
    // この route の所有者 select は GET 用と PATCH 用の2箇所にある。
    // 片方だけ直すと「保存した直後に現住所が消えたように見える」。
    const zipCount = (src.match(/currentZip: true/g) ?? []).length;
    const addrCount = (src.match(/currentAddress: true/g) ?? []).length;
    expect(zipCount).toBe(2);
    expect(addrCount).toBe(2);
  });

  it("既存の項目を落としていない", () => {
    expect(src).toContain("zip: true");
    expect(src).toContain("address: true");
    expect(src).toContain("companyRegistryNumber: true");
  });
});
