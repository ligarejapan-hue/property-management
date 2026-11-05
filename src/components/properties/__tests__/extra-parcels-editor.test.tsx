import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtraParcelsEditor, parcelRowsOf, parcelRowsValue, rowsAreaTotal, type ParcelRow } from "../extra-parcels-editor";
import { extraParcelsEditValue } from "@/lib/property-parcels";
import { editFieldValue } from "@/lib/drafts/screens/property-edit";
import { buildSnapshotFromProperty } from "@/lib/deals/snapshot";
import { propertySideRows } from "@/lib/deals/property-side";

const row = (o: Partial<ParcelRow> = {}): ParcelRow => ({ id: "r1", kind: "land", location: "", number: "1番2", realEstateNumber: "", area: "61.95", ...o });
const render = (rows: ParcelRow[]) => renderToStaticMarkup(<ExtraParcelsEditor value={parcelRowsValue(rows)} onChange={() => {}} />);
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("編集画面のほかの土地・建物(2026-11-05 案A 1回目)", () => {
  it("足していない物件はリンクだけ(表は出さない)", () => {
    const html = render([]);
    expect(html).toContain("土地・建物を足す");
    expect(html).not.toContain("<table");
  });
  it("行があれば表と行を足すリンク・足した行の面積の合計(物件全体の面積の欄は人が入れる)", () => {
    const html = render([row(), row({ id: "r2", number: "1番3", area: "10" })]);
    expect(html).toContain("<table");
    expect(html).toContain('aria-label="2件目の地番・家屋番号"');
    expect(html).toContain("行を足す");
    expect(html).toContain("ここで足した土地の面積の合計 71.95㎡");
    expect(html).toContain("1筆目と合わせた物件全体の面積");
    expect(render([row()])).not.toContain("建物の面積の合計");
  });
  it("合計は足した行の面積が全部読めるときだけ", () => {
    expect(rowsAreaTotal([row({ area: "" })], "land")).toBeNull();
    expect(rowsAreaTotal([row({ kind: "building", area: "5.5" }), row({ id: "x", kind: "building", area: "0.25" })], "building")).toBe(5.75);
    expect(rowsAreaTotal([row()], "building")).toBeNull();
  });
  it("保存した値 → 欄の文字 → 行は同じ形(開いただけで変えた扱いにしない)", () => {
    const saved = [{ id: "r1", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: 61.95 }];
    expect(editFieldValue("extraParcels", saved)).toBe(parcelRowsValue([row()]));
    expect(parcelRowsOf(extraParcelsEditValue(saved))).toEqual([row()]);
    expect(editFieldValue("extraParcels", [])).toBe("");
    expect(parcelRowsOf("壊れた")).toEqual([]);
  });
  it("編集の小窓のつなぎ(区分マンションには出さない・空の地番の行は保存しない)", () => {
    const src = read("src/components/properties/property-edit-form.tsx");
    expect(src).toContain('{ key: "extraParcels", label: "ほかの土地・建物", type: "parcels", section: "基本" }');
    expect(src).toContain('if (field.type === "parcels") return !isMansionUnit(values.propertyType);');
    expect(src).toContain("payload[f.key] = parcelRowsOf(raw);");
    expect(src).toContain("ほかの土地・建物の地番・家屋番号を入れてください");
  });
});

describe("取引の写し・横の物件情報", () => {
  const p = {
    propertyType: "house", address: "架空市1-1", lotNumber: "1番1", buildingNumber: "1番1", buildingName: null, roomNo: null,
    exclusiveArea: null, totalFloorArea: "95.6", landArea: "182.45", structureType: null, builtYear: null, builtMonth: null, access: null, layoutType: null,
    extraParcels: [{ id: "a", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: 61.95 }, { id: "b", kind: "building", location: null, number: "1番1の2", realEstateNumber: null, area: null }],
  };
  it("写しの地番・家屋番号は「、」でつなぐ(媒介契約書・依頼文にそのまま出る)", () => {
    const s = buildSnapshotFromProperty(p);
    expect(s.lotNumber).toBe("1番1、1番2");
    expect(s.buildingNumber).toBe("1番1、1番1の2");
  });
  it("並べると欄の長さを超えるときは「ほか◯筆」(空にしない)", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, kind: "land", location: null, number: `${100 + i}番${"1".repeat(10)}`, realEstateNumber: null, area: null }));
    expect(buildSnapshotFromProperty({ ...p, extraParcels: many }).lotNumber).toBe("1番1 ほか30筆");
  });
  it("所在が違う筆は「所在 番号」で出す(物件の住所の地番と取り違えない・@codex P2)", () => {
    const s = buildSnapshotFromProperty({ ...p, extraParcels: [{ id: "a", kind: "land", location: "架空市B町", number: "2番1", realEstateNumber: null, area: null }] });
    expect(s.lotNumber).toBe("1番1、架空市B町 2番1");
  });
  it("欄の長さの境目: 「ほか◯筆」も収まらなければ1筆目だけ(空にしない・@codex P2)", () => {
    const b100 = "1".repeat(100);
    const one = [{ id: "b", kind: "building", location: null, number: "2", realEstateNumber: null, area: null }];
    expect(buildSnapshotFromProperty({ ...p, buildingNumber: b100, extraParcels: one }).buildingNumber).toBe(b100);
    const l300 = "2".repeat(300);
    const land1 = [{ id: "a", kind: "land", location: null, number: "3", realEstateNumber: null, area: null }];
    expect(buildSnapshotFromProperty({ ...p, lotNumber: l300, extraParcels: land1 }).lotNumber).toBe(l300);
    const l290 = "2".repeat(290);
    expect(buildSnapshotFromProperty({ ...p, lotNumber: l290, extraParcels: [{ ...land1[0], number: "3".repeat(20) }] }).lotNumber).toBe(`${l290} ほか1筆`);
  });
  it("横の物件情報も「、」でつなぐ", () => {
    const rows = propertySideRows({ caseStatus: "new_case", lotNumber: "1番1", buildingNumber: "1番1", extraParcels: p.extraParcels });
    expect(rows).toContainEqual({ label: "所在・地番", value: "1番1、1番2" });
    expect(rows).toContainEqual({ label: "家屋番号", value: "1番1、1番1の2" });
  });
  it("物件の基本情報は「ほか◯筆」と、ほかの土地・建物の行", () => {
    const src = read("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toContain('<Field label="地番" value={parcelNumberLabel(property.lotNumber, property.extraParcels, "land")} />');
    expect(src).toContain('<Field label="ほかの土地・建物" value={extraParcelsText(property.extraParcels)} multiline />');
  });
});
