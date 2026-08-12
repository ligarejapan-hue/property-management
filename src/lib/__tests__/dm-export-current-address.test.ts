/**
 * DM の宛先が「現住所を優先」で決まることを、組み合わせで固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §4 / §4.0
 *
 * ⚠既存の dm-export.test.ts は「住所が1つ」の前提で書かれており、現住所を足しても
 * 緑のまま通ってしまう。ここで**組み合わせ**を明示的に足す。
 */
import { describe, it, expect } from "vitest";
import {
  groupPropertyOwnersByAddress,
  buildDmRow,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

const PLAIN: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

const po = (
  o: Partial<DmRowPropertyOwner["owner"]> & { name: string },
  isPrimary = false,
): DmRowPropertyOwner => ({
  isPrimary,
  relationship: null,
  owner: {
    nameKana: null,
    zip: null,
    address: null,
    currentZip: null,
    currentAddress: null,
    corporateNumber: null,
    ...o,
  },
});

const PROPERTY = { address: "物件所在地", propertyType: "land" };

describe("宛先の解決 — 現住所を優先する", () => {
  it("現住所があれば現住所へ送る（登記上は使わない）", () => {
    const row = buildDmRow(
      PROPERTY,
      [
        po({
          name: "甲",
          zip: "231-0842",
          address: "横浜市南区井土ケ谷中町69-2",
          currentZip: "150-0001",
          currentAddress: "渋谷区神宮前1-1-1",
        }),
      ],
      PLAIN,
      null,
    );
    expect(row["所有者住所"]).toBe("渋谷区神宮前1-1-1");
    expect(row["郵便番号"]).toBe("150-0001");
  });

  it("⚠登記上が空でも現住所があれば送付対象になる（skip しない）", () => {
    const { groups, skippedAddressCount } = groupPropertyOwnersByAddress([
      po({ name: "甲", currentAddress: "渋谷区神宮前1-1-1" }),
    ]);
    expect(skippedAddressCount).toBe(0);
    expect(groups).toHaveLength(1);
  });

  it("どちらも無ければ送付対象外（skip）", () => {
    const { groups, skippedAddressCount } = groupPropertyOwnersByAddress([
      po({ name: "甲" }),
    ]);
    expect(skippedAddressCount).toBe(1);
    expect(groups).toHaveLength(0);
  });
});

describe("共有者のまとめ方 — 同じ送付先は1通", () => {
  it("同じ現住所の共有者は1グループ（1通）", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ name: "甲", address: "登記A", currentAddress: "現住所X" }, true),
      po({ name: "乙", address: "登記B", currentAddress: "現住所X" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("⚠片方だけ郵便番号がある場合も1通にまとめる（鍵は住所だけ）", () => {
    // 郵便番号を鍵に入れていた頃は、ここが2グループに割れて同じ場所へ2通届いていた。
    const { groups } = groupPropertyOwnersByAddress([
      po({ name: "甲", currentAddress: "現住所X", currentZip: "150-0001" }, true),
      po({ name: "乙", currentAddress: "現住所X" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("別々の現住所なら別グループ（2通）", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ name: "甲", currentAddress: "現住所X" }, true),
      po({ name: "乙", currentAddress: "現住所Y" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("⚠同一人物が現住所と登記上で2通に分裂しない", () => {
    // 甲は現住所X、乙は登記上がX（＝同じ場所）。解決後の宛先で鍵を作るので1通。
    const { groups } = groupPropertyOwnersByAddress([
      po({ name: "甲", address: "登記A", currentAddress: "X" }, true),
      po({ name: "乙", address: "X" }),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe("刷る郵便番号の決め方（設計 §4.0）", () => {
  const rowOf = (group: DmRowPropertyOwner[]) =>
    buildDmRow(PROPERTY, group, PLAIN, null);

  it("グループで1種類なら、代表が持っていなくてもその番号を刷る", () => {
    const row = rowOf([
      po({ name: "甲", currentAddress: "X" }, true),
      po({ name: "乙", currentAddress: "X", currentZip: "150-0001" }),
    ]);
    expect(row["郵便番号"]).toBe("150-0001");
  });

  it("⚠食い違うなら空で刷る（どちらが正しいか決められない）", () => {
    const row = rowOf([
      po({ name: "甲", currentAddress: "X", currentZip: "150-0001" }, true),
      po({ name: "乙", currentAddress: "X", currentZip: "231-0842" }),
    ]);
    expect(row["郵便番号"]).toBe("");
  });

  it("書き方違いは同じ番号として扱う（空にしない）", () => {
    const row = rowOf([
      po({ name: "甲", currentAddress: "X", currentZip: "1500001" }, true),
      po({ name: "乙", currentAddress: "X", currentZip: "150-0001" }),
    ]);
    expect(row["郵便番号"]).not.toBe("");
  });

  it("⚠現住所ありで現住所の郵便番号が空なら、登記上の番号を混ぜない", () => {
    const row = rowOf([
      po({ name: "甲", zip: "231-0842", address: "登記A", currentAddress: "X" }, true),
    ]);
    expect(row["所有者住所"]).toBe("X");
    expect(row["郵便番号"]).toBe("");
  });

  it("海外の郵便番号を形式で捨てない", () => {
    const row = rowOf([
      po({ name: "甲", currentAddress: "海外", currentZip: "10001" }, true),
    ]);
    expect(row["郵便番号"]).toBe("10001");
  });
});
