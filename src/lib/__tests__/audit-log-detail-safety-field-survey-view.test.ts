/**
 * audit-log-detail-safety: 巡回（現地調査）の他人閲覧監査 3 action の登録テスト。
 *
 * 「**誰の巡回を・どの権限で・何件**見たか」が監査の本体なのに、キーが allowlist
 * 外で全て [REDACTED] になっていた（@codex #337。session_view / track_view は
 * 総点検P3 以前からの漏れ）。route が実際に書くキー名に一致させる。
 *
 * - sessionId / viewedStaffUserId は UUID 識別子（氏名・住所ではない）
 * - scope は enum（"all" | "staff" | "read_all" | "manage"）
 * - returned / pointsReturned は件数、hasFrom / hasTo は boolean
 * - 氏名・座標・メモは route が detail に載せない（denylist も継続して効く）
 */
import { describe, it, expect } from "vitest";
import { sanitizeAuditDetail, REDACTED } from "@/lib/audit-log-detail-safety";

const STAFF = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

describe("field_survey_session_view（巡回記録の閲覧）", () => {
  it("誰の巡回をどの権限で見たかが残る", () => {
    const out = sanitizeAuditDetail("field_survey_session_view", { sessionId: SESSION, viewedStaffUserId: STAFF, scope: "read_all" }) as Record<string, unknown>;
    expect(out.sessionId).toBe(SESSION);
    expect(out.viewedStaffUserId).toBe(STAFF);
    expect(out.scope).toBe("read_all");
  });
});

describe("field_survey_session_list_view（巡回一覧の閲覧・総点検P3）", () => {
  it("scope / 対象スタッフ / 件数 / ページが残る", () => {
    const out = sanitizeAuditDetail("field_survey_session_list_view", { scope: "all", viewedStaffUserId: null, page: 2, returned: 50 }) as Record<string, unknown>;
    expect(out.scope).toBe("all");
    expect(out.viewedStaffUserId).toBe(null);
    expect(out.page).toBe(2); // ALWAYS_SAFE
    expect(out.returned).toBe(50);
  });

  it("氏名・座標・メモを混ぜても伏せられる（denylist は継続）", () => {
    const out = sanitizeAuditDetail("field_survey_session_list_view", {
        scope: "all",
        returned: 3,
        staffName: "巡回太郎",
        lat: 35.68,
        memo: "私用メモ",
      }) as Record<string, unknown>;
    expect(out.scope).toBe("all");
    expect(out.staffName).toBe(REDACTED);
    expect(out.lat).toBe(REDACTED);
    expect(out.memo).toBe(REDACTED);
  });
});

describe("field_survey_track_view（移動軌跡の閲覧）", () => {
  it("巡回 id / 対象スタッフ / 点数 / 期間指定の有無が残る", () => {
    const out = sanitizeAuditDetail("field_survey_track_view", {
        sessionId: SESSION,
        viewedStaffUserId: STAFF,
        pointsReturned: 120,
        hasFrom: true,
        hasTo: false,
      }) as Record<string, unknown>;
    expect(out.sessionId).toBe(SESSION);
    expect(out.viewedStaffUserId).toBe(STAFF);
    expect(out.pointsReturned).toBe(120);
    expect(out.hasFrom).toBe(true);
    expect(out.hasTo).toBe(false);
  });
});

describe("登録が無い action では保持しない（action 固有 allowlist であること）", () => {
  it("unknown action では同じキーでも [REDACTED]", () => {
    const out = sanitizeAuditDetail("some_unknown_action", { sessionId: SESSION, viewedStaffUserId: STAFF, scope: "all", returned: 5 }) as Record<string, unknown>;
    expect(out.sessionId).toBe(REDACTED);
    expect(out.viewedStaffUserId).toBe(REDACTED);
    expect(out.scope).toBe(REDACTED);
    expect(out.returned).toBe(REDACTED);
  });
});
