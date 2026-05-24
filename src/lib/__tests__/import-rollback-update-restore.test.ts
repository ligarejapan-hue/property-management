/**
 * Phase 2: classifyUpdateFieldsForRestore — 純関数の単体テスト
 *
 * 復元可能性ルール:
 *  - field が RESTORABLE_PROPERTY_FIELDS に含まれる
 *  - job 完了時刻 ±5000ms に source=csv_import の ChangeLog がある
 *  - その csv_import より後に同 field の手動編集 (manual/api/pdf_import) がない
 *  - oldValue を Prisma 型に変換できる
 */
import { describe, it, expect } from "vitest";
import {
  classifyUpdateFieldsForRestore,
  RESTORABLE_PROPERTY_FIELDS,
  RESTORABLE_PROPERTY_FIELD_TYPES,
} from "@/lib/import-rollback";

const completedAt = new Date("2026-05-24T10:00:00.000Z");
const completedAtMs = completedAt.getTime();

function csvLog(
  fieldName: string,
  oldValue: string | null,
  offsetMs = 0,
): {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: "csv_import";
  changedAt: Date;
} {
  return {
    fieldName,
    oldValue,
    newValue: "new",
    source: "csv_import",
    changedAt: new Date(completedAtMs + offsetMs),
  };
}

describe("RESTORABLE_PROPERTY_FIELDS", () => {
  it("UPDATABLE_PROPERTY_FIELDS と PROPERTY_TRACKED_FIELDS の交差になっている", () => {
    expect(RESTORABLE_PROPERTY_FIELDS).toEqual(
      expect.arrayContaining([
        "address",
        "lotNumber",
        "buildingNumber",
        "introductionRoute",
        "zoningDistrict",
        "rosenkaValue",
        "gpsLat",
        "gpsLng",
        "note",
      ]),
    );
  });

  it("UPDATABLE にあるが PROPERTY_TRACKED にない field は含まない（区分マンション系）", () => {
    expect(RESTORABLE_PROPERTY_FIELDS).not.toContain("floorNo");
    expect(RESTORABLE_PROPERTY_FIELDS).not.toContain("exclusiveArea");
    expect(RESTORABLE_PROPERTY_FIELDS).not.toContain("managementFee");
    expect(RESTORABLE_PROPERTY_FIELDS).not.toContain("layoutType");
  });

  it("各 field に Prisma 型マップがある", () => {
    for (const f of RESTORABLE_PROPERTY_FIELDS) {
      expect(RESTORABLE_PROPERTY_FIELD_TYPES[f]).toBeDefined();
    }
  });
});

describe("classifyUpdateFieldsForRestore", () => {
  it("ChangeLog がない field は判定対象に含まれない（空配列）", () => {
    const out = classifyUpdateFieldsForRestore([], completedAtMs);
    expect(out).toEqual([]);
  });

  it("対象外 field は skip_not_restorable_field を返す", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("propertyType", "land")],
      completedAtMs,
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("skip_not_restorable_field");
    expect(out[0].restoreValue).toBeNull();
  });

  it("ChangeLog source が csv_import 以外のみなら skip_no_changelog", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        {
          fieldName: "address",
          oldValue: "東京都",
          newValue: "大阪府",
          source: "manual",
          changedAt: completedAt,
        },
      ],
      completedAtMs,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });

  it("csv_import が完了時刻から ±5000ms 外なら skip_no_changelog", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都", 10_000)],
      completedAtMs,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });

  it("csv_import 後に manual 編集があれば skip_subsequent_edit", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", 0),
        {
          fieldName: "address",
          oldValue: "new",
          newValue: "manual-edit",
          source: "manual",
          changedAt: new Date(completedAtMs + 60_000),
        },
      ],
      completedAtMs,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
    expect(out[0].restoreValue).toBeNull();
  });

  it("csv_import 後に api 編集があれば skip_subsequent_edit", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都"),
        {
          fieldName: "address",
          oldValue: "new",
          newValue: "api-edit",
          source: "api",
          changedAt: new Date(completedAtMs + 60_000),
        },
      ],
      completedAtMs,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
  });

  it("csv_import 後に別の csv_import がある場合は subsequent edit ではない (同じ取込形態)", () => {
    // 別 job の再取込のケース。同 field を最新で更新しているため
    // 本来は subsequent edit としても良いが、ここでは仕様優先で
    // "csv_import 以外" のみを subsequent とみなす
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", 0),
        csvLog("address", "new", 60_000),
      ],
      completedAtMs,
    );
    expect(out[0].status).toBe("restorable");
  });

  it("string field は oldValue をそのまま restoreValue にする", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都千代田区")],
      completedAtMs,
    );
    expect(out[0].status).toBe("restorable");
    expect(out[0].restoreValue).toBe("東京都千代田区");
  });

  it("int field は数値変換される / 失敗時は skip_type_conversion_failed", () => {
    const ok = classifyUpdateFieldsForRestore(
      [csvLog("rosenkaValue", "120000")],
      completedAtMs,
    );
    expect(ok[0].status).toBe("restorable");
    expect(ok[0].restoreValue).toBe(120000);

    const ng = classifyUpdateFieldsForRestore(
      [csvLog("rosenkaValue", "abc")],
      completedAtMs,
    );
    expect(ng[0].status).toBe("skip_type_conversion_failed");
  });

  it("decimal field は文字列のまま restoreValue にする / 数値として無効ならエラー", () => {
    const ok = classifyUpdateFieldsForRestore(
      [csvLog("gpsLat", "35.6895")],
      completedAtMs,
    );
    expect(ok[0].status).toBe("restorable");
    expect(ok[0].restoreValue).toBe("35.6895");

    const ng = classifyUpdateFieldsForRestore(
      [csvLog("gpsLat", "not-a-number")],
      completedAtMs,
    );
    expect(ng[0].status).toBe("skip_type_conversion_failed");
  });

  it("oldValue が null なら restoreValue=null で復元可能", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("note", null)],
      completedAtMs,
    );
    expect(out[0].status).toBe("restorable");
    expect(out[0].restoreValue).toBeNull();
  });

  it("複数 field を一度に判定できる（混合シナリオ）", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都"),
        csvLog("propertyType", "land"),
        {
          fieldName: "note",
          oldValue: "memo",
          newValue: "new",
          source: "csv_import",
          changedAt: completedAt,
        },
        {
          fieldName: "note",
          oldValue: "new",
          newValue: "user-edit",
          source: "manual",
          changedAt: new Date(completedAtMs + 30_000),
        },
        csvLog("rosenkaValue", "120000"),
      ],
      completedAtMs,
    );
    const byField = Object.fromEntries(out.map((d) => [d.fieldName, d.status]));
    expect(byField.address).toBe("restorable");
    expect(byField.propertyType).toBe("skip_not_restorable_field");
    expect(byField.note).toBe("skip_subsequent_edit");
    expect(byField.rosenkaValue).toBe("restorable");
  });

  it("reason 文字列に PII (具体値) を含めない", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都千代田区丸の内1-1-1"),
        {
          fieldName: "address",
          oldValue: "new",
          newValue: "user-edit-with-pii",
          source: "manual",
          changedAt: new Date(completedAtMs + 30_000),
        },
      ],
      completedAtMs,
    );
    for (const d of out) {
      if (d.reason) {
        expect(d.reason).not.toContain("東京都");
        expect(d.reason).not.toContain("user-edit");
      }
    }
  });
});
