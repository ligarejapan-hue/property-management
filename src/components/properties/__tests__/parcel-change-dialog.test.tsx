import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { parcelChangeDoneText } from "../parcel-change-dialog";

describe("分筆・合筆の小窓(2026-11-06 3回目の2つ目)", () => {
  it("記録できたときの文: 取引の選びを直したときは、書類の地番の入れ直しを案内する", () => {
    expect(parcelChangeDoneText("split", 0)).toBe("分筆を記録しました。元の地番はコメントに残しました。");
    expect(parcelChangeDoneText("merge", 2)).toContain("取引2件");
    expect(parcelChangeDoneText("merge", 2)).toContain("物件から取り直す");
  });
});

describe("配線(ソース)", () => {
  const dialog = readFileSync(path.join(__dirname, "..", "parcel-change-dialog.tsx"), "utf8");
  const page = readFileSync(path.join(__dirname, "..", "..", "..", "app", "(dashboard)", "properties", "[id]", "page.tsx"), "utf8");
  it("★合言葉を送る(編集中の鍵の確認を素通りさせない)・版を送る", () => {
    expect(dialog).toContain("...editLockHeaders()");
    expect(dialog).toMatch(/op, version, source, pieces/);
    expect(dialog).toMatch(/op, version, keys: mergeKeys/);
  });
  it("★「その他 ▾」に出すのは物件を書ける人・区分以外・土地がある物件だけ・編集中の人がいれば押せない", () => {
    expect(page).toContain("canWriteProperty && !supportsUnitFields(property.propertyType) && landChoices(");
    expect(page).toMatch(/key: "parcel-change",[\s\S]{0,120}disabled: propertyNoLockWritesBlocked/);
    // 鍵の状態はメニューより前で決める(後ろで決めると初めの描画で読めない)。
    expect(page.indexOf("const propertyNoLockWritesBlocked")).toBeLessThan(page.indexOf("const moreMenuItems"));
  });
});
