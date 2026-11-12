import { describe, it, expect } from "vitest";
import { buildRegistryEntriesView } from "@/lib/registry-entries/view";
import type { OwnerDisplayConfig } from "@/lib/display-level";

/**
 * 登記上の記載を画面に渡す形(2026-11-12)。
 * ⚠住所は所有者の登記上の住所と同じ表示レベルで伏せる。owner:read が無い人には何も渡さない。
 */
const config = (address: OwnerDisplayConfig["address"]): OwnerDisplayConfig => ({
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address,
  note: "full",
  email: "full",
  corporateNumber: "full",
});

const records = [
  { position: 3, address: "神奈川県横浜市見本区3-3-3", shareNum: 2, shareDen: 10 },
  { position: 1, address: "東京都港区見本1-1-1", shareNum: 2, shareDen: 10 },
  { position: 2, address: "埼玉県さいたま市見本区2-2-2", shareNum: 3, shareDen: 10 },
];

describe("buildRegistryEntriesView", () => {
  it("行の順に並べ、持分の合計を出す(約分しない)", () => {
    const v = buildRegistryEntriesView(records, config("full"));
    expect(v?.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(v?.entries[0]).toEqual({
      position: 1,
      address: "東京都港区見本1-1-1",
      share: { num: 2, den: 10 },
    });
    expect(v?.shareTotal).toEqual({ num: 7, den: 10 });
  });

  it("⚠住所を伏せる設定の人には、生の住所を渡さない", () => {
    const masked = buildRegistryEntriesView(records, config("masked"));
    for (const e of masked?.entries ?? []) {
      expect(e.address).not.toBe(records.find((r) => r.position === e.position)?.address);
    }
    const hidden = buildRegistryEntriesView(records, config("hidden"));
    expect(hidden?.entries.every((e) => e.address === null)).toBe(true);
    // 持分は住所ではないので残る
    expect(hidden?.shareTotal).toEqual({ num: 7, den: 10 });
  });

  it("⚠owner:read が無い人(config=null)には何も渡さない", () => {
    expect(buildRegistryEntriesView(records, null)).toBeNull();
  });

  it("行が無ければ null", () => {
    expect(buildRegistryEntriesView([], config("full"))).toBeNull();
    expect(buildRegistryEntriesView(undefined, config("full"))).toBeNull();
  });

  it("持分が読めない行があれば、合計は出さない(行は出す)", () => {
    const v = buildRegistryEntriesView(
      [
        { position: 1, address: "住所A", shareNum: 1, shareDen: 2 },
        { position: 2, address: "住所B", shareNum: null, shareDen: null },
      ],
      config("full"),
    );
    expect(v?.entries).toHaveLength(2);
    expect(v?.entries[1].share).toBeNull();
    expect(v?.shareTotal).toBeNull();
  });
});
