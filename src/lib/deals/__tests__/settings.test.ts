import { describe, it, expect } from "vitest";
import { resolveDealSettings, isKnownPropertyKind } from "../settings";
import { DEFAULT_PROPERTY_KINDS } from "../constants";
import { EMPTY_BANK_ACCOUNT } from "../schemas";

describe("取引の設定の解決", () => {
  it("行が無ければ初期値・版は 0", () => {
    expect(resolveDealSettings(null)).toEqual({
      representativeTitle: null, representativeName: null, bankAccount: EMPTY_BANK_ACCOUNT,
      propertyKinds: DEFAULT_PROPERTY_KINDS, version: 0, updatedAt: null,
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
  it("知っている種別か", () => {
    const s = resolveDealSettings(null);
    expect(isKnownPropertyKind(s, "unit")).toBe(true);
    expect(isKnownPropertyKind(s, null)).toBe(true);
    expect(isKnownPropertyKind(s, "castle")).toBe(false);
  });
});
