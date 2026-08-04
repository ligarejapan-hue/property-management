/**
 * 巡回の自動終了（無操作1時間）の純ロジック検証。
 *
 * 発注者決定 (2026-08-03): 巡回終了ボタンを押さずにブラウザから離れても、
 * **無操作1時間で自動的に終了する**。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TRIP_AUTO_END_IDLE_MS,
  autoEndedAt,
  lastActivityAt,
  shouldAutoEndTrip,
  touchTripActivity,
} from "@/lib/field-survey-auto-end";
import {
  REDACTED,
  sanitizeAuditDetail,
} from "@/lib/audit-log-detail-safety";

const MIN = 60 * 1000;
const now = new Date("2026-08-05T12:00:00+09:00");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("閾値は1時間", () => {
  it("発注者決定どおり60分", () => {
    expect(TRIP_AUTO_END_IDLE_MS).toBe(60 * MIN);
  });
});

describe("shouldAutoEndTrip — 終わらせる/終わらせない", () => {
  const base = { status: "active", startedAt: ago(180 * MIN) };

  it("無操作がちょうど1時間で終了する", () => {
    expect(
      shouldAutoEndTrip({ ...base, updatedAt: ago(60 * MIN) }, now),
    ).toBe(true);
  });

  it("59分では終了しない", () => {
    expect(
      shouldAutoEndTrip({ ...base, updatedAt: ago(59 * MIN) }, now),
    ).toBe(false);
  });

  it("⚠active 以外は触らない（終了済み・中止済みを壊さない）", () => {
    for (const status of ["ended", "cancelled"]) {
      expect(
        shouldAutoEndTrip({ status, startedAt: ago(180 * MIN), updatedAt: ago(120 * MIN) }, now),
      ).toBe(false);
    }
  });

  it("⚠開始直後で活動がまだ無い巡回は、開始からの経過で見る", () => {
    // updatedAt が startedAt と同じ（作成直後で一度も活動していない）。
    const justStarted = { status: "active", startedAt: ago(5 * MIN), updatedAt: ago(5 * MIN) };
    expect(shouldAutoEndTrip(justStarted, now)).toBe(false);
    const abandoned = { status: "active", startedAt: ago(90 * MIN), updatedAt: ago(90 * MIN) };
    expect(shouldAutoEndTrip(abandoned, now)).toBe(true);
  });
});

describe("lastActivityAt — 位置記録を使わない巡回でも活動を拾う", () => {
  it("updatedAt が新しければそちらを採る", () => {
    const s = { startedAt: ago(120 * MIN), updatedAt: ago(10 * MIN) };
    expect(lastActivityAt(s)).toEqual(ago(10 * MIN));
  });

  it("⚠startedAt だけで判定しない（撮って登録だけの巡回が開始1時間で切れる）", () => {
    // 2時間前に開始し、10分前に写真からピンを作った巡回。
    // ピン作成は session の updatedAt を動かすので「活動中」と見なせる。
    const photoOnly = { status: "active", startedAt: ago(120 * MIN), updatedAt: ago(10 * MIN) };
    expect(shouldAutoEndTrip(photoOnly, now)).toBe(false);
  });
});

describe("autoEndedAt — 終了時刻は「気づいた時刻」ではなく「最後に活動した時刻」", () => {
  it("最終活動時刻を返す", () => {
    const s = { startedAt: ago(200 * MIN), updatedAt: ago(70 * MIN) };
    expect(autoEndedAt(s)).toEqual(ago(70 * MIN));
  });

  it("⚠日付をまたぐと踏破ヒートの集計日がずれる（now を入れてはいけない）", () => {
    // 23:50 に活動が止まり、翌 0:05 の見回りで終了させるケース。
    const stopped = new Date("2026-08-04T23:50:00+09:00");
    const sweep = new Date("2026-08-05T00:05:00+09:00");
    const ended = autoEndedAt({ startedAt: new Date("2026-08-04T20:00:00+09:00"), updatedAt: stopped });
    expect(ended).toEqual(stopped);
    expect(ended.getTime()).toBeLessThan(sweep.getTime());
  });
});

describe("touchTripActivity — 現場の更新をすべて活動として数える", () => {
  it("active な巡回を更新する", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await touchTripActivity(
      { fieldSurveySession: { updateMany } } as never,
      "sess-1",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "sess-1", status: "active" },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("巡回に紐づかない操作では何もしない", async () => {
    const updateMany = vi.fn();
    await touchTripActivity({ fieldSurveySession: { updateMany } } as never, null);
    await touchTripActivity(
      { fieldSurveySession: { updateMany } } as never,
      undefined,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("⚠終了済みの巡回でも throw しない（事務所で後から直すのは正常な操作）", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(
      touchTripActivity({ fieldSurveySession: { updateMany } } as never, "sess-1"),
    ).resolves.toBeUndefined();
  });

  it("⚠心拍の失敗で本来の操作を壊さない", async () => {
    const updateMany = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      touchTripActivity({ fieldSurveySession: { updateMany } } as never, "sess-1"),
    ).resolves.toBeUndefined();
  });
});

describe("⚠写真追加・ピン編集も活動に数える (@codex #356 P2)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("写真の追加が巡回を更新する", () => {
    // ここが抜けると「撮って登録だけで回る巡回」が1時間で切られる=主動線が壊れる。
    const src = read("src/app/api/field-survey/pins/[id]/photos/route.ts");
    expect(src).toMatch(/touchTripActivity\(tx, owner\?\.sessionId\)/);
  });

  it("ピンの編集が巡回を更新する", () => {
    // 従来は「巡回の紐付けを変えたとき」しか更新していなかった。
    const src = read("src/app/api/field-survey/pins/[id]/route.ts");
    expect(src).toMatch(/touchTripActivity\(tx, nextSessionId\)/);
  });
});

describe("⚠圏外で貯めた記録を失わない (@codex #356 P1)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("自動終了には理由を残す（人が押した終了と区別する）", () => {
    // 区別できないと、復帰後の送信を受け入れてよいか判断できない。
    const route = read("src/app/api/field-survey/sessions/auto-end-run/route.ts");
    expect(route).toMatch(/endReason: TRIP_AUTO_END_REASON/);
  });

  it("自動終了した巡回には、復帰後の位置記録を受け入れる", () => {
    // 圏外では送信できず端末に貯まる。その間は活動が記録されないので無操作
    // 扱いで自動終了され得る。ここで弾くと**歩いた記録がまるごと失われる**。
    const flush = read(
      "src/app/api/field-survey/sessions/[id]/track-points/route.ts",
    );
    expect(flush).toMatch(
      /\{ status: "ended", endReason: TRIP_AUTO_END_REASON \}/,
    );
  });

  it("⚠人が押して終えた巡回には後から足さない", () => {
    // endReason が null のものは従来どおり弾く（意図して終えた巡回を汚さない）。
    const flush = read(
      "src/app/api/field-survey/sessions/[id]/track-points/route.ts",
    );
    // 受け入れ条件は active か「自動終了」のみ。無条件の ended を含めない。
    expect(flush).not.toMatch(/\{ status: "ended" \}/);
  });

  it("列は任意（既存データを壊さない）", () => {
    expect(read("prisma/schema.prisma")).toMatch(
      /endReason\s+String\?\s+@map\("end_reason"\)/,
    );
    expect(
      read("prisma/migrations/20260805020000_add_session_end_reason/migration.sql"),
    ).toMatch(/ADD COLUMN "end_reason" TEXT;/);
  });
});

describe("⚠削除も活動に数える (@codex #356 P2)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("ピンの削除（候補から外す）", () => {
    expect(read("src/app/api/field-survey/pins/[id]/route.ts")).toMatch(
      /touchTripActivity\(prisma, existing\.sessionId\)/,
    );
  });

  it("写真の削除（撮り直し）", () => {
    expect(
      read("src/app/api/field-survey/pins/[id]/photos/[photoId]/route.ts"),
    ).toMatch(/touchTripActivity\(prisma, photo\.pin\?\.sessionId/);
  });
});

describe("⚠合言葉をプロセス一覧に晒さない (@codex #356 P2)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("curl の引数に値を置かない（ps / proc から読めてしまう）", () => {
    const unit = read("deploy/systemd/pm-trip-auto-end.service.example");
    // 値は標準入力へ流し、curl には -H @- で読ませる。
    expect(unit).toMatch(/-H @-/);
    // 展開済みの値を引数に置く形（-H "x-auto-end-secret: ${...}"）を残さない。
    expect(unit).not.toMatch(/-H "x-auto-end-secret: \$\{/);
  });
});

describe("⚠監査画面に実際に残る (@codex #356 P2)", () => {
  it("自動終了の detail が [REDACTED] で消えない", () => {
    // ⚠実行者(userId)を null にしたぶん、detail が全部伏せられると
    // 「誰の巡回が・なぜ・いつ終わったか」が監査から完全に消える。
    const out = sanitizeAuditDetail("field_survey_session_auto_end", {
      sessionId: "11111111-2222-3333-4444-555555555555",
      ownerStaffUserId: "66666666-7777-8888-9999-000000000000",
      reason: "idle_timeout",
      idleMinutes: 60,
      pointCount: 12,
    }) as Record<string, unknown>;
    expect(out.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    // ⚠/owner/i の denylist に当たるので force-safe 側の登録が要る
    expect(out.ownerStaffUserId).toBe("66666666-7777-8888-9999-000000000000");
    expect(out.reason).toBe("idle_timeout");
    expect(out.idleMinutes).toBe(60);
    expect(out.pointCount).toBe(12);
  });

  it("許可していないキーは従来どおり伏せる", () => {
    const out = sanitizeAuditDetail("field_survey_session_auto_end", {
      sessionId: "11111111-2222-3333-4444-555555555555",
      ownerName: "山田太郎",
      memo: "現地メモ",
    }) as Record<string, unknown>;
    expect(out.ownerName).toBe(REDACTED);
    expect(out.memo).toBe(REDACTED);
  });
});

describe("実行口の配線", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");
  const ROUTE = "src/app/api/field-survey/sessions/auto-end-run/route.ts";

  it("未設定なら 503（dormant＝設定するまで何も終了しない）", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/FIELD_SURVEY_AUTO_END_SECRET/);
    expect(src).toMatch(/503, "巡回の自動終了は未設定です"/);
  });

  it("合言葉は timingSafeEqual で比較する", () => {
    expect(read(ROUTE)).toMatch(/timingSafeEqual/);
  });

  it("⚠読んでから書くまでに活動があったら終了させない（競合ガード）", () => {
    // 条件付き更新に、読み取った時点の updatedAt を含めること。
    expect(read(ROUTE)).toMatch(
      /where: \{ id: s\.id, status: "active", updatedAt: s\.updatedAt \}/,
    );
  });

  it("⚠proxy の公開パスに入れる（無いと cron が /login へ飛ばされ実行されない）", () => {
    expect(read("src/proxy.ts")).toMatch(
      /"\/api\/field-survey\/sessions\/auto-end-run"/,
    );
  });

  it("⚠ログ・監査に PII を載せない（件数と識別子だけ）", () => {
    const src = read(ROUTE);
    // console に出すのは件数のみ
    expect(src).toMatch(/scanned=\$\{result\.scanned\}/);
    expect(src).not.toMatch(/console\.\w+\([^)]*memo/);
    // 監査 detail は識別子と件数のみ（座標・メモ・氏名を入れない）
    expect(src).not.toMatch(/detail: \{[\s\S]{0,200}(lat|lng|memo|name)/);
  });
});
