import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SalesSheetCreateDialog, writebackGate } from "../SalesSheetCreateButton";

// Node environment（jsdom 非導入）: SSR 静的構造のみ検証する。renderToStaticMarkup は effect を
// 実行しないため fetchPropertyDetail は呼ばれない＝物件/棟情報は `property` prop（呼び出し側が
// 既に取得済みの値）を直接渡して検証する（他の *-dialog.test.tsx と同じ方針）。
//
// [F3 Task5 R13]: 「同じ棟の N部屋にも反映されます」の注意を出す条件は basementFloors と
// builtYearMonth の2キーのみ（brief 記載の BUILDING_KEYS には structure/totalFloors/totalUnits も
// 含まれるが、区分マンションのこの3項目は棟の値が正で図面からは書き換えられない＝保存されない
// 既存設計のため、ここで注意を出すと嘘になる。コントローラ判断により2キーへ絞った）。
//
// [F3 Task5 R17]: property.buildingUnitCount(=_count.properties) は編集中の物件自身を含む棟内の
// 総数。文言は「にも反映されます」＝自分を除いた数で言うべきのため、表示は buildingUnitCount-1。
// ここでは buildingUnitCount:5 の棟 → 表示は「他の 4部屋」で固定する。
const base = {
  propertyId: "p1",
  kind: "mansion" as const,
  onClose: () => {},
  property: {
    version: 3,
    buildingName: "○○マンション",
    buildingUnitCount: 5,
    buildingVersion: 2,
    buildingId: "b1",
  },
};

describe("作成ダイアログ — 物件にも保存する", () => {
  it("チェックは既定でON", () => {
    const html = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(html).toContain("入れた値を物件にも保存する");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("区分で棟の項目（築年月）を変えたときだけ、棟に反映される旨を出す(R17: 自分を除いた数)", () => {
    const changed = renderToStaticMarkup(
      <SalesSheetCreateDialog {...base} initialValues={{ builtYearMonth: "1998年5月" }} />,
    );
    expect(changed).toContain("同じ棟の他の 4部屋");
    expect(changed).not.toContain("同じ棟の 5部屋");
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

// [@codex P2] version が手に入っていない状態で「保存する」と言ったまま送ると、サーバは
// version 欠落を安全側で conflict と見なして書き戻しを丸ごと捨てる＝画面の表示が嘘になる。
// 取得状況(metaStatus)ごとの振る舞いを純関数で総当たりに固定する。
describe("writebackGate — 物件情報の取得状況ごとの扱い", () => {
  const FAILED_NOTICE = "物件の情報を読み込めませんでした。この図面の値は物件には保存されません。";

  it("取得済み(ready)なら何も妨げない", () => {
    expect(writebackGate(true, "ready")).toEqual({
      submitBlocked: false,
      effectiveSaveToProperty: true,
      checkboxDisabled: false,
      notice: null,
    });
    expect(writebackGate(false, "ready")).toEqual({
      submitBlocked: false,
      effectiveSaveToProperty: false,
      checkboxDisabled: false,
      notice: null,
    });
  });

  it("取得中(loading)にチェックが入っていれば作成を待たせる", () => {
    expect(writebackGate(true, "loading")).toEqual({
      submitBlocked: true,
      effectiveSaveToProperty: true,
      checkboxDisabled: false,
      notice: "物件の情報を読み込んでいます…",
    });
  });

  it("取得中でもチェックを外していれば待たせない(version を要らない)", () => {
    expect(writebackGate(false, "loading")).toEqual({
      submitBlocked: false,
      effectiveSaveToProperty: false,
      checkboxDisabled: false,
      notice: null,
    });
  });

  it("取得失敗(failed)なら保存せず、理由を出し、チェックも触らせない", () => {
    expect(writebackGate(true, "failed")).toEqual({
      submitBlocked: false,
      effectiveSaveToProperty: false,
      checkboxDisabled: true,
      notice: FAILED_NOTICE,
    });
    expect(writebackGate(false, "failed")).toEqual({
      submitBlocked: false,
      effectiveSaveToProperty: false,
      checkboxDisabled: true,
      notice: FAILED_NOTICE,
    });
  });

  it("作成を止めるのは「チェックON かつ 取得中」だけ(総当たり)", () => {
    const statuses = ["ready", "loading", "failed"] as const;
    const blocked: string[] = [];
    for (const checked of [true, false]) {
      for (const s of statuses) {
        if (writebackGate(checked, s).submitBlocked) blocked.push(`${checked}/${s}`);
      }
    }
    expect(blocked).toEqual(["true/loading"]);
  });
});

describe("作成ダイアログ — 物件情報が未取得のとき(SSR)", () => {
  // property prop を渡さない呼び出し元(/sales-sheets/new のピッカー)は、開いた直後は
  // version を持っていない。effect は SSR で走らないため、この render は「取得中」そのもの。
  const picker = { propertyId: "p1", kind: "mansion" as const, onClose: () => {} };

  it("取得が終わるまで作成ボタンを押させない", () => {
    const html = renderToStaticMarkup(<SalesSheetCreateDialog {...picker} />);
    expect(html).toContain("物件の情報を読み込み中…");
    expect(html).toContain("物件の情報を読み込んでいます…");
    expect(html).not.toContain("作成してエディタを開く");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>物件の情報を読み込み中…<\/button>/);
  });

  it("property prop が渡っていれば待たせない", () => {
    const html = renderToStaticMarkup(<SalesSheetCreateDialog {...base} />);
    expect(html).toContain("作成してエディタを開く");
    expect(html).not.toContain("物件の情報を読み込んでいます…");
  });
});
