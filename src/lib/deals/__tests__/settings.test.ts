import { describe, it, expect } from "vitest";
import { resolveDealSettings, isKnownPropertyKind } from "../settings";
import { DEFAULT_PROPERTY_KINDS } from "../constants";
import { EMPTY_BANK_ACCOUNT, dealSettingsUpdateSchema } from "../schemas";

describe("取引の設定の解決", () => {
  it("行が無ければ初期値・版は 0", () => {
    expect(resolveDealSettings(null)).toEqual({
      representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT,
      propertyKinds: DEFAULT_PROPERTY_KINDS, texts: {}, hasLogo: false, hasSeal: false, version: 0, updatedAt: null,
    });
  });
  it("保存した種別を使う・壊れていれば初期値", () => {
    const kinds = [...DEFAULT_PROPERTY_KINDS, { key: "shop_unit", label: "店舗区分", base: "unit" }];
    const at = new Date("2026-10-24T00:00:00Z");
    const base = { representativeTitle: "代表取締役", representativeName: "試験 太郎", bankAccount: {}, version: 3, updatedAt: at };
    expect(resolveDealSettings({ ...base, propertyKinds: kinds }).propertyKinds).toHaveLength(5);
    expect(resolveDealSettings({ ...base, propertyKinds: [{ key: "x" }] }).propertyKinds).toEqual(DEFAULT_PROPERTY_KINDS);
    expect(resolveDealSettings({ ...base, propertyKinds: [] }).version).toBe(3);
  });
  it("文面・画像の有無を返す(鍵そのものは返さない)", () => {
    const base = { representativeTitle: null, representativeName: null, bankAccount: {}, propertyKinds: [], version: 2, updatedAt: new Date("2026-10-24T00:00:00Z") };
    const s = resolveDealSettings({ ...base, logoKey: "deal-settings/logo-a.png", sealKey: null, texts: { funding_plan: { greeting: "いつも", notes: null } } });
    expect(s.hasLogo).toBe(true);
    expect(s.hasSeal).toBe(false);
    expect(s.texts).toEqual({ funding_plan: { greeting: "いつも", notes: null } });
    expect(JSON.stringify(s)).not.toContain("deal-settings/");
    // 壊れた文面は空として扱う
    expect(resolveDealSettings({ ...base, logoKey: null, sealKey: null, texts: { funding_plan: { greeting: 5 } } }).texts).toEqual({});
    expect(resolveDealSettings({ ...base, logoKey: null, sealKey: null, texts: "x" }).texts).toEqual({});
  });
  it("文面の保存: 空白を落とし空は null・長さの上限・知らない書類は 422", () => {
    const ok = dealSettingsUpdateSchema.parse({ version: 1, texts: { funding_plan: { greeting: "  ご検討ください\nよろしく  ", notes: "" } } });
    expect(ok.texts).toEqual({ funding_plan: { greeting: "ご検討ください\nよろしく", notes: null } });
    expect(dealSettingsUpdateSchema.safeParse({ version: 1, texts: { funding_plan: { greeting: "あ".repeat(401), notes: null } } }).success).toBe(false);
    expect(dealSettingsUpdateSchema.safeParse({ version: 1, texts: { funding_plan: { greeting: null, notes: "あ".repeat(1001) } } }).success).toBe(false);
    expect(dealSettingsUpdateSchema.safeParse({ version: 1, texts: { receipt: { greeting: "a", notes: null } } }).success).toBe(false);
    expect(dealSettingsUpdateSchema.safeParse({ version: 1, logoKey: "x" }).success).toBe(false);
  });
  it("知っている種別か", () => {
    const s = resolveDealSettings(null);
    expect(isKnownPropertyKind(s, "unit")).toBe(true);
    expect(isKnownPropertyKind(s, null)).toBe(true);
    expect(isKnownPropertyKind(s, "castle")).toBe(false);
  });
});
