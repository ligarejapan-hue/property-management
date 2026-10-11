import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 物件名から棟へ(発注者の指示 2026-10-11)の配線(走査)。
 * ⚠物件詳細と確認の小窓は画面の状態に依存するため SSR で中身を出せない。ソースで固定する。
 * 判断(何を選んでおくか・物件名の出し方)は link-dialog-model.test.ts で確かめる。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
const dialog = read("../building-link-dialog.tsx");
const page = read("../../../app/(dashboard)/properties/[id]/page.tsx");

describe("確認の小窓(building-link-dialog)", () => {
  it("候補は入力欄と同じ問い合わせ(町丁目に丸めた area)で読む・住所そのものは送らない", () => {
    expect(dialog).toContain("/api/buildings/suggest?${suggestQueryStringForArea(buildingName, area)}");
    expect(dialog).toContain("const area = suggestArea(address);");
    expect(dialog).not.toMatch(/suggest\?[^`]*address/);
  });
  it("選び直していなければ、最初に選んでおくもの(initialLinkChoice)を使う", () => {
    expect(dialog).toContain(": picked ?? initialLinkChoice(suggestions, state);");
  });
  it("「新しい棟として作る」は一覧を全部確かめられたときだけ出す", () => {
    expect(dialog).toContain("const allowNew = allowsNewBuilding(state);");
    expect(dialog).toMatch(/\{allowNew && \(/);
  });
  it("何も選べていない・保存中は確定できない。確定は onConfirm に選んだものを渡すだけ", () => {
    expect(dialog).toMatch(/disabled=\{saving \|\| choice === null\}/);
    expect(dialog).toMatch(/onClick=\{\(\) => choice && onConfirm\(choice\)\}/);
  });
  it("物件名が短くて候補を探せないときは問い合わせず、自動の判断(auto)で送る(@codex P2)", () => {
    expect(dialog).toContain("const searchable = linkNeedsSuggestions(buildingName);");
    expect(dialog).toMatch(/useEffect\(\(\) => \{\s*if \(!searchable\) return;/);
    expect(dialog).toMatch(/const choice: BuildingChoice \| null = !searchable\s*\? \{ kind: "auto" \}/);
  });
  it("保存中は Escape で閉じない", () => {
    expect(dialog).toContain("onClose={saving ? undefined : onClose}");
  });
});

describe("物件詳細の基本情報(page.tsx)", () => {
  it("物件名の出し方は buildingNameLinkMode で決め、ほかの人が編集中なら押せない", () => {
    expect(page).toMatch(/const nameMode = buildingNameLinkMode\(\{[\s\S]*?lockedByOther: editLockHeld,[\s\S]*?\}\);/);
  });
  it("つながっていれば物件名が棟の画面へのリンク", () => {
    expect(page).toMatch(/nameMode === "link" && property\.building \? \(\s*<Link\s+href=\{`\/buildings\/\$\{property\.building\.id\}`\}/);
  });
  it("つながっていなければ物件名を押すと確認を開く(押しただけでは保存しない)", () => {
    expect(page).toMatch(/data-testid="building-name-connect"\s+onClick=\{\(\) => \{\s*setLinkError\(null\);\s*setLinkOpen\(true\);\s*\}\}/);
  });
  it("確定したら棟の選び方だけを保存し、つないだ棟の画面へ移る", () => {
    expect(page).toContain("const buildingId = await runBuildingLinkPatch(property.id, property.version, choice);");
    expect(page).toMatch(/router\.push\(`\/buildings\/\$\{buildingId\}`\)/);
    expect(page).toContain("await patchPropertyNoLock(propertyId, version, { buildingChoice: choice })");
  });
  it("失敗の理由は小窓に残し、閉じたときに読み直す(すぐ読み直すと小窓ごと消える・@codex P2)", () => {
    expect(page).not.toMatch(/setLinkError\(err instanceof Error[^;]*;\s*(\/\/[^\n]*\n\s*)*onRefresh\(\);/);
    expect(page).toMatch(/onClose=\{\(\) => \{\s*setLinkOpen\(false\);[\s\S]*?if \(linkError\) onRefresh\(\);\s*\}\}/);
  });
  it("所属マンションの行は物件名が空の旧データのときだけ(物件名があれば物件名がリンク)", () => {
    expect(page).toContain("{isUnit && property.building && !property.buildingName && (");
  });
});
