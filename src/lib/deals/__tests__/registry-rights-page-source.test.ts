import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/(dashboard)/deals/[id]/page.tsx";
const COMP = "src/components/deals/deal-registry-rights.tsx";

describe("取引の画面の登記の現況(段5c-2)", () => {
  it("タブの上に出し、物件を差し替えたら読み直す", () => {
    const src = read(PAGE);
    expect(src).toContain('<DealRegistryRights key={deal.propertyId ?? "none"} dealId={deal.id} propertyId={deal.propertyId} />');
    expect(src.indexOf("<DealRegistryRights")).toBeLessThan(src.indexOf("<Tabs "));
  });
  it("物件が無い・全部事項が無いときは何も出さない・判定できないときは「謄本を確認してください」", () => {
    const src = read(COMP);
    expect(src).toContain("if (!propertyId) return null;");
    expect(src).toContain('if (!rights || rights.status === "none") return null;');
    expect(src).toContain("謄本を確認してください");
  });
  it("残っている権利は件数・順位・目的・債権額・権利者、注意と注記も出す", () => {
    const src = read(COMP);
    for (const s of ["抵当権などが残っています({rights.activeRights.length}件", "{r.rank}番", "{r.purpose}", '{r.amount ?? "—"}', "rights.cautions.map", "rights.notes.map", "抵当権などは残っていません"]) {
      expect(src).toContain(s);
    }
  });
});
