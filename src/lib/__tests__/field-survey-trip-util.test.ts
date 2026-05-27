/**
 * Phase 1-F-1 巡回 UI 用 pure helper の単体テスト。
 * - エラー応答振り分け
 * - elapsed フォーマッタ
 * - active session の own pick
 */
import { describe, it, expect } from "vitest";
import {
  classifyTripApiResponse,
  extractApiErrorCode,
  formatElapsed,
  pickOwnActiveSession,
  tripOutcomeMessage,
} from "@/lib/field-survey-trip-util";

describe("classifyTripApiResponse", () => {
  it("2xx は ok", () => {
    expect(classifyTripApiResponse(200).kind).toBe("ok");
    expect(classifyTripApiResponse(201).kind).toBe("ok");
    expect(classifyTripApiResponse(299).kind).toBe("ok");
  });

  it("401 は auth_required", () => {
    expect(classifyTripApiResponse(401).kind).toBe("auth_required");
  });

  it("403 は forbidden", () => {
    expect(classifyTripApiResponse(403).kind).toBe("forbidden");
  });

  it("409 + ACTIVE_SESSION_EXISTS は conflict_active", () => {
    expect(
      classifyTripApiResponse(409, "ACTIVE_SESSION_EXISTS").kind,
    ).toBe("conflict_active");
  });

  it("409 + INVALID_STATE は conflict_state", () => {
    expect(classifyTripApiResponse(409, "INVALID_STATE").kind).toBe(
      "conflict_state",
    );
  });

  it("409 + 不明 code は conflict_state (安全側)", () => {
    expect(classifyTripApiResponse(409, undefined).kind).toBe(
      "conflict_state",
    );
    expect(classifyTripApiResponse(409, null).kind).toBe("conflict_state");
    expect(classifyTripApiResponse(409, "OTHER").kind).toBe("conflict_state");
  });

  it("400 / 422 は validation", () => {
    expect(classifyTripApiResponse(400).kind).toBe("validation");
    expect(classifyTripApiResponse(422).kind).toBe("validation");
  });

  it("5xx は server_error", () => {
    expect(classifyTripApiResponse(500).kind).toBe("server_error");
    expect(classifyTripApiResponse(503).kind).toBe("server_error");
    expect(classifyTripApiResponse(599).kind).toBe("server_error");
  });

  it("他は unknown", () => {
    expect(classifyTripApiResponse(304).kind).toBe("unknown");
    expect(classifyTripApiResponse(418).kind).toBe("unknown");
  });
});

describe("tripOutcomeMessage", () => {
  it("各 outcome に汎用文言を返す (PII / 内部 message は含めない)", () => {
    const ar = tripOutcomeMessage({ kind: "auth_required" });
    expect(ar).toContain("ログイン");
    const fb = tripOutcomeMessage({ kind: "forbidden" });
    expect(fb).toContain("権限");
    const ca = tripOutcomeMessage({ kind: "conflict_active" });
    expect(ca).toContain("再取得");
    const cs = tripOutcomeMessage({ kind: "conflict_state" });
    expect(cs).toContain("状態");
    expect(tripOutcomeMessage({ kind: "server_error" })).toContain("サーバー");
    expect(tripOutcomeMessage({ kind: "validation" })).toContain("不正");
    expect(tripOutcomeMessage({ kind: "ok" })).toBe("");
  });

  it("汎用文言に lat / lng / API key / 内部 message を含めない", () => {
    for (const kind of [
      "auth_required",
      "forbidden",
      "conflict_active",
      "conflict_state",
      "validation",
      "server_error",
      "unknown",
    ] as const) {
      const msg = tripOutcomeMessage({ kind });
      expect(msg).not.toMatch(/lat/i);
      expect(msg).not.toMatch(/lng/i);
      expect(msg).not.toMatch(/AIza/);
      expect(msg).not.toMatch(/INTERNAL_/);
    }
  });
});

describe("extractApiErrorCode", () => {
  it("body.error.code を抽出", () => {
    expect(
      extractApiErrorCode({ error: { message: "x", code: "ACTIVE_SESSION_EXISTS" } }),
    ).toBe("ACTIVE_SESSION_EXISTS");
  });

  it("形式が違うと null", () => {
    expect(extractApiErrorCode(null)).toBeNull();
    expect(extractApiErrorCode(undefined)).toBeNull();
    expect(extractApiErrorCode("plain")).toBeNull();
    expect(extractApiErrorCode({})).toBeNull();
    expect(extractApiErrorCode({ error: null })).toBeNull();
    expect(extractApiErrorCode({ error: {} })).toBeNull();
    expect(extractApiErrorCode({ error: { code: 123 } })).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("経過 0 は 00:00:00", () => {
    const t = new Date("2026-05-27T12:00:00.000Z");
    expect(formatElapsed(t, t)).toBe("00:00:00");
  });

  it("1 時間 2 分 3 秒は 01:02:03", () => {
    const s = new Date("2026-05-27T12:00:00.000Z");
    const e = new Date(s.getTime() + (1 * 3600 + 2 * 60 + 3) * 1000);
    expect(formatElapsed(s, e)).toBe("01:02:03");
  });

  it("24 時間超は 25:00:00 のように 3 桁表示は 2 桁ベースで継続", () => {
    const s = new Date("2026-05-27T12:00:00.000Z");
    const e = new Date(s.getTime() + 25 * 3600 * 1000);
    expect(formatElapsed(s, e)).toBe("25:00:00");
  });

  it("負時間 / 非有限は 00:00:00", () => {
    const s = new Date("2026-05-27T12:00:00.000Z");
    const earlier = new Date(s.getTime() - 1000);
    expect(formatElapsed(s, earlier)).toBe("00:00:00");
  });
});

describe("pickOwnActiveSession", () => {
  const u = "u-self";
  const session = (overrides: Partial<{
    id: string;
    staffUserId: string;
    status: string;
    startedAt: string;
  }> = {}) => ({
    id: overrides.id ?? "s",
    staffUserId: overrides.staffUserId ?? u,
    status: overrides.status ?? "active",
    startedAt: overrides.startedAt ?? "2026-05-27T12:00:00.000Z",
    endedAt: null,
    memo: null,
    pointCount: 0,
  });

  it("自分の active session 1 件を返す", () => {
    const r = pickOwnActiveSession([session({ id: "s1" })], u);
    expect(r?.id).toBe("s1");
  });

  it("他人 staffUserId は無視", () => {
    const r = pickOwnActiveSession(
      [session({ id: "s-other", staffUserId: "u-other" })],
      u,
    );
    expect(r).toBeNull();
  });

  it("status が active 以外は無視", () => {
    const r = pickOwnActiveSession([session({ id: "s", status: "ended" })], u);
    expect(r).toBeNull();
  });

  it("複数 own active は startedAt 最新を採用", () => {
    const r = pickOwnActiveSession(
      [
        session({ id: "old", startedAt: "2026-05-27T10:00:00.000Z" }),
        session({ id: "new", startedAt: "2026-05-27T12:00:00.000Z" }),
        session({ id: "mid", startedAt: "2026-05-27T11:00:00.000Z" }),
      ],
      u,
    );
    expect(r?.id).toBe("new");
  });

  it("空 / null / undefined は null", () => {
    expect(pickOwnActiveSession([], u)).toBeNull();
    expect(pickOwnActiveSession(null, u)).toBeNull();
    expect(pickOwnActiveSession(undefined, u)).toBeNull();
  });
});
