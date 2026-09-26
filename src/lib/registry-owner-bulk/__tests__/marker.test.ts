/**
 * 「謄本から所有者をまとめて反映」の行を見分ける印。
 *
 * ⚠既存の「所有者事項PDF一括」の取込記録に**相乗り**する(データベースの種別を
 * 増やさない・受付帳×所有者が owner_csv に相乗りしているのと同じ手)。
 * 見分けが甘いと、PDFを上げた一括取込の行をこちらの処理に流してしまう。
 */
import { describe, it, expect } from "vitest";

import {
  REGISTRY_OWNER_APPLY_KIND,
  buildRegistryOwnerApplyRawData,
  isRegistryOwnerApplyRow,
  readRegistryOwnerApplyRow,
  redactRegistryOwnerApplyRow,
} from "@/lib/registry-owner-bulk/marker";

const rawData = buildRegistryOwnerApplyRawData({
  propertyId: "11111111-1111-4111-8111-111111111111",
  address: "東京都渋谷区神宮前三丁目12-3",
});

describe("まとめて反映の行の見分け", () => {
  it("印があり、種別が所有者事項PDF一括なら、まとめて反映の行", () => {
    expect(isRegistryOwnerApplyRow("registry_pdf_bulk", rawData)).toBe(true);
  });

  it("⚠PDFを上げた一括取込の行は、まとめて反映の行にしない", () => {
    expect(
      isRegistryOwnerApplyRow("registry_pdf_bulk", {
        fileName: "世田谷区三宿1丁目125-7所有者事項.PDF",
        stagedKey: "staging/registry-pdf-bulk/x.pdf",
      }),
    ).toBe(false);
  });

  it("⚠種別が違えば、印があっても対象にしない", () => {
    expect(isRegistryOwnerApplyRow("owner_csv", rawData)).toBe(false);
    expect(isRegistryOwnerApplyRow("property_csv", rawData)).toBe(false);
  });

  it("中身が無い・形が違う行は対象にしない", () => {
    expect(isRegistryOwnerApplyRow("registry_pdf_bulk", null)).toBe(false);
    expect(isRegistryOwnerApplyRow("registry_pdf_bulk", {})).toBe(false);
    expect(
      isRegistryOwnerApplyRow("registry_pdf_bulk", {
        __kind: REGISTRY_OWNER_APPLY_KIND,
      }),
    ).toBe(false); // 物件IDが無い
  });
});

describe("行に書き込む内容", () => {
  it("⚠所有者の氏名・住所は入れない（物件IDと物件の住所だけ）", () => {
    expect(Object.keys(rawData).sort()).toEqual(
      ["__kind", "address", "propertyId"].sort(),
    );
    expect(rawData.propertyId).toBe("11111111-1111-4111-8111-111111111111");
    // 物件の住所は一覧で「どの物件か」を示すため。所有者の住所ではない。
    expect(rawData.address).toBe("東京都渋谷区神宮前三丁目12-3");
  });

  it("物件の住所が無い物件でも作れる", () => {
    const withoutAddress = buildRegistryOwnerApplyRawData({
      propertyId: "22222222-2222-4222-8222-222222222222",
      address: null,
    });
    expect(withoutAddress.address).toBeUndefined();
    expect(isRegistryOwnerApplyRow("registry_pdf_bulk", withoutAddress)).toBe(true);
  });

  it("行から物件IDを取り出す（形が違えば null）", () => {
    expect(readRegistryOwnerApplyRow(rawData)?.propertyId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(readRegistryOwnerApplyRow({ propertyId: 123 })).toBeNull();
    expect(readRegistryOwnerApplyRow(null)).toBeNull();
  });
});

/**
 * ⚠なぜ必要か(@codex 第10R P1): まとめて反映の行には物件の住所を残す(結果の一覧で
 *   どの物件かを示すため)。取込の記録は「取込」の権限で見られるので、物件を見る権限が
 *   無い人にも最大5,000件の住所が見えてしまう。物件を見られない人には住所を外す。
 */
describe("物件を見られない人には、まとめて反映の行の住所を外す", () => {
  const row = { id: "r1", rawData };

  it("⚠物件を見られない人には address を外す（物件IDは残す）", () => {
    const out = redactRegistryOwnerApplyRow("registry_pdf_bulk", row, false);
    const raw = out.rawData as Record<string, unknown>;
    expect(raw).not.toHaveProperty("address");
    expect(raw.propertyId).toBe("11111111-1111-4111-8111-111111111111");
    expect(out.id).toBe("r1");
    // 元の行は書き換えない
    expect((row.rawData as Record<string, unknown>).address).toBeDefined();
  });

  it("物件を見られる人には、そのまま返す", () => {
    expect(redactRegistryOwnerApplyRow("registry_pdf_bulk", row, true)).toBe(row);
  });

  it("⚠まとめて反映以外の行（PDFを上げた一括取込など）には手を出さない", () => {
    const other = { id: "r2", rawData: { fileName: "x.PDF", address: "東京都" } };
    expect(redactRegistryOwnerApplyRow("registry_pdf_bulk", other, false)).toBe(other);
    const csv = { id: "r3", rawData: { ...rawData } };
    expect(redactRegistryOwnerApplyRow("property_csv", csv, false)).toBe(csv);
  });
});
