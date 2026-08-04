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
