import { describe, expect, it } from "vitest";
import {
  CHECKLIST_AMOUNT_KEYS, CHECKLIST_USES, DEFAULT_CHECKLIST_ITEMS, usedIn, checklistItemsSchema, itemsFor, resolveChecklistItems, type ChecklistItem,
} from "../checklist";

const item = (p: Partial<ChecklistItem>): ChecklistItem => ({
  id: "x", phase: "contract", group: "prepare", label: "試験", note: null, scope: "all", amount: null, ...p,
});

describe("書類確認書の項目(段5c-1)", () => {
  it("初めの項目は形が正しく、契約時・決済時の3つのまとまりがそろう", () => {
    expect(checklistItemsSchema.safeParse(DEFAULT_CHECKLIST_ITEMS).success).toBe(true);
    for (const phase of ["contract", "settlement"] as const) {
      for (const group of ["prepare", "bring", "receive"] as const) {
        expect(DEFAULT_CHECKLIST_ITEMS.some((i) => i.phase === phase && i.group === group)).toBe(true);
      }
    }
  });

  it("初めの項目にリースバックは無い・持参の金額は手付金と残代金・精算金を含む", () => {
    expect(DEFAULT_CHECKLIST_ITEMS.some((i) => /リースバック/.test(i.label + (i.note ?? "")))).toBe(false);
    expect(DEFAULT_CHECKLIST_ITEMS.some((i) => i.phase === "contract" && i.amount === "deposit")).toBe(true);
    expect(DEFAULT_CHECKLIST_ITEMS.some((i) => i.phase === "settlement" && i.amount === "payment")).toBe(true);
  });

  it("保存が空・壊れているときは初めの項目", () => {
    expect(resolveChecklistItems([])).toEqual(DEFAULT_CHECKLIST_ITEMS);
    expect(resolveChecklistItems(undefined)).toEqual(DEFAULT_CHECKLIST_ITEMS);
    expect(resolveChecklistItems([{ id: "bad id" }])).toEqual(DEFAULT_CHECKLIST_ITEMS);
    const mine = [item({ id: "a" })];
    expect(resolveChecklistItems(mine)).toEqual(mine);
  });

  it("保存の形: 1件以上・id は重ならない・金額は持参するものだけ", () => {
    expect(checklistItemsSchema.safeParse([]).success).toBe(false);
    expect(checklistItemsSchema.safeParse([item({ id: "a" }), item({ id: "a" })]).success).toBe(false);
    expect(checklistItemsSchema.safeParse([item({ group: "prepare", amount: "deposit" })]).success).toBe(false);
    expect(checklistItemsSchema.safeParse([item({ group: "bring", amount: "deposit" })]).success).toBe(true);
    expect(checklistItemsSchema.safeParse([item({ label: "  " })]).success).toBe(false);
    expect(CHECKLIST_AMOUNT_KEYS).toContain("cancellation");
    // 空の項目名は日本語で何が悪いかを返す(画面にそのまま出る)
    const r = checklistItemsSchema.safeParse([item({ label: "" })]);
    expect(r.success ? "" : r.error.issues[0].message).toBe("項目名が空の行があります");
  });

  it("区分だけ・土地のある物件だけ・OC だけを出し分ける", () => {
    const items = [
      item({ id: "all" }), item({ id: "unit", scope: "unit" }), item({ id: "land", scope: "land" }), item({ id: "oc", scope: "oc" }),
      item({ id: "s", phase: "settlement" }),
    ];
    const ids = (base: "unit" | "house" | "land" | "building" | null, hasOc: boolean) =>
      itemsFor(items, "contract", { base, hasOc }).map((i) => i.id);
    expect(ids("unit", false)).toEqual(["all", "unit"]);
    expect(ids("house", false)).toEqual(["all", "land"]);
    expect(ids("building", true)).toEqual(["all", "land", "oc"]);
    expect(ids("land", false)).toEqual(["all", "land"]);
    // 種別が無い取引は「すべて」だけ(OC は取引の値で決まる)
    expect(ids(null, true)).toEqual(["all", "oc"]);
  });
});

describe("使う書類(第2段階 §4.4)", () => {
  const base = DEFAULT_CHECKLIST_ITEMS[0];
  it("保存済みの項目(use が無い)は両方として読む・知らない値は断る", () => {
    const parsed = checklistItemsSchema.parse([base]);
    expect(parsed[0].use).toBeUndefined();
    expect(usedIn(parsed[0], "checklist")).toBe(true);
    expect(usedIn(parsed[0], "prep")).toBe(true);
    expect(checklistItemsSchema.parse([{ ...base, use: "prep" }])[0].use).toBe("prep");
    expect(checklistItemsSchema.safeParse([{ ...base, use: "other" }]).success).toBe(false);
    expect(Object.keys(CHECKLIST_USES)).toEqual(["both", "checklist", "prep"]);
  });
  it("書類ごとに出し分ける(書類確認書=両方と書類確認書だけ・準備チェックリスト=両方と準備チェックリストだけ)", () => {
    const items = [
      { ...base, id: "a" }, { ...base, id: "b", use: "checklist" as const }, { ...base, id: "c", use: "prep" as const }, { ...base, id: "d", use: "both" as const },
    ];
    const deal = { base: "house" as const, hasOc: false };
    expect(itemsFor(items, base.phase, deal).map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(itemsFor(items, base.phase, deal, "checklist").map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(itemsFor(items, base.phase, deal, "prep").map((i) => i.id)).toEqual(["a", "c", "d"]);
  });
});
