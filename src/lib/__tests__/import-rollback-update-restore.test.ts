/**
 * Phase 2 + Codex P1 修正: classifyUpdateFieldsForRestore — 純関数の単体テスト
 *
 * 復元可能性ルール:
 *  - field が RESTORABLE_PROPERTY_FIELDS に含まれる
 *  - JobWindow 内 (startMs ≦ changedAt ≦ endMs) に source=csv_import が **ちょうど 1 件**
 *  - 複数あれば skip_ambiguous_changelog (importJobId が ChangeLog にないため推測しない)
 *  - csv_import より後の **任意 source** の編集があれば skip_subsequent_edit
 *    (Codex P1#1: 後続 csv_import / manual / api / pdf_import いずれもブロック)
 *  - oldValue を Prisma 型に変換できる
 *  - JobWindow.executedBy が指定されていれば changedBy 一致のみ候補
 *
 * Codex P1#2: window は (job.startedAt ?? createdAt) 〜 (job.completedAt + 小許容) で渡し、
 * completedAt ±5s ではない。長時間 import で completedAt より大きく前に書かれた
 * csv_import 行も拾える。
 */
import { describe, it, expect } from "vitest";
import {
  classifyUpdateFieldsForRestore,
  RESTORABLE_PROPERTY_FIELDS,
  RESTORABLE_PROPERTY_FIELD_TYPES,
  ROLLBACK_WINDOW_UPPER_TOLERANCE_MS,
  type JobWindow,
} from "@/lib/import-rollback";

// 想定 Job: startedAt = T0, completedAt = T0+10min（長時間 import）
const T0 = new Date("2026-05-24T10:00:00.000Z").getTime();
const COMPLETED_AT = T0 + 10 * 60 * 1000; // +10min
const EXECUTED_BY = "user-1";

const WINDOW: JobWindow = {
  startMs: T0,
  endMs: COMPLETED_AT + ROLLBACK_WINDOW_UPPER_TOLERANCE_MS,
  executedBy: EXECUTED_BY,
};

function csvLog(
  fieldName: string,
  oldValue: string | null,
  changedAtMs: number,
  overrides: { changedBy?: string } = {},
) {
  return {
    fieldName,
    oldValue,
    newValue: "new",
    source: "csv_import" as const,
    changedAt: new Date(changedAtMs),
    changedBy: overrides.changedBy ?? EXECUTED_BY,
  };
}

function nonCsvLog(
  fieldName: string,
  source: "manual" | "api" | "pdf_import",
  changedAtMs: number,
) {
  return {
    fieldName,
    oldValue: "before",
    newValue: "after",
    source,
    changedAt: new Date(changedAtMs),
    changedBy: "user-2",
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

describe("classifyUpdateFieldsForRestore — Window 形式 (P1#2)", () => {
  it("ChangeLog がない field は判定対象に含まれない（空配列）", () => {
    const out = classifyUpdateFieldsForRestore([], WINDOW);
    expect(out).toEqual([]);
  });

  it("対象外 field は skip_not_restorable_field を返す", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("propertyType", "land", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("skip_not_restorable_field");
    expect(out[0].restoreValue).toBeNull();
  });

  it("ChangeLog source が csv_import 以外のみなら skip_no_changelog", () => {
    const out = classifyUpdateFieldsForRestore(
      [nonCsvLog("address", "manual", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });

  it("長時間 import: completedAt より 5 分前の csv_import も拾える (P1#2)", () => {
    // job: startedAt=T0, completedAt=T0+10min
    // csv_import は T0+5min (completedAt - 5min) に書かれた
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都", T0 + 5 * 60 * 1000)],
      WINDOW,
    );
    expect(out[0].status).toBe("restorable");
    expect(out[0].restoreValue).toBe("東京都");
  });

  it("job 開始前の古い csv_import (window 外) は対象にならない (P1#2)", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都", T0 - 1)],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });

  it("completedAt + 許容 を超えた csv_import (window 外) は対象にならない", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog(
          "address",
          "東京都",
          COMPLETED_AT + ROLLBACK_WINDOW_UPPER_TOLERANCE_MS + 1,
        ),
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });

  it("changedBy が executedBy と一致しない csv_import は候補から除外", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都", COMPLETED_AT - 1000, { changedBy: "other" })],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_no_changelog");
  });
});

describe("classifyUpdateFieldsForRestore — 後続更新は source 不問でブロック (P1#1)", () => {
  it("後続 manual 編集があれば skip_subsequent_edit", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", COMPLETED_AT - 1000),
        nonCsvLog("address", "manual", COMPLETED_AT + 60_000),
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
    expect(out[0].restoreValue).toBeNull();
  });

  it("後続 api 編集があれば skip_subsequent_edit", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", COMPLETED_AT - 1000),
        nonCsvLog("address", "api", COMPLETED_AT + 60_000),
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
  });

  it("後続 pdf_import があれば skip_subsequent_edit", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", COMPLETED_AT - 1000),
        nonCsvLog("address", "pdf_import", COMPLETED_AT + 60_000),
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
  });

  it("後続 csv_import (別 Job B) があれば skip_subsequent_edit — Job B の値を上書きしない (P1#1)", () => {
    // Job A: T0 に csv_import で address を更新（rollback 対象）
    // Job B: COMPLETED_AT + 10min に同 address を別 csv_import で更新
    // Job A を rollback しても Job B の値を Job A の oldValue で上書きしてはいけない
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", T0),
        // Job B の changedBy は別ユーザでも同ユーザでもどちらでも検証する
        {
          fieldName: "address",
          oldValue: "new", // Job A が書いた値
          newValue: "from-job-b",
          source: "csv_import",
          changedAt: new Date(COMPLETED_AT + 10 * 60 * 1000),
          changedBy: EXECUTED_BY,
        },
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_subsequent_edit");
    expect(out[0].restoreValue).toBeNull();
  });
});

describe("classifyUpdateFieldsForRestore — 同 field 複数候補は ambiguous (P1#2 補強)", () => {
  it("同 propertyId/field で window 内に csv_import が複数あれば skip_ambiguous_changelog", () => {
    // 同 job の途中で同 field が 2 回更新されたケース、または
    // window 内に別 job の csv_import が紛れ込んだケース。
    // ChangeLog に importJobId がないため、どれが当ジョブかを確定できず復元しない。
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", T0 + 1000),
        csvLog("address", "中間値", T0 + 2000),
      ],
      WINDOW,
    );
    expect(out[0].status).toBe("skip_ambiguous_changelog");
    expect(out[0].restoreValue).toBeNull();
  });

  it("ambiguous 時の reason に値そのもの (PII) を含めない", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都千代田区丸の内1-1-1", T0 + 1000),
        csvLog("address", "別の住所値", T0 + 2000),
      ],
      WINDOW,
    );
    expect(out[0].reason).toBeDefined();
    expect(out[0].reason!).not.toContain("東京都");
    expect(out[0].reason!).not.toContain("丸の内");
    expect(out[0].reason!).not.toContain("別の住所");
  });
});

describe("classifyUpdateFieldsForRestore — 型変換", () => {
  it("string field は oldValue をそのまま restoreValue にする", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("address", "東京都千代田区", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(out[0].status).toBe("restorable");
    expect(out[0].restoreValue).toBe("東京都千代田区");
  });

  it("int field は数値変換される / 失敗時は skip_type_conversion_failed", () => {
    const ok = classifyUpdateFieldsForRestore(
      [csvLog("rosenkaValue", "120000", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(ok[0].status).toBe("restorable");
    expect(ok[0].restoreValue).toBe(120000);

    const ng = classifyUpdateFieldsForRestore(
      [csvLog("rosenkaValue", "abc", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(ng[0].status).toBe("skip_type_conversion_failed");
  });

  it("decimal field は文字列のまま restoreValue にする / 数値として無効ならエラー", () => {
    const ok = classifyUpdateFieldsForRestore(
      [csvLog("gpsLat", "35.6895", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(ok[0].status).toBe("restorable");
    expect(ok[0].restoreValue).toBe("35.6895");

    const ng = classifyUpdateFieldsForRestore(
      [csvLog("gpsLat", "not-a-number", COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(ng[0].status).toBe("skip_type_conversion_failed");
  });

  it("oldValue が null なら restoreValue=null で復元可能", () => {
    const out = classifyUpdateFieldsForRestore(
      [csvLog("note", null, COMPLETED_AT - 1000)],
      WINDOW,
    );
    expect(out[0].status).toBe("restorable");
    expect(out[0].restoreValue).toBeNull();
  });
});

describe("classifyUpdateFieldsForRestore — 混合シナリオ", () => {
  it("複数 field を一度に判定できる", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都", COMPLETED_AT - 1000),
        csvLog("propertyType", "land", COMPLETED_AT - 1000),
        csvLog("note", "memo", COMPLETED_AT - 1000),
        nonCsvLog("note", "manual", COMPLETED_AT + 30_000),
        csvLog("rosenkaValue", "120000", COMPLETED_AT - 1000),
        // window 外（古い）
        csvLog("buildingNumber", "old-bn", T0 - 1000),
        // ambiguous
        csvLog("lotNumber", "lot-1", T0 + 1000),
        csvLog("lotNumber", "lot-2", T0 + 2000),
      ],
      WINDOW,
    );
    const byField = Object.fromEntries(out.map((d) => [d.fieldName, d.status]));
    expect(byField.address).toBe("restorable");
    expect(byField.propertyType).toBe("skip_not_restorable_field");
    expect(byField.note).toBe("skip_subsequent_edit");
    expect(byField.rosenkaValue).toBe("restorable");
    expect(byField.buildingNumber).toBe("skip_no_changelog");
    expect(byField.lotNumber).toBe("skip_ambiguous_changelog");
  });

  it("reason 文字列に PII (具体値) を含めない (全 skip 種別)", () => {
    const out = classifyUpdateFieldsForRestore(
      [
        csvLog("address", "東京都千代田区丸の内1-1-1", COMPLETED_AT - 1000),
        nonCsvLog("address", "manual", COMPLETED_AT + 30_000),
      ],
      WINDOW,
    );
    for (const d of out) {
      if (d.reason) {
        expect(d.reason).not.toContain("東京都");
        expect(d.reason).not.toContain("before");
        expect(d.reason).not.toContain("after");
      }
    }
  });
});
