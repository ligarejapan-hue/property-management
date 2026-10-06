import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 棟の自動づけ Task 12: 編集の画面と物件詳細の配線(走査)。
 * ⚠PropertyEditForm は初回描画で values が空=物件名の欄が出ない(isFieldVisible が
 *   values.propertyType を見る)。SSR では欄そのものを確かめられないため、ソースで固定する。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
const form = read("../property-edit-form.tsx");
const page = read("../../../app/(dashboard)/properties/[id]/page.tsx");

describe("編集の画面(property-edit-form)", () => {
  it("★区分マンションの物件名の欄だけ候補つきにする", () => {
    expect(form).toMatch(
      /field\.key === "buildingName" &&\s*\(values\.propertyType \?\? property\.propertyType\) === "apartment_unit" \? \(\s*(\/\/[^\n]*\n\s*)?<BuildingNameCombobox/,
    );
    expect(form).toMatch(/onChange=\{\(v\) => handleChange\("buildingName", v\)\}/);
    expect(form).toMatch(/address=\{values\.address \?\? property\.address\}/);
  });

  it("★付け替えの確認は、検証のあと・保存を始める前に出し、キャンセルなら保存しない", () => {
    const confirmAt = form.indexOf("relinkConfirmMessage(property.building ?? null, values.buildingName ?? \"\", buildingChoice)");
    const tooLongAt = form.indexOf("const tooLong = allFields.find(");
    const savingAt = form.indexOf("setSaving(true);");
    expect(confirmAt).toBeGreaterThan(tooLongAt);
    expect(savingAt).toBeGreaterThan(confirmAt);
    expect(form).toMatch(/if \(msg && !window\.confirm\(msg\)\) return;/);
    // 名前を変えた/選び直したときだけ確かめる
    expect(form).toMatch(/nameChanged \|\| buildingChoice\.kind !== "auto"/);
  });

  it("★auto のときは buildingChoice を送らない(今の棟を保つサーバーの守りを外さない)", () => {
    expect(form).toMatch(/if \(isUnit && buildingChoice\.kind !== "auto"\) payload\.buildingChoice = buildingChoice;/);
    // 送る箇所は条件つきの1か所だけ
    expect(form.split("payload.buildingChoice =").length - 1).toBe(1);
  });

  it("★保存できたら応答の buildingLink を onSaved へ渡す", () => {
    expect(form).toMatch(/onSaved\(\{ buildingLink: saved\?\.buildingLink \?\? null \}\)/);
    expect(form).toMatch(/onSaved: \(result\?: \{ buildingLink\?: BuildingLinkOutcome \| null \}\) => void;/);
  });

  it("★apply.ts(prisma を読む)は型だけ読む", () => {
    expect(form).toMatch(/import type \{ BuildingLinkOutcome \} from "@\/lib\/building-link\/apply";/);
    expect(form).not.toMatch(/import \{[^}]*\} from "@\/lib\/building-link\/apply"/);
  });
});

describe("物件詳細(properties/[id]/page.tsx)", () => {
  it("★預かった知らせは読み込みの非同期の続きで取り出す(effect 本体・useState 初期化では取らない)", () => {
    const fetchAt = page.indexOf("const fetchProperty = useCallback(async () => {");
    const awaitAt = page.indexOf("await fetchPropertyDetail(id);", fetchAt);
    const takeAt = page.indexOf("takeBuildingLinkNotice(id)", fetchAt);
    const fetchEnd = page.indexOf("}, [id, loadQualityIssues]);", fetchAt);
    expect(awaitAt).toBeGreaterThan(fetchAt);
    expect(takeAt).toBeGreaterThan(awaitAt);
    expect(takeAt).toBeLessThan(fetchEnd);
    // 取り出しはこの1か所だけ
    expect(page.split("takeBuildingLinkNotice(").length - 1).toBe(1);
    expect(page).not.toMatch(/useState<BuildingLinkOutcome \| null>\(\s*\(\)/);
  });

  it("★無いときに null で上書きしない(保存後の知らせを取り直しで消さない)", () => {
    expect(page).toMatch(/const stashed = takeBuildingLinkNotice\(id\);\n\s*if \(stashed\) setBuildingNotice\(stashed\);/);
  });

  it("★読み込み結果を画面に使ったときだけ取り出す(遅れて届いた前の物件の結果では取らない)", () => {
    expect(page).toMatch(
      /const applied = applyRefreshOutcome\([\s\S]*?\);[\s\S]*?if \(applied\) \{\s*const stashed = takeBuildingLinkNotice\(id\);/,
    );
    // 取り出しは applied の中だけ(条件の外に残っていない)
    const fetchAt = page.indexOf("const fetchProperty = useCallback(async () => {");
    const appliedAt = page.indexOf("if (applied) {", fetchAt);
    const takeAt = page.indexOf("takeBuildingLinkNotice(id)", fetchAt);
    expect(appliedAt).toBeGreaterThan(fetchAt);
    expect(takeAt).toBeGreaterThan(appliedAt);
  });

  it("★編集の保存後は onSaved の buildingLink を出す", () => {
    expect(page).toMatch(/onSaved=\{\(r\) => \{\s*setShowEditForm\(false\);\s*setBuildingNotice\(r\?\.buildingLink \?\? null\);/);
  });

  it("★知らせはタブの上に出す", () => {
    const noticeAt = page.indexOf("<BuildingLinkNotice outcome={buildingNotice} onClose={() => setBuildingNotice(null)} />");
    const tabsAt = page.indexOf("{/* Tabs */}");
    expect(noticeAt).toBeGreaterThan(0);
    expect(tabsAt).toBeGreaterThan(noticeAt);
  });
});
