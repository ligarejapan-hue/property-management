/**
 * 物件から取引を作る入口(発注者指示 2026-10-25)。
 * - 物件の基本情報: 契約予定のときだけ「この物件で取引を作成」(取引を書ける人だけ)。
 * - 新しい取引: 物件を「一覧から選ぶ / 手で入力する」から選べる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("物件の基本情報 → 取引の作成", () => {
  const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
  it("BasicTab に canCreateDeal を渡す", () => {
    expect(src).toMatch(/<BasicTab[\s\S]*?canCreateDeal=\{canCreateDeal\}[\s\S]*?\/>/);
  });
  it("契約予定かつ取引を書けるときだけ出す", () => {
    const i = src.lastIndexOf("この物件で取引を作成");
    expect(i).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, i - 800), i);
    expect(before).toMatch(/canCreateDeal && property\.caseStatus === "contract_planned"/);
    // 道は newDealHref(物件の取扱区分も渡す・2026-11-04)。中身は property-business-type.test.ts。
    expect(before).toContain("newDealHref(property.id, property.businessType)");
  });
});

describe("新しい取引 → 物件を一覧から選ぶ", () => {
  const src = read("src/app/(dashboard)/deals/new/page.tsx");
  it("一覧から選ぶ / 手で入力する を選べる", () => {
    expect(src).toContain("物件の一覧から選ぶ");
    expect(src).toContain("手で入力する");
  });
  it("URL の propertyId は最初の選択として残す", () => {
    expect(src).toContain('get("propertyId")');
  });
  it("手で入力するときは propertyId を送らない", () => {
    expect(src).toMatch(/const propertyId = source === "list" \? picked\?\.id \?\? null : null;/);
  });
  it("一覧から選ぶのに未選択なら作成できない", () => {
    expect(src).toMatch(/disabled=\{saving \|\| \(source === "list" && !picked\)\}/);
  });
  it("空のときは契約予定の物件を出す(物件検索の caseStatus)", () => {
    expect(src).toMatch(/caseStatus: "contract_planned"/);
    expect(src).toContain("searchProperties(");
  });
});
