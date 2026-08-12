/**
 * 取込の経路で現住所が入ることを固定する（設計 §6.3）。
 *
 * ⚠発注者は**システム完成後に全データを削除して入れ直す**予定で、その入れ直しは
 * ここで固定している経路を通る。ここが落ちていると、入れ直した直後から現住所が
 * 1件も入っておらず、DM はすべて登記上の住所へ送られる（機能が無いのと同じ）。
 *
 * 固定する経路:
 *  1. ヘッダ自動判定の所有者CSV（OWNER_CSV_COLUMN_MAP）
 *  2. 列の対応を明示指定した所有者CSV / 取込エラー行の編集（import-row-field-map）
 *  3. 受付帳＋所有者のペア取込（parseOwnerRows → 手動紐づけの復元まで）
 */
import { describe, it, expect } from "vitest";
import { OWNER_CSV_COLUMN_MAP } from "@/lib/csv-parser";
import {
  buildOwnerCreateData,
  mapOwnerRawData,
  resolveOwnerField,
} from "@/lib/import-row-field-map";
import {
  parseOwnerRows,
  OWNER_SHEET_POSTAL_HEADERS,
} from "@/lib/reception-owner-match";
import { parseRecoveredOwners } from "@/lib/reception-owner-link";

describe("1. ヘッダ自動判定の所有者CSV", () => {
  it("「現住所」「現住所郵便番号」を現住所の欄として拾う", () => {
    expect(OWNER_CSV_COLUMN_MAP["現住所"]).toBe("currentAddress");
    expect(OWNER_CSV_COLUMN_MAP["現住所郵便番号"]).toBe("currentZip");
  });

  it("⚠無印の「住所」は登記上のまま（取り違えると DM が旧住所へ飛ぶ）", () => {
    expect(OWNER_CSV_COLUMN_MAP["住所"]).toBe("address");
    expect(OWNER_CSV_COLUMN_MAP["郵便番号"]).toBe("zip");
  });
});

describe("2. 列の対応を明示指定した所有者CSV / 取込エラー行の編集", () => {
  it("日本語の列名からも英語の項目名からも現住所へ辿り着く", () => {
    expect(resolveOwnerField("現住所")).toBe("currentAddress");
    expect(resolveOwnerField("currentAddress")).toBe("currentAddress");
    expect(resolveOwnerField("現住所郵便番号")).toBe("currentZip");
    expect(resolveOwnerField("currentZip")).toBe("currentZip");
  });

  it("現住所がそのまま保存データに入る", () => {
    const data = buildOwnerCreateData({
      氏名: "山田太郎",
      郵便番号: "231-0842",
      住所: "横浜市南区井土ケ谷中町69-2",
      現住所: "渋谷区神宮前1-1-1",
      現住所郵便番号: "150-0001",
    });
    expect(data.address).toBe("横浜市南区井土ケ谷中町69-2");
    expect(data.currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(data.currentZip).toBe("150-0001");
  });

  it("⚠現住所の郵便番号だけの行は、郵便番号を入れない（ズレたペアを作らない）", () => {
    const data = buildOwnerCreateData({
      氏名: "山田太郎",
      住所: "横浜市南区井土ケ谷中町69-2",
      現住所郵便番号: "150-0001",
    });
    expect(data.currentAddress).toBeUndefined();
    expect(data.currentZip).toBeUndefined();
  });

  it("現住所が無い行は従来どおり（登記上だけ入る）", () => {
    const data = buildOwnerCreateData({
      氏名: "山田太郎",
      住所: "横浜市南区井土ケ谷中町69-2",
    });
    expect(data.address).toBe("横浜市南区井土ケ谷中町69-2");
    expect(data.currentAddress).toBeUndefined();
  });

  it("空欄補完に使う読み替えも同じ結果になる", () => {
    expect(mapOwnerRawData({ 現住所: "渋谷区神宮前1-1-1" })).toEqual({
      currentAddress: "渋谷区神宮前1-1-1",
    });
  });
});

describe("3. 受付帳＋所有者のペア取込", () => {
  const HEADERS = [
    "氏名",
    "物件住所",
    "都道府県",
    "所有者市区郡",
    "所有者住所",
    "郵便番号",
    "現住所",
    "現住所郵便番号",
  ];

  it("現住所は1列そのまま（登記上の4列連結を流用しない）", () => {
    const rows = parseOwnerRows(HEADERS, [
      [
        "山田太郎",
        "物件所在地",
        "神奈川県",
        "横浜市南区",
        "井土ケ谷中町69-2",
        "231-0842",
        "渋谷区神宮前1-1-1",
        "150-0001",
      ],
    ]);
    // 登記上は連結（都道府県+市区郡+町名番地）
    expect(rows[0].address).toBe("神奈川県横浜市南区井土ケ谷中町69-2");
    // 現住所は連結しない
    expect(rows[0].currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(rows[0].currentZip).toBe("150-0001");
  });

  it("現住所の列が無いCSVでは null（従来のCSVを壊さない）", () => {
    const rows = parseOwnerRows(
      ["氏名", "物件住所", "所有者住所"],
      [["山田太郎", "物件所在地", "井土ケ谷中町69-2"]],
    );
    expect(rows[0].currentAddress).toBeNull();
    expect(rows[0].currentZip).toBeNull();
  });

  it("⚠Excel の郵便番号列は先頭0を落とさない指定に含める（現住所側も）", () => {
    expect(OWNER_SHEET_POSTAL_HEADERS.has("郵便番号")).toBe(true);
    expect(OWNER_SHEET_POSTAL_HEADERS.has("〒")).toBe(true);
    expect(OWNER_SHEET_POSTAL_HEADERS.has("現住所郵便番号")).toBe(true);
    expect(OWNER_SHEET_POSTAL_HEADERS.has("現住所〒")).toBe(true);
    // 住所の列は対象外（数値扱いされないので指定すると別の副作用が出る）
    expect(OWNER_SHEET_POSTAL_HEADERS.has("現住所")).toBe(false);
  });

  it("⚠要確認になった行を手で紐づけても現住所が残る（最も影響が大きい漏れ）", () => {
    // 取込時に控えた情報から所有者を作り直す経路。ここに現住所が無いと、
    // 手で解決した行だけ全部現住所なしになる。
    const recovered = parseRecoveredOwners({
      __owner_link_data: JSON.stringify([
        {
          name: "山田太郎",
          address: "横浜市南区井土ケ谷中町69-2",
          zip: "231-0842",
          currentAddress: "渋谷区神宮前1-1-1",
          currentZip: "150-0001",
        },
      ]),
    });
    expect(recovered[0].currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(recovered[0].currentZip).toBe("150-0001");
  });

  it("現住所を持たない古い行も読める（null になるだけ）", () => {
    const recovered = parseRecoveredOwners({
      __owner_link_data: JSON.stringify([
        { name: "山田太郎", address: "横浜市南区井土ケ谷中町69-2", zip: null },
      ]),
    });
    expect(recovered[0].name).toBe("山田太郎");
    expect(recovered[0].currentAddress).toBeNull();
    expect(recovered[0].currentZip).toBeNull();
  });
});
