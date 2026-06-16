/**
 * src/lib/dm-export.ts の純ヘルパー単体テスト。
 *
 * 所有者宛 DM の「1 送付先住所 = 1 行」グルーピング（PR-3a）を担う純関数を固定する:
 *  - normalizeZipForGroup        : zip の正規化（trim + ハイフン/空白除去）
 *  - normalizeAddressForGroup    : address の正規化（trim + 空白正規化）
 *  - ownerAddressGroupKey        : 郵便番号 + 住所のグルーピングキー（氏名は含めない）
 *  - groupPropertyOwnersByAddress: 同一物件内の所有者を送付先住所でグルーピング（空 address は skip）
 *  - selectGroupRepresentative   : 代表所有者（primary 優先・無ければ先頭）
 *  - buildDmRow                  : 1 グループ = 1 行のマッピング（宛名 / 送付先一覧 / 共有者数）
 *
 * maskValue / property-types は実物を使う（マスキング・ラベルの実挙動を検証）。
 */
import { describe, it, expect } from "vitest";
import {
  DM_EXPORT_HEADERS,
  normalizeZipForGroup,
  normalizeAddressForGroup,
  ownerAddressGroupKey,
  groupPropertyOwnersByAddress,
  selectGroupRepresentative,
  buildDmRow,
  type DmRowProperty,
  type DmRowPropertyOwner,
} from "@/lib/dm-export";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

const FULL: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
} as unknown as OwnerDisplayConfig;

function owner(over: Record<string, unknown> = {}) {
  return {
    name: "所有 花子",
    nameKana: "ショユウ ハナコ",
    zip: "100-0001",
    address: "東京都千代田区2-2",
    corporateNumber: null,
    ...over,
  };
}

function po(over: Record<string, unknown> = {}): DmRowPropertyOwner {
  const { owner: ownerOver, ...rest } = over;
  return {
    isPrimary: true,
    relationship: "本人",
    ...rest,
    owner: owner((ownerOver as Record<string, unknown>) ?? {}),
  } as DmRowPropertyOwner;
}

const PROP: DmRowProperty = {
  address: "東京都千代田区1-1",
  propertyType: "land",
};

describe("normalizeZipForGroup", () => {
  it("trim してハイフンを除去する", () => {
    expect(normalizeZipForGroup(" 100-0001 ")).toBe("1000001");
  });
  it("全角ハイフン・内部空白も除去する", () => {
    expect(normalizeZipForGroup("100－0001")).toBe("1000001");
    expect(normalizeZipForGroup("100 0001")).toBe("1000001");
  });
  it("null / undefined / 空文字は空文字", () => {
    expect(normalizeZipForGroup(null)).toBe("");
    expect(normalizeZipForGroup(undefined)).toBe("");
    expect(normalizeZipForGroup("   ")).toBe("");
  });
});

describe("normalizeAddressForGroup", () => {
  it("trim して内部の連続空白を 1 つに正規化する", () => {
    expect(normalizeAddressForGroup(" 東京都  千代田区 1-1 ")).toBe(
      "東京都 千代田区 1-1",
    );
  });
  it("全角スペース・タブも単一空白に正規化する", () => {
    expect(normalizeAddressForGroup("東京都　千代田区\t1-1")).toBe(
      "東京都 千代田区 1-1",
    );
  });
  it("null / undefined / 空白のみは空文字", () => {
    expect(normalizeAddressForGroup(null)).toBe("");
    expect(normalizeAddressForGroup(undefined)).toBe("");
    expect(normalizeAddressForGroup("　 \t ")).toBe("");
  });
});

describe("ownerAddressGroupKey", () => {
  it("郵便番号 + 住所が同じなら同一キー（氏名はキーに含めない）", () => {
    const a = ownerAddressGroupKey("100-0001", "東京都千代田区2-2");
    const b = ownerAddressGroupKey(" 1000001 ", "東京都千代田区2-2");
    expect(a).toBe(b);
  });
  it("住所が異なれば別キー", () => {
    expect(ownerAddressGroupKey("100-0001", "東京都千代田区2-2")).not.toBe(
      ownerAddressGroupKey("100-0001", "東京都千代田区9-9"),
    );
  });
  it("zip が空 vs 非空は別キー（安全側）", () => {
    expect(ownerAddressGroupKey("", "東京都千代田区2-2")).not.toBe(
      ownerAddressGroupKey("100-0001", "東京都千代田区2-2"),
    );
  });
});

describe("groupPropertyOwnersByAddress", () => {
  it("同一 zip + address の共有者を 1 グループにまとめる", () => {
    const { groups, skippedAddressCount } = groupPropertyOwnersByAddress([
      po({ owner: { name: "A", zip: "100-0001", address: "東京都港区3-3" } }),
      po({ owner: { name: "B", zip: "100-0001", address: "東京都港区3-3" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    expect(skippedAddressCount).toBe(0);
  });

  it("異なる address は別グループ", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ owner: { name: "A", address: "東京都港区3-3" } }),
      po({ owner: { name: "B", address: "東京都港区9-9" } }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("氏名が違っても zip + address が同じなら 1 グループ（重複送付しない）", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ owner: { name: "親 太郎", zip: "100-0001", address: "同じ住所1-1" } }),
      po({ owner: { name: "子 次郎", zip: "100-0001", address: "同じ住所1-1" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("zip のハイフン差・住所の空白差を吸収して 1 グループ", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ owner: { name: "A", zip: "100-0001", address: "東京都 港区 3-3" } }),
      po({ owner: { name: "B", zip: "1000001", address: "東京都  港区 3-3" } }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("address が空欄の所有者は skip（グループに含めず skippedAddressCount に計上）", () => {
    const { groups, skippedAddressCount } = groupPropertyOwnersByAddress([
      po({ owner: { name: "A", address: "東京都港区3-3" } }),
      po({ owner: { name: "空欄", address: "" } }),
      po({ owner: { name: "空白のみ", address: "　 " } }),
      po({ owner: { name: "null", address: null } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
    expect(skippedAddressCount).toBe(3);
  });

  it("zip 空欄でも同一住所ならまとめる（初期方針）", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ owner: { name: "A", zip: "", address: "同じ住所1-1" } }),
      po({ owner: { name: "B", zip: null, address: "同じ住所1-1" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("入力順（primary 先頭・既存出力順）を保持する", () => {
    const { groups } = groupPropertyOwnersByAddress([
      po({ owner: { name: "先頭", address: "A" } }),
      po({ owner: { name: "別住所", address: "B" } }),
      po({ owner: { name: "先頭と同居", address: "A" } }),
    ]);
    // 最初に出現した住所 A のグループが先
    expect(groups[0][0].owner.name).toBe("先頭");
    expect(groups[0][1].owner.name).toBe("先頭と同居");
    expect(groups[1][0].owner.name).toBe("別住所");
  });
});

describe("selectGroupRepresentative", () => {
  it("primary 所有者を代表に選ぶ", () => {
    const group = [
      po({ owner: { name: "非代表" }, isPrimary: false }),
      po({ owner: { name: "代表" }, isPrimary: true }),
    ];
    expect(selectGroupRepresentative(group).owner.name).toBe("代表");
  });
  it("primary が無ければ先頭を代表にする", () => {
    const group = [
      po({ owner: { name: "先頭" }, isPrimary: false }),
      po({ owner: { name: "二番目" }, isPrimary: false }),
    ];
    expect(selectGroupRepresentative(group).owner.name).toBe("先頭");
  });
});

describe("buildDmRow（1 グループ = 1 行）", () => {
  it("1 名: 所有者名 + 敬称（様）・共有者数 1・送付先一覧は本人のみ", () => {
    const row = buildDmRow(PROP, [po({ owner: { name: "所有 花子" } })], FULL, "MGMT-1");
    expect(row["所有者名"]).toBe("所有 花子");
    expect(row["敬称"]).toBe("様");
    expect(row["共有者数"]).toBe("1");
    expect(row["送付先所有者名一覧"]).toBe("所有 花子");
    expect(row["管理ID"]).toBe("MGMT-1");
  });

  it("1 名・法人: 敬称は御中", () => {
    const row = buildDmRow(
      PROP,
      [po({ owner: { name: "法人A", corporateNumber: "1234567890123" } })],
      FULL,
      "",
    );
    expect(row["敬称"]).toBe("御中");
  });

  it("複数名: 代表名 + 敬称『様 他共有者様』・共有者数・送付先一覧", () => {
    const row = buildDmRow(
      PROP,
      [
        po({ owner: { name: "代表 太郎" }, isPrimary: true }),
        po({ owner: { name: "共有 次郎" }, isPrimary: false, relationship: "子" }),
      ],
      FULL,
      "",
    );
    expect(row["所有者名"]).toBe("代表 太郎");
    expect(row["敬称"]).toBe("様 他共有者様");
    expect(row["共有者数"]).toBe("2");
    expect(row["送付先所有者名一覧"]).toBe("代表 太郎、共有 次郎");
  });

  it("代表は primary 優先（送付先一覧は入力順のまま）", () => {
    const row = buildDmRow(
      PROP,
      [
        po({ owner: { name: "非代表 先頭" }, isPrimary: false }),
        po({ owner: { name: "代表 後ろ" }, isPrimary: true }),
      ],
      FULL,
      "",
    );
    // 代表は primary
    expect(row["所有者名"]).toBe("代表 後ろ");
    // 代表者列は代表が primary なので「代表」
    expect(row["代表者"]).toBe("代表");
  });

  it("郵便番号 / 所有者住所 は代表所有者の Owner.zip / Owner.address を使う", () => {
    const row = buildDmRow(
      PROP,
      [po({ owner: { zip: "100-0001", address: "東京都千代田区2-2" } })],
      FULL,
      "",
    );
    expect(row["郵便番号"]).toBe("100-0001");
    expect(row["所有者住所"]).toBe("東京都千代田区2-2");
  });

  it("null フィールドは空文字（literal null を出さない）", () => {
    const row = buildDmRow(
      { address: null, propertyType: "land" },
      [po({ owner: { name: "X", nameKana: null, zip: null, address: null }, relationship: null })],
      FULL,
      null,
    );
    expect(Object.values(row)).not.toContain(null);
    expect(JSON.stringify(row)).not.toContain("null");
  });

  it("部屋番号 キーを出力しない（列削除）", () => {
    const row = buildDmRow(PROP, [po({ owner: { name: "所有 花子" } })], FULL, "MGMT-1");
    expect(Object.keys(row)).not.toContain("部屋番号");
  });
});

// DQ-05: 敬称を owner-honorific（honorificForOwner）へ委譲した配線の挙動を固定する。
// 旧 inline honorific(corporateNumber) は法人番号の有無だけで判定したため、法人番号を
// 持たない組織（管理組合・自治会・法人格名）は「様」になっていた。配線後は名称ベースの
// 組織判定が効いて「御中」になる（法人番号あり=御中 / 個人=様 の parity は保持）。
describe("buildDmRow — DQ-05 敬称配線（法人番号なしの組織名 → 御中）", () => {
  it("法人番号なし「○○管理組合」単独 → 御中（旧挙動の 様 から変更）", () => {
    const row = buildDmRow(
      PROP,
      [po({ owner: { name: "○○マンション管理組合", corporateNumber: null } })],
      FULL,
      "",
    );
    expect(row["所有者名"]).toBe("○○マンション管理組合");
    expect(row["敬称"]).toBe("御中");
  });

  it("法人番号なし「○○商事株式会社」（法人格マーカ）単独 → 御中", () => {
    const row = buildDmRow(
      PROP,
      [po({ owner: { name: "○○商事株式会社", corporateNumber: null } })],
      FULL,
      "",
    );
    expect(row["敬称"]).toBe("御中");
  });

  it("法人番号なし組織名が代表 + 共有者 → 『御中 他共有者様』", () => {
    const row = buildDmRow(
      PROP,
      [
        po({ owner: { name: "○○自治会", corporateNumber: null }, isPrimary: true }),
        po({
          owner: { name: "個人 次郎", address: "東京都港区9-9", corporateNumber: null },
          isPrimary: false,
          relationship: "他",
        }),
      ],
      FULL,
      "",
    );
    expect(row["所有者名"]).toBe("○○自治会");
    expect(row["敬称"]).toBe("御中 他共有者様");
    expect(row["共有者数"]).toBe("2");
  });

  it("parity 保持: 法人番号ありは名称に関係なく御中・個人名は様", () => {
    const corp = buildDmRow(
      PROP,
      [po({ owner: { name: "山田太郎", corporateNumber: "1234567890123" } })],
      FULL,
      "",
    );
    expect(corp["敬称"]).toBe("御中");
    const person = buildDmRow(
      PROP,
      [po({ owner: { name: "山田太郎", corporateNumber: null } })],
      FULL,
      "",
    );
    expect(person["敬称"]).toBe("様");
  });
});

describe("DM_EXPORT_HEADERS（列順・末尾追加列）", () => {
  it("部屋番号を除いた既存 11 列を順序通り維持し、末尾に送付先所有者名一覧・共有者数を追加（計 13 列）", () => {
    expect(DM_EXPORT_HEADERS).toEqual([
      "管理ID",
      "物件住所",
      "所有者名",
      "敬称",
      "郵便番号",
      "所有者住所",
      "物件種別",
      "所有者名カナ",
      "代表者",
      "続柄",
      "DM判断",
      "送付先所有者名一覧",
      "共有者数",
    ]);
  });

  it("部屋番号 列を含まない", () => {
    expect(DM_EXPORT_HEADERS).not.toContain("部屋番号");
  });
});
