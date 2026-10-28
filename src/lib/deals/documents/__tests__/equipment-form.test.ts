import { describe, expect, it } from "vitest";
import { EQUIPMENT_FORM, EQUIPMENT_ROWS } from "../forms/equipment";
import { formItems } from "../forms/values";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";
import { EQUIPMENT_UNIT_SOURCE } from "../texts/equipment-unit";

const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");
const SRC = { house: EQUIPMENT_HOUSE_SOURCE, unit: EQUIPMENT_UNIT_SOURCE } as const;

describe("付帯設備表の設備の行の表(設計 第2段階 §4.8)", () => {
  it("種類はタブ・説明のページの設定は PDF に出さない", () => {
    expect(EQUIPMENT_FORM.tabs).toEqual({ key: "kind", label: "種類", choices: [{ value: "house", label: "土地建物用" }, { value: "unit", label: "区分所有建物用" }] });
    expect(formItems(EQUIPMENT_FORM).find((i) => i.key === "withGuide")).toMatchObject({ noPrint: true });
  });

  it("書式の文字と一字も違わない(表の見出し・部門・設備の名称・内容・選択肢・書き込み欄の名前・空白は比べない)", () => {
    for (const kind of ["house", "unit"] as const) {
      const cells = SRC[kind].formCells.map(squeeze);
      const has = (t: string) => cells.some((c) => c.includes(squeeze(t)));
      for (const r of EQUIPMENT_ROWS[kind]) {
        if (r.kind === "table") for (const t of [r.title, r.nameHeader, r.detailHeader]) expect(has(t), `${kind}: ${t}`).toBe(true);
        if (r.kind === "group") expect(has(r.title), `${kind}: ${r.title}`).toBe(true);
        if (r.kind === "equip") {
          if (r.name) expect(has(r.name), `${kind}: ${r.name}`).toBe(true);
          for (const d of r.details ?? []) {
            for (const p of d.parts) expect(has(p), `${kind}: ${p}`).toBe(true);
            for (const o of d.options ?? []) expect(d.parts.join(""), `${kind}: ${o}`).toContain(o);
          }
        }
      }
      for (const t of ["設置箇所：", "計", "特定保守製品の表示（注２）", "判明している故障・不具合の具体的内容", "備考"]) expect(has(t), t).toBe(true);
    }
  });

  it("設備の行と空欄の行の数=書式の「有・無」だけのセルの数・特定保守製品の行の数も合う(行の抜け・増えを見る)", () => {
    for (const kind of ["house", "unit"] as const) {
      const cells = SRC[kind].formCells.map(squeeze);
      const rows = EQUIPMENT_ROWS[kind];
      expect(rows.filter((r) => r.kind === "equip" || r.kind === "blank").length, kind).toBe(cells.filter((c) => c === "有・無").length);
      expect(rows.filter((r) => r.kind === "equip" && r.safety).length, kind).toBe(cells.filter((c) => c.includes("特定保守製品の表示")).length);
    }
  });

  it("鍵が重ならず、土地建物は h・区分は u で始まる", () => {
    const keys = formItems(EQUIPMENT_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of formItems(EQUIPMENT_FORM).filter((i) => !i.noPrint)) expect(i.key, i.key).toMatch(i.only?.[0] === "unit" ? /^u/ : /^h/);
  });

  it("書式の小さな見出し(キッチン設備など)も行の表にある(最終レビュー)", () => {
    for (const kind of ["house", "unit"] as const) {
      const titles = EQUIPMENT_ROWS[kind].filter((r) => r.kind === "group").map((r) => (r.kind === "group" ? r.title : ""));
      for (const t of ["キッチン設備", "浴室設備", "洗面設備", "トイレ設備", "洗濯設備"]) expect(titles, `${kind}: ${t}`).toContain(t);
    }
  });

  it("Excel の行の名前が重ならない(どの設備の値か分かる・最終レビュー)", async () => {
    const { formValueRows } = await import("../forms/render");
    const { emptyFormValues } = await import("../forms/values");
    for (const kind of ["house", "unit"]) {
      const labels = formValueRows(EQUIPMENT_FORM, { ...emptyFormValues(EQUIPMENT_FORM), kind }).filter((r) => !r.heading).map((r) => r.label);
      const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
      expect(dup, kind).toEqual([]);
    }
  });
});
