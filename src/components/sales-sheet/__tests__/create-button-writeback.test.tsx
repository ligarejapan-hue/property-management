import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SalesSheetCreateDialog } from "../SalesSheetCreateButton";

// Node environment（jsdom 非導入）: SSR 静的構造のみ検証する。renderToStaticMarkup は effect を
// 実行しないため fetchPropertyDetail は呼ばれない＝物件/棟情報は `property` prop（呼び出し側が
// 既に取得済みの値）を直接渡して検証する（他の *-dialog.test.tsx と同じ方針）。
//
// [F3 Task5 R13]: 「同じ棟の N部屋にも反映されます」の注意を出す条件は basementFloors と
// builtYearMonth の2キーのみ（brief 記載の BUILDING_KEYS には structure/totalFloors/totalUnits も
// 含まれるが、区分マンションのこの3項目は棟の値が正で図面からは書き換えられない＝保存されない
// 既存設計のため、ここで注意を出すと嘘になる。コントローラ判断により2キーへ絞った）。
const base = {
  propertyId: "p1",
  kind: "mansion" as const,
  onClose: () => {},
  property: { version: 3, buildingName: "○○マンション", buildingUnitCount: 5, buildingVersion: 2 },
};

describe("作成ダイアログ — 物件にも保存する", () => {
  it("チェックは既定でON", () => {
    const html = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(html).toContain("入れた値を物件にも保存する");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("区分で棟の項目（築年月）を変えたときだけ、棟に反映される旨を出す", () => {
    const changed = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} initialValues={{ builtYearMonth: "1998年5月" }} />,
    );
    expect(changed).toContain("同じ棟の 5部屋");
    const untouched = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(untouched).not.toContain("同じ棟の");
  });

  it("区分マンションの棟が正の項目（構造）を変えても棟への反映は出さない(R13: 保存されないため)", () => {
    const html = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} initialValues={{ structure: "RC" }} />,
    );
    expect(html).not.toContain("同じ棟の");
  });

  it("土地では棟の注意を出さない", () => {
    const html = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} kind="land" initialValues={{ price: "3480" }} />,
    );
    expect(html).not.toContain("同じ棟の");
  });
});
