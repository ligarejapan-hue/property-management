import { describe, expect, it } from "vitest";
import { DISCLOSURE_FORM } from "../forms/disclosure";
import { formItems, visibleEntries } from "../forms/values";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";
import { DISCLOSURE_UNIT_SOURCE } from "../texts/disclosure-unit";
import type { FormItem } from "../forms/types";

const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");
const NUMS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕";
const itemsOf = (kind: string) => visibleEntries(DISCLOSURE_FORM, { kind }).filter((e): e is FormItem => e.kind === "item" && !e.noPrint);
/** 項目の表の文字(見出し・選択肢・書き込み欄の名前・区切りの見出し)。 */
const textsOf = (kind: string) => [
  ...visibleEntries(DISCLOSURE_FORM, { kind }).filter((e) => e.kind === "section").map((e) => (e.kind === "section" ? e.title : "")),
  ...itemsOf(kind).flatMap((i) => [i.label, ...(i.choices ?? []).map((c) => c.label), ...(i.fields ?? []).flatMap((f) => [f.pre ?? "", f.label.replace(/[：:]$/, "")])]),
].filter(Boolean);

describe("告知書の項目の表(設計 第2段階 §4.7)", () => {
  it("種類はタブ・説明のページの設定は PDF に出さない", () => {
    expect(DISCLOSURE_FORM.tabs).toEqual({ key: "kind", label: "種類", choices: [{ value: "house", label: "土地建物・土地用" }, { value: "unit", label: "区分所有建物用" }] });
    const g = formItems(DISCLOSURE_FORM).find((i) => i.key === "withGuide")!;
    expect(g.noPrint).toBe(true);
    expect(g.choices?.map((c) => c.value)).toEqual(["付ける", "付けない"]);
  });

  it("見出し・選択肢・書き込み欄の名前は、全宅連の書式のセルの文字と一字も違わない(空白は比べない)", () => {
    for (const [kind, src] of [["house", DISCLOSURE_HOUSE_SOURCE], ["unit", DISCLOSURE_UNIT_SOURCE]] as const) {
      const all = squeeze(src.formCells.join(""));
      for (const t of textsOf(kind)) expect(all, `${kind}: ${t}`).toContain(squeeze(t));
    }
  });

  it("番号の並びは書式のとおり(土地建物=①〜㉕・区分=表１ ①〜⑳ と 表２ ①〜④)", () => {
    const nums = (kind: string) => itemsOf(kind).filter((i) => !i.sub && NUMS.includes(i.label[0])).map((i) => i.label[0]).join("");
    expect(nums("house")).toBe(NUMS);
    expect(nums("unit")).toBe(NUMS.slice(0, 20) + "①②③④");
  });

  it("鍵が重ならず、土地建物は h・区分は u で始まる(前回の入力が種類で混ざらない)", () => {
    const keys = formItems(DISCLOSURE_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of formItems(DISCLOSURE_FORM).filter((i) => !i.noPrint)) {
      expect(i.key, i.key).toMatch(i.only?.[0] === "unit" ? /^u/ : /^h/);
      expect(i.only, i.key).toHaveLength(1);
    }
  });

  it("区分用だけに表２(管理費・修繕積立金の変更予定)", () => {
    expect(textsOf("unit")).toContain("表２ 管理費・修繕積立金の変更予定");
    expect(textsOf("house").join()).not.toContain("表２");
  });
});
