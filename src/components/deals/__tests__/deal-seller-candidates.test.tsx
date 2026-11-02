import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SellerCandidatesView } from "../deal-seller-candidates";
import { SELLER_MISMATCH_MESSAGE, sellerNameMismatch, type CrosscheckResult } from "@/lib/deals/crosscheck";

const candidates = [{ ownerId: "a", name: "試験 太郎" }, { ownerId: "b", name: "試験 花子" }];
const view = (over: Partial<Parameters<typeof SellerCandidatesView>[0]> = {}) =>
  renderToStaticMarkup(
    <SellerCandidatesView candidates={candidates} selected={[]} mismatch={false} busy={false} onToggle={() => {}} onAdd={() => {}} {...over} />,
  );

describe("売主にいない所有者の候補", () => {
  it("★人数と氏名を出す・選ぶ欄がある", () => {
    const html = view();
    expect(html).toContain("物件の所有者で、売主にいない人:2名");
    expect(html).toContain("試験 花子");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  });
  it("★1人も選ばなければ「売主に加える」を押せない", () => {
    expect(view()).toMatch(/<button[^>]* disabled=""/);
    expect(view({ selected: ["a"] })).not.toMatch(/<button[^>]* disabled=""/);
  });
  it("★照合で不一致のときだけ相続登記の確認を添える", () => {
    expect(view()).not.toContain("相続登記");
    expect(view({ mismatch: true })).toContain("相続登記などが必要か確認してください");
  });
  it("候補がいなければ何も出さない", () => {
    expect(view({ candidates: [] })).toBe("");
  });
});

describe("照合の不一致の判定", () => {
  const result = (status: string, message: string | null) =>
    ({ items: [{ key: "seller", label: "売主名", status, message, sources: [], legacyDocuments: 0 }] }) as unknown as CrosscheckResult;

  it("★登記名義人と売主の不一致だけ true(持分の不一致は別の話)", () => {
    expect(sellerNameMismatch(result("mismatch", SELLER_MISMATCH_MESSAGE))).toBe(true);
    expect(sellerNameMismatch(result("mismatch", "登記名義人の持分と当事者の持分が一致しません。持分を確認してください。"))).toBe(false);
    expect(sellerNameMismatch(result("match", null))).toBe(false);
    expect(sellerNameMismatch(null)).toBe(false);
  });
});

describe("当事者タブ", () => {
  const panel = readFileSync("src/components/deals/deal-parties-panel.tsx", "utf8").replace(/\r\n/g, "\n");
  const page = readFileSync("src/app/(dashboard)/deals/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");

  it("★全員を足すボタンは売主がいないときだけ", () => {
    expect(panel).toMatch(/!hasSellers && canOpenProperty && deal\.propertyId/);
  });
  it("★照合の結果を画面から渡す(もう一度謄本を読まない)", () => {
    expect(page).toMatch(/onResult=\{setCrosscheckResult\}/);
    expect(page).toMatch(/sellerMismatch=\{sellerNameMismatch\(crosscheckResult\)\}/);
  });
});
