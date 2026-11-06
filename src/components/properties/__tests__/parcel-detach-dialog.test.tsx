import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import ParcelDetachDialog, { parcelDetachDoneText } from "../parcel-detach-dialog";

describe("土地・建物を別の物件にする小窓(2026-11-06 3回目の3つ目)", () => {
  it("できたときの文: 所有者のつながりを写せなかったときはそう書く", () => {
    expect(parcelDetachDoneText(2, false)).toContain("所有者2人のつながりも写しました");
    expect(parcelDetachDoneText(0, true)).toContain("所有者のつながりは写していません");
    expect(parcelDetachDoneText(0, false, 1)).toContain("取引1件");
    expect(parcelDetachDoneText(0, false, 0)).not.toContain("取引");
  });
  it("★編集中の人がいれば押せない(理由を出す)", () => {
    const html = renderToStaticMarkup(
      <ParcelDetachDialog propertyId="p" version={1} extraParcels={[{ id: "a", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: null }]} blocked onClose={() => {}} onDone={() => {}} />,
    );
    expect(html).toContain("ほかの人がこの物件を編集中です");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?別の物件にする<\/button>/);
  });
});

describe("配線(ソース)", () => {
  const dialog = readFileSync(path.join(__dirname, "..", "parcel-detach-dialog.tsx"), "utf8");
  const page = readFileSync(path.join(__dirname, "..", "..", "..", "app", "(dashboard)", "properties", "[id]", "page.tsx"), "utf8");
  it("★合言葉と版を送る・画面の鍵の状態を渡す・区分以外で足した行がある物件だけ", () => {
    expect(dialog).toContain("...editLockHeaders()");
    expect(dialog).toContain("JSON.stringify({ version, rowId })");
    expect(page).toContain("blocked={propertyNoLockWritesBlocked}");
    expect(page).toContain("canWriteProperty && !supportsUnitFields(property.propertyType) && readExtraParcels(property.extraParcels).length > 0");
  });
});
