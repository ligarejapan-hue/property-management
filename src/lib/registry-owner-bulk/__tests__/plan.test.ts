/**
 * まとめて反映の「今回処理する件数」の受け取りと、行の組み立て。
 *
 * ⚠件数を取り違えると、確かめる前に1,821件全部に書き込んでしまう。
 *   既定は少なめ(100件)にして、増やすのは人の操作に限る。
 */
import { describe, it, expect } from "vitest";

import {
  REGISTRY_OWNER_APPLY_DEFAULT_LIMIT,
  REGISTRY_OWNER_APPLY_MAX_LIMIT,
  buildRegistryOwnerApplyRowSeeds,
  parseRegistryOwnerApplyLimit,
} from "@/lib/registry-owner-bulk/plan";

describe("今回処理する件数", () => {
  it("指定が無ければ既定（100件）", () => {
    expect(REGISTRY_OWNER_APPLY_DEFAULT_LIMIT).toBe(100);
    expect(parseRegistryOwnerApplyLimit(undefined)).toBe(100);
    expect(parseRegistryOwnerApplyLimit(null)).toBe(100);
  });

  it("1件以上・上限以下の整数はそのまま", () => {
    expect(parseRegistryOwnerApplyLimit(1)).toBe(1);
    expect(parseRegistryOwnerApplyLimit(250)).toBe(250);
    expect(parseRegistryOwnerApplyLimit(REGISTRY_OWNER_APPLY_MAX_LIMIT)).toBe(
      REGISTRY_OWNER_APPLY_MAX_LIMIT,
    );
  });

  it("⚠不正な件数は黙って直さず、受け付けない（null）", () => {
    for (const bad of [0, -1, 1.5, "100", "", true, {}, [], NaN, Infinity]) {
      expect(parseRegistryOwnerApplyLimit(bad)).toBeNull();
    }
  });

  it("⚠上限を超える件数は受け付けない（一度に流しすぎない）", () => {
    expect(
      parseRegistryOwnerApplyLimit(REGISTRY_OWNER_APPLY_MAX_LIMIT + 1),
    ).toBeNull();
  });
});

describe("行の組み立て", () => {
  const targets = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", address: "東京都渋谷区神宮前三丁目12-3" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", address: null },
  ];

  it("1始まりの通し番号・未処理(pending)で作る", () => {
    const seeds = buildRegistryOwnerApplyRowSeeds(targets);
    expect(seeds).toHaveLength(2);
    expect(seeds.map((s) => s.rowNumber)).toEqual([1, 2]);
    expect(seeds.every((s) => s.status === "pending")).toBe(true);
  });

  it("⚠同じ物件が二度入らない", () => {
    const seeds = buildRegistryOwnerApplyRowSeeds([...targets, targets[0]]);
    expect(seeds).toHaveLength(2);
  });

  it("行の中身は物件IDと物件の住所だけ（所有者の氏名・住所は入れない）", () => {
    const seeds = buildRegistryOwnerApplyRowSeeds(targets);
    expect(seeds[0].rawData.propertyId).toBe(targets[0].id);
    expect(seeds[0].rawData.address).toBe(targets[0].address);
    expect(seeds[1].rawData.address).toBeUndefined();
  });
});
