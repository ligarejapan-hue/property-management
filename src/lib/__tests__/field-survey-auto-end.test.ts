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
  settledEndedAt,
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
    expect(src).toMatch(/touchTripActivity\(tx, sid\)/);
  });

  it("⚠巡回から外したときは「外された側」を数える (@codex #356 P2)", () => {
    // 巡回からピンを外す操作では更新後の巡回が null になるため、そのままだと
    // **その巡回の中身を今まさに触っているのに無操作扱い**になり、
    // 1時間の境目では直後に自動終了され得る。付け替えは両方が対象。
    const src = read("src/app/api/field-survey/pins/[id]/route.ts");
    expect(src).toMatch(
      /new Set\(\[nextSessionId, existing\.sessionId\]\)/,
    );
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
      /touchTripActivity\(tx, existing\.sessionId\)/,
    );
  });

  it("写真の削除（撮り直し）", () => {
    expect(
      read("src/app/api/field-survey/pins/[id]/photos/[photoId]/route.ts"),
    ).toMatch(/touchTripActivity\(tx, photo\.pin\?\.sessionId/);
  });

  it("⚠削除と心拍を同じ transaction で行う (@codex #356 P2)", () => {
    // 別々だと、削除が確定してから心拍が走るまでの隙間に見回りが入り込み、
    // **本当に操作しているのに終了させられる**（心拍は 0 行更新で黙って終わる）。
    for (const p of [
      "src/app/api/field-survey/pins/[id]/route.ts",
      "src/app/api/field-survey/pins/[id]/photos/[photoId]/route.ts",
    ]) {
      const src = read(p);
      // 削除（archive / delete）と touch が同じ $transaction の中にある
      expect(src).toMatch(
        /\$transaction\(async \(tx\) => \{[\s\S]{0,600}?touchTripActivity\(tx,/,
      );
      // 心拍が transaction の外（prisma 直）に残っていない
      expect(src).not.toMatch(/touchTripActivity\(prisma,/);
    }
  });
});

describe("settledEndedAt — 終了時刻は「歩いた時刻」(@codex #356 P2)", () => {
  const walked = new Date("2026-08-04T23:40:00Z"); // 深夜に歩き終えた
  const autoEnded = new Date("2026-08-04T23:10:00Z"); // 自動終了した時点

  it("記録の時刻のほうが後なら、そこまで伸ばす", () => {
    // 圏外で貯めた記録が翌日の昼に届いても、終わったのは深夜。
    expect(settledEndedAt(autoEnded, walked)).toEqual(walked);
  });

  it("⚠前には戻さない（記録の抜けで巡回時間を縮めない）", () => {
    const older = new Date("2026-08-04T22:00:00Z");
    expect(settledEndedAt(autoEnded, older)).toEqual(autoEnded);
  });

  it("位置記録を使わない巡回（撮って登録だけ）はそのまま", () => {
    expect(settledEndedAt(autoEnded, null)).toEqual(autoEnded);
  });

  it("終了時刻がまだ無ければ記録の時刻を使う", () => {
    expect(settledEndedAt(null, walked)).toEqual(walked);
    expect(settledEndedAt(null, null)).toBeNull();
  });
});

describe("⚠まだ歩いている人を踏破マップに出さない (@codex #356 P1)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("自動終了後に位置記録が届いたら印を立てる", () => {
    // 踏破マップは「終了した巡回」を全員に見せ、「実行中の巡回」は隠すことで
    // 同僚の現在位置を追えないようにしている。自動終了で終了扱いになった巡回に
    // 位置が届き続けると、この守りを抜ける。
    const src = read(
      "src/app/api/field-survey/sessions/[id]/track-points/route.ts",
    );
    expect(src).toMatch(
      /sess\.status === "ended" \? \{ reconcilePending: true \} : \{\}/,
    );
  });

  it("踏破マップ（マス・線）の両方で除外する", () => {
    // 片方だけ塞いでも意味がない（線のほうが経路として直接的）。
    for (const p of [
      "src/app/api/field-survey/coverage/cells/route.ts",
      "src/app/api/field-survey/coverage/tracks/route.ts",
    ]) {
      // NULL（既存行・通常の終了）は出す = IS NOT TRUE で判定する
      expect(read(p)).toMatch(/AND s\.reconcile_pending IS NOT TRUE/);
    }
  });

  it("⚠外した巡回を必ず戻す（二度歩きを避ける目的を損なわない）", () => {
    // 印を立てるだけで戻す経路が無いと、圏外から復帰した巡回が二度と
    // 踏破マップに出ない。見回りが再び無操作1時間を確認したら外す。
    const src = read("src/app/api/field-survey/sessions/auto-end-run/route.ts");
    expect(src).toMatch(/reconcilePending: true,\s*\n\s*updatedAt: \{ lt: threshold \}/);
    expect(src).toMatch(/data: \{ reconcilePending: false, endedAt \}/);
    // 読んでから書くまでに記録が届いていたら見送る
    expect(src).toMatch(
      /where: \{ id: s\.id, reconcilePending: true, updatedAt: s\.updatedAt \}/,
    );
  });

  it("⚠終了時刻に「届いた時刻」を使わない（両方の経路で）", () => {
    // updatedAt は圏外から復帰して送信できた時刻。これを終了時刻にすると
    // 深夜に歩いた巡回が翌日の昼に終わったことになる。
    for (const p of [
      "src/app/api/field-survey/sessions/auto-end-run/route.ts",
      "src/app/api/field-survey/sessions/[id]/route.ts",
    ]) {
      const src = read(p);
      expect(src).toMatch(/_max: \{ recordedAt: true \}/);
      expect(src).toMatch(/settledEndedAt\(/);
    }
  });

  it("本人が終了ボタンを押したら待たずに戻す", () => {
    // 自動終了した巡回に終了を押すと従来は 409 で何度押しても終われなかった。
    // 1時間の自動終了では日常的に起きるので、成功として扱い踏破マップにも戻す。
    const src = read("src/app/api/field-survey/sessions/[id]/route.ts");
    expect(src).toMatch(/const settlingAutoEnded =/);
    expect(src).toMatch(/reconcilePending: false/);
    // 巡回時間は「押した時刻」ではなく、記録が持つ最後の時刻まで
    expect(src).toMatch(/settlingAutoEnded\s*\n?\s*\? \(settledAt \?\? existing\.updatedAt\)/);
  });
});

describe("⚠自動終了の経路はすべて同じ印を付ける (@codex #356 P2)", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

  it("既存の24時間自動終了にも印を付ける", () => {
    // 印が無いと人が押した終了と区別できず、圏外で貯めた位置記録が
    // 復帰後に捨てられる（見回りが止まっている間はこの経路だけが働く）。
    const src = read("src/app/api/field-survey/sessions/route.ts");
    expect(src).toMatch(/endReason: TRIP_AUTO_END_REASON/);
    expect(src).toMatch(
      /from "@\/lib\/field-survey-auto-end"/,
    );
  });

  it("印の文字列は1か所で定義する", () => {
    // 経路ごとに文字列を書くと、片方だけ直して食い違う。
    for (const p of [
      "src/app/api/field-survey/sessions/route.ts",
      "src/app/api/field-survey/sessions/auto-end-run/route.ts",
      "src/app/api/field-survey/sessions/[id]/track-points/route.ts",
    ]) {
      expect(read(p)).not.toMatch(/endReason: "idle_timeout"/);
    }
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
