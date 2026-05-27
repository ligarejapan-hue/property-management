/**
 * Phase 1-G Pin UI 用 pure helper の単体テスト。
 */
import { describe, it, expect } from "vitest";
import {
  FIELD_SURVEY_PIN_STATUSES,
  PIN_STATUS_LABELS,
  PIN_TYPE_LABELS,
  buildPinPatch,
  formatPinCreatedAt,
  formatPinStatus,
  formatPinType,
  isFieldSurveyPinStatus,
  pinApiErrorMessage,
} from "@/lib/field-survey-pin-util";
import { FIELD_SURVEY_PIN_TYPES } from "@/lib/field-survey-constants";

describe("FIELD_SURVEY_PIN_STATUSES", () => {
  it("server schema の PIN_STATUSES (open/closed/archived) と一致", () => {
    expect(FIELD_SURVEY_PIN_STATUSES).toEqual(["open", "closed", "archived"]);
  });
});

describe("isFieldSurveyPinStatus", () => {
  it("有効な status を受理", () => {
    expect(isFieldSurveyPinStatus("open")).toBe(true);
    expect(isFieldSurveyPinStatus("closed")).toBe(true);
    expect(isFieldSurveyPinStatus("archived")).toBe(true);
  });
  it("無効値を reject", () => {
    expect(isFieldSurveyPinStatus("deleted")).toBe(false);
    expect(isFieldSurveyPinStatus(undefined)).toBe(false);
    expect(isFieldSurveyPinStatus(null)).toBe(false);
    expect(isFieldSurveyPinStatus(1)).toBe(false);
  });
});

describe("formatPinType / PIN_TYPE_LABELS (Plan 承認 4 種)", () => {
  it("4 種すべてに日本語ラベル", () => {
    expect(PIN_TYPE_LABELS.candidate).toBe("物件化候補");
    expect(PIN_TYPE_LABELS.interesting).toBe("要確認");
    expect(PIN_TYPE_LABELS.blocked).toBe("調査不可");
    expect(PIN_TYPE_LABELS.followup).toBe("再確認");
  });

  it("allowlist は server (FIELD_SURVEY_PIN_TYPES) と一致", () => {
    expect([...FIELD_SURVEY_PIN_TYPES]).toEqual([
      "candidate",
      "interesting",
      "blocked",
      "followup",
    ]);
  });

  it("未知の type は素通し (UI で破壊しない)", () => {
    expect(formatPinType("unknown_value")).toBe("unknown_value");
  });

  it("Phase 1-G で禁止された旧候補名を含まない (vacant_house_candidate 等)", () => {
    const labels = Object.keys(PIN_TYPE_LABELS);
    expect(labels).not.toContain("vacant_house_candidate");
    expect(labels).not.toContain("registry_request_candidate");
    expect(labels).not.toContain("follow_up");
    expect(labels).not.toContain("other");
  });
});

describe("formatPinStatus / PIN_STATUS_LABELS", () => {
  it("3 種に日本語ラベル (archived は「アーカイブ」、削除と表記しない)", () => {
    expect(PIN_STATUS_LABELS.open).toBe("未対応");
    expect(PIN_STATUS_LABELS.closed).toBe("対応済み");
    expect(PIN_STATUS_LABELS.archived).toBe("アーカイブ");
  });

  it("archived ラベルに「削除」を含めない", () => {
    expect(PIN_STATUS_LABELS.archived).not.toMatch(/削除/);
    expect(formatPinStatus("archived")).not.toMatch(/削除/);
  });

  it("未知の status は素通し", () => {
    expect(formatPinStatus("future_state")).toBe("future_state");
  });
});

describe("buildPinPatch (空 patch 抑止)", () => {
  const original = {
    pinType: "candidate",
    status: "open",
    memo: "memo body" as string | null,
  };

  it("全フィールド未変化なら null", () => {
    expect(buildPinPatch(original, original)).toBeNull();
  });

  it("pinType のみ変化", () => {
    expect(buildPinPatch(original, { ...original, pinType: "blocked" })).toEqual(
      { pinType: "blocked" },
    );
  });

  it("status のみ変化", () => {
    expect(buildPinPatch(original, { ...original, status: "closed" })).toEqual({
      status: "closed",
    });
  });

  it("memo を空文字に変える / null にする", () => {
    expect(buildPinPatch(original, { ...original, memo: "" })).toEqual({
      memo: "",
    });
    expect(buildPinPatch(original, { ...original, memo: null })).toEqual({
      memo: null,
    });
  });

  it("memo を null → 文字列", () => {
    const o = { ...original, memo: null };
    expect(buildPinPatch(o, { ...o, memo: "x" })).toEqual({ memo: "x" });
  });

  it("memo は null と '' を別物として扱う", () => {
    // 「同じ memo を再保存」した場合は patch null になることをガード
    const a: typeof original = { ...original, memo: "" };
    const b: typeof original = { ...original, memo: null };
    expect(buildPinPatch(a, b)).toEqual({ memo: null });
    expect(buildPinPatch(b, a)).toEqual({ memo: "" });
  });

  it("複数フィールド変化", () => {
    expect(
      buildPinPatch(original, {
        pinType: "blocked",
        status: "closed",
        memo: "new",
      }),
    ).toEqual({ pinType: "blocked", status: "closed", memo: "new" });
  });

  it("propertyId / sessionId / lat / lng などのキーは含まない", () => {
    const patch = buildPinPatch(original, { ...original, pinType: "blocked" });
    expect(patch).not.toBeNull();
    const keys = Object.keys(patch!);
    expect(keys).not.toContain("propertyId");
    expect(keys).not.toContain("sessionId");
    expect(keys).not.toContain("lat");
    expect(keys).not.toContain("lng");
  });
});

describe("pinApiErrorMessage", () => {
  it("各 status に汎用文言 (座標 / 内部 message を含めない)", () => {
    const cases = [401, 403, 404, 409, 422, 500, 502, 599, 418];
    for (const s of cases) {
      const msg = pinApiErrorMessage(s);
      expect(msg).not.toMatch(/lat|lng|AIza|sequence/i);
      expect(msg).not.toMatch(/\d{3}/); // 内部 status code を表に出さない
    }
  });

  it("401 は再ログイン文言", () => {
    expect(pinApiErrorMessage(401)).toMatch(/ログイン/);
  });
  it("403 は権限文言", () => {
    expect(pinApiErrorMessage(403)).toMatch(/権限/);
  });
  it("404 は not found 文言", () => {
    expect(pinApiErrorMessage(404)).toMatch(/見つかりません/);
  });
  it("422 は入力エラー文言", () => {
    expect(pinApiErrorMessage(422)).toMatch(/入力内容/);
  });
  it("5xx は server error 文言", () => {
    expect(pinApiErrorMessage(503)).toMatch(/サーバー/);
  });
  it("その他は汎用失敗文言", () => {
    expect(pinApiErrorMessage(418)).toMatch(/失敗/);
  });
});

describe("formatPinCreatedAt", () => {
  it("ISO string を YYYY-MM-DD HH:MM 表記に整形", () => {
    const out = formatPinCreatedAt("2026-05-28T03:45:00.000Z");
    // ローカルタイムに依存するため厳密値は固定しないが、形式だけ検証
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it("Date オブジェクトを受け入れる", () => {
    const d = new Date(2026, 4, 28, 14, 7); // 2026-05-28 14:07 local
    expect(formatPinCreatedAt(d)).toBe("2026-05-28 14:07");
  });
  it("不正値は空文字", () => {
    expect(formatPinCreatedAt("not a date")).toBe("");
    expect(formatPinCreatedAt(new Date(NaN))).toBe("");
  });
});
