import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistryRightsCard, shouldShowRegistryRights } from "../registry-rights-card";
import type { RegistryRightsSummary } from "@/lib/registry-strike/analyze";

/** 架空データ */
const base: RegistryRightsSummary = {
  underlineDetected: true,
  hasKouku: true,
  hasOtsuku: true,
  currentOwners: [{ name: "乙川二郎", address: "東京都品川区架空五丁目5番2-305号", share: null }],
  activeRights: [
    {
      rank: "5",
      purpose: "抵当権設定",
      amount: "金４，５００万円",
      holder: "架空信用保証株式会社",
      debtor: "乙川二郎",
      activeAnnotations: 0,
    },
  ],
  cautions: [],
  cancelled: { kouku: 0, otsuku: 5 },
  titleHasStruck: false,
  notes: [],
};

describe("RegistryRightsCard", () => {
  it("今の所有者・残っている権利・抹消件数を描画する", () => {
    const html = renderToStaticMarkup(<RegistryRightsCard rights={base} />);
    expect(html).toContain("登記の現況");
    expect(html).toContain("下線（抹消事項）を読み取り済み");
    expect(html).toContain("乙川二郎");
    expect(html).toContain("単独");
    expect(html).toContain("5番");
    expect(html).toContain("金４，５００万円");
    expect(html).toContain("架空信用保証株式会社");
    expect(html).toContain("乙区 5件");
    expect(html).toContain("物件・所有者にはまだ反映しません");
  });

  it("注意の登記・注記・判定できなかった所有者を描画する", () => {
    const html = renderToStaticMarkup(
      <RegistryRightsCard
        rights={{
          ...base,
          underlineDetected: false,
          currentOwners: [],
          activeRights: [],
          cautions: [{ section: "甲区", rank: "2", purpose: "差押" }],
          notes: ["持分の合計が1になりません。所有者と持分は目視で確認してください。"],
        }}
      />,
    );
    expect(html).toContain("下線の情報なし");
    expect(html).toContain("判定できませんでした");
    expect(html).toContain("残っている権利はありません");
    expect(html).toContain("甲区 2番「差押」が残っています");
    expect(html).toContain("持分の合計が1になりません");
  });

  it("権利部の無い謄本（所有者事項など）・null では出さない", () => {
    expect(shouldShowRegistryRights(null)).toBe(false);
    expect(shouldShowRegistryRights(undefined)).toBe(false);
    expect(shouldShowRegistryRights({ ...base, hasKouku: false, hasOtsuku: false })).toBe(false);
    expect(shouldShowRegistryRights(base)).toBe(true);
  });
});

describe("registry-pdf 画面への組み込み", () => {
  const page = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/(dashboard)/import/registry-pdf/page.tsx"),
    "utf8",
  );

  it("解析結果の rights を表示し、やり直しで消す", () => {
    expect(page).toMatch(/setRights\(result\.rights \?\? null\)/);
    expect(page).toMatch(/setRights\(null\)/);
    expect(page).toMatch(/shouldShowRegistryRights\(rights\) && <RegistryRightsCard rights=\{rights\} \/>/);
  });

  it("rights は作業中の控え（下書き）に入れない", () => {
    const draft = page.slice(page.indexOf("useMemo<RegistryPdfDraft>"), page.indexOf("useDraftAutosave("));
    expect(draft).not.toMatch(/rights/);
  });
});
