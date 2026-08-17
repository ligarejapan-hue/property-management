import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 地番検索ダイアログの「一過性の0件」への耐性(2026-08-17 実測)。
 *
 * 同一物件・同一条件で、無料検索が 0件→1件→1件 と揺れることをサイト側で確認した
 * (11:26=1件 / 11:32=0件 / 11:34=1件)。無料検索は**人がもう一度押す**ことで吸収して
 * いるが、有料取得の内部検索には再試行が無く、0件を引いた瞬間に not_found で終わる
 * (実測: 11:35/11:36 の2回連続)。⇒ 有料側にだけ「1回だけ自動で検索し直す」を持たせる。
 *
 * ⚠なぜ走査型か: この揺らぎは実サイトでしか再現せず、fake page では「再試行の存在」を
 * 挙動で固定できない。書き方(再試行の一式が揃っていること・課金境界より前であること)を
 * 検査する。
 */
const SRC = readFileSync(
  join(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("有料取得: ダイアログ0件の1回リトライ", () => {
  it("0件を引いたら1回だけ検索し直す(zeroRetried ループ)", () => {
    expect(SRC).toContain("zeroRetried");
    // 再試行の一式: 閉じる→開き直す→数字種別→**両端**→検索。
    // 片方でも欠けると「開き直したが条件が空」で必ず0件になる。
    const retryAt = SRC.indexOf("zeroRetried = true");
    expect(retryAt).toBeGreaterThan(-1);
    const retryBlock = SRC.slice(retryAt, retryAt + 1600);
    expect(retryBlock).toContain("dialogChibanKaokuListButton");
    expect(retryBlock).toContain("dialogChibanTypeNumeric");
    expect(retryBlock).toContain("dialogChibanRangeStart");
    expect(retryBlock).toContain("dialogChibanRangeEnd");
    expect(retryBlock).toContain("dialogSearch");
    // 実況にも出す(黙って再試行しない)。
    expect(retryBlock).toContain("もう一度だけ検索し直します");
  });

  it("⚠2回目も0件なら画面診断(paid-dialog-zero)を採ってから not_found", () => {
    expect(SRC).toContain('"paid-dialog-zero"');
    const probeAt = SRC.indexOf('"paid-dialog-zero"');
    // 診断 → キャンセル → not_found の順(診断より先に閉じると画面が消える)。
    const after = SRC.slice(probeAt, probeAt + 1400);
    expect(after).toContain("dialogCancel");
    expect(after).toContain('"not_found"');
  });

  it("⚠診断後のキャンセルは期限でレースして見切る(@codex #386 R5/R8)", () => {
    // 診断が予算切れになる原因が「レンダラ無応答」なら、キャンセル(page.evaluate)も
    // 同じ理由で固まる。best-effort のキャンセルを待ち続けて not_found の宣言を
    // 逃さない(sleep は Playwright の Node 側 timeout で終端=レンダラ非依存)。
    // 待ってよい時間は固定500msでなく実測残量から導く(resolveCleanupBound・R8):
    // 残量500ms未満(診断を打たない僅少経路)では待たずに投げる。
    const probeAt = SRC.indexOf('"paid-dialog-zero"');
    const after = SRC.slice(probeAt, probeAt + 2200);
    // キャンセルは撃ちっぱなしで先に発射(待つかどうかは bound 次第)。
    const attemptAt = after.indexOf("const cancelAttempt = domClick");
    expect(attemptAt).toBeGreaterThan(-1);
    const boundAt = after.indexOf("resolveCleanupBound(");
    expect(boundAt).toBeGreaterThan(attemptAt);
    // bound > 0 のときだけレースで待つ。
    const guardAt = after.indexOf("cleanupBoundMs > 0");
    const raceAt = after.indexOf("Promise.race");
    expect(guardAt).toBeGreaterThan(boundAt);
    expect(raceAt).toBeGreaterThan(guardAt);
    const raceBlock = after.slice(raceAt, raceAt + 200);
    expect(raceBlock).toContain("cancelAttempt");
    expect(raceBlock).toContain("sleep(cleanupBoundMs)");
    // レースの後に not_found(=分類が後始末に飲まれない順序)。
    expect(after.indexOf('"not_found"')).toBeGreaterThan(raceAt);
  });

  it("⚠診断の実行は実測残量で決め直し、内部予算も切り詰めて渡す(@codex #386 R4)", () => {
    // 予約(carriedProbe)は計画時点の余裕しか保証しない。開き直しの操作が margin
    // に食い込んだ場合、予約どおり5秒の診断を打つと外側 timeout が先に切れる。
    expect(SRC).toContain("resolveSecondZeroProbe(");
    const at = SRC.indexOf("resolveSecondZeroProbe(");
    const block = SRC.slice(at, at + 500);
    expect(block).toContain("zeroRetried ? carriedProbe : plan.probe");
    expect(block).toContain("probePlan.probe");
    expect(block).toContain("probePlan.budgetMs");
    // logRegistryPageProbe は予算の上書きを受け付ける(既定は従来の固定値)。
    expect(SRC).toContain("budgetMs ?? PAGE_PROBE_BUDGET_MS");
  });

  it("⚠再試行も診断も課金境界(chargeState.charged = true)より前", () => {
    const chargeAt = SRC.indexOf("chargeState.charged = true");
    expect(chargeAt).toBeGreaterThan(-1);
    expect(SRC.indexOf("zeroRetried")).toBeLessThan(chargeAt);
    expect(SRC.indexOf('"paid-dialog-zero"')).toBeLessThan(chargeAt);
  });

  it("⚠2回目の0件は再計画せず、1回目の予約(carriedProbe)で診断を判定する", () => {
    expect(SRC).toContain("carriedProbe = plan.probe");
    expect(SRC).toContain("zeroRetried ? carriedProbe : plan.probe");
  });

  it("⚠待ちは**入れ直しの後・検索を打つ前**に実測残量で確定する(@codex #386 R3/R7)", () => {
    // 計画時点の残量には閉じ→開き直し→入れ直しの操作コスト(セレクタ待ち)が
    // 載っていない。操作の後に resolveRetryWaitAfterSetup で再計算しないと、操作が
    // 食った時間ぶん外側予算を超え、not_found が timeout に化ける(R3)。
    // かつ、確定は**検索クリックより前**: 最低値を割るなら検索自体を打たない(R7)。
    const retryAt = SRC.indexOf("zeroRetried = true");
    const rangeEndAt = SRC.indexOf("dialogChibanRangeEnd", retryAt);
    const resolveAt = SRC.indexOf("resolveRetryWaitAfterSetup", retryAt);
    const searchClickAt = SRC.indexOf("REGISTRY_SELECTORS.dialogSearch", retryAt);
    const continueAt = SRC.indexOf("continue;", retryAt);
    expect(rangeEndAt).toBeGreaterThan(retryAt);
    expect(resolveAt).toBeGreaterThan(rangeEndAt); // 入れ直しの後
    expect(searchClickAt).toBeGreaterThan(resolveAt); // 検索を打つ前に確定
    expect(continueAt).toBeGreaterThan(searchClickAt);
    // 検索クリックと continue は proceed 分岐の中にある(断念時は検索しない)。
    const proceedAt = SRC.indexOf("retryWait.proceed", retryAt);
    expect(proceedAt).toBeGreaterThan(resolveAt);
    expect(searchClickAt).toBeGreaterThan(proceedAt);
    // 診断の予約の有無(plan.probe)を渡す(@codex R9: 診断なし計画では margin を
    // 引かず、存在しない診断のために待ちを削らない)。
    const resolveCall = SRC.slice(resolveAt, resolveAt + 220);
    expect(resolveCall).toContain("plan.probe");
    // 断念時は実況+journal に残す(黙って諦めない)。
    expect(SRC).toContain("検索し直しを断念しました");
    expect(SRC).toContain("zero-retry abandoned");
  });

  it("⚠残量の基準は provider が渡す外側タイマー開始時刻(input.paidDeadlineAt)", () => {
    // adapter 側で env から測り直すとログイン時間ぶん過大評価する(@codex #386 R2)。
    expect(SRC).toContain("input.paidDeadlineAt");
    expect(SRC).not.toMatch(/paidBudgetRaw|REGISTRY_FETCH_TIMEOUT_MS.*paidDeadline/);
    const PROVIDER = readFileSync(
      join(process.cwd(), "src/lib/registry-fetch/official-provider.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    // withPaidTimeout の直前(=外側タイマー開始と同時刻)で deadline を確定して渡す。
    const deadlineAt = PROVIDER.indexOf("paidDeadlineAt =");
    const timerAt = PROVIDER.indexOf("await this.withPaidTimeout(");
    expect(deadlineAt).toBeGreaterThan(-1);
    expect(deadlineAt).toBeLessThan(timerAt);
    expect(PROVIDER).toContain("paidDeadlineAt,");
  });

  it("無料検索側の0件文言は「もう一度」を促す(一時的な0件がある旨)", () => {
    expect(SRC).toMatch(/候補は見つかりませんでした \(0 件\)。[^"]*もう一度/);
  });
});

// 予算配分の挙動テスト(@codex #386 P2: 走査だけでなく挙動で固定する)。
import {
  ZERO_RETRY_MIN_WAIT_MS,
  ZERO_RETRY_NO_PROBE_TAIL_MS,
  ZERO_RETRY_PROBE_CLEANUP_MS,
  ZERO_RETRY_PROBE_MARGIN_MS,
  ZERO_RETRY_PROBE_MIN_MS,
  ZERO_RETRY_SLEEP_MS,
  ZERO_RETRY_TIMER_HEADROOM_MS,
  resolveCleanupBound,
  resolveRetryWaitAfterSetup,
  resolveSecondZeroProbe,
  resolveZeroRetryPlan,
} from "@/lib/registry-fetch/zero-retry-plan";

describe("resolveZeroRetryPlan(残り予算→再試行の可否と待ち時間)", () => {
  it("予算未設定(null)は従来どおりフルで再試行+診断", () => {
    expect(resolveZeroRetryPlan(null)).toEqual({ retry: true, waitMs: 15000, probe: true });
  });

  it("既定の外側30秒: 1回目の待ち後(残り約10秒)でも、切り詰めた待ちで再試行できる", () => {
    const plan = resolveZeroRetryPlan(10000);
    expect(plan.retry).toBe(true);
    expect(plan.waitMs).toBe(10000 - ZERO_RETRY_SLEEP_MS - ZERO_RETRY_PROBE_MARGIN_MS); // 3000
    expect(plan.waitMs).toBeGreaterThanOrEqual(ZERO_RETRY_MIN_WAIT_MS);
    expect(plan.probe).toBe(true);
    // 再試行しても sleep+待ち+診断が残り予算に収まる=外側 timeout に化けない。
    expect(ZERO_RETRY_SLEEP_MS + plan.waitMs + ZERO_RETRY_PROBE_MARGIN_MS).toBeLessThanOrEqual(10000);
  });

  it("⚠2段呼びの自己矛盾を再計画で踏まない(1回目の予約を持ち越す根拠・@codex #386 R2)", () => {
    // 1回目: 残13秒 → 再試行(待ちは 13000-1500-5500=6000)・診断は予約済み。
    const first = resolveZeroRetryPlan(13000);
    expect(first).toEqual({ retry: true, waitMs: 6000, probe: true });
    // sleep+待ちを消費すると、残りは**予約した margin ちょうど**になる。
    const remainingAfter = 13000 - ZERO_RETRY_SLEEP_MS - first.waitMs;
    expect(remainingAfter).toBe(ZERO_RETRY_PROBE_MARGIN_MS);
    // その残量で**再計画すると**、厳密比較(>)が「診断の余裕なし」と誤答する。
    // ⇒ フローは2回目に再計画せず、1回目の予約(probe:true)を持ち越す(carriedProbe)。
    expect(resolveZeroRetryPlan(remainingAfter).probe).toBe(false);
  });

  it("margin は診断の内部予算(5000ms)より大きい=予約したのに途中で切られない", () => {
    expect(ZERO_RETRY_PROBE_MARGIN_MS).toBeGreaterThan(5000);
  });

  it("残りが潤沢なら待ちは15秒で頭打ち", () => {
    expect(resolveZeroRetryPlan(60000).waitMs).toBe(15000);
  });

  it("⚠再試行と診断の両方は入らない残量では、診断を捨てて再試行を優先する(@codex #386 R9)", () => {
    // 残9秒: margin(5500)込みでは待ち2000<3000 で従来は「診断だけ」だった。
    // だが0件は大抵一過性=再試行は候補を見つけ得る/診断は一過性の0件を記録する
    // だけ。診断なし再試行(尻尾750msのみ)なら待ち6750が確保できる。
    const plan = resolveZeroRetryPlan(9000);
    expect(plan).toEqual({
      retry: true,
      waitMs: 9000 - ZERO_RETRY_SLEEP_MS - ZERO_RETRY_NO_PROBE_TAIL_MS, // 6750
      probe: false,
    });
    expect(plan.waitMs).toBeGreaterThanOrEqual(ZERO_RETRY_MIN_WAIT_MS);
    // 総和が予算内(sleep+待ち+尻尾)。
    expect(
      ZERO_RETRY_SLEEP_MS + plan.waitMs + ZERO_RETRY_NO_PROBE_TAIL_MS,
    ).toBeLessThanOrEqual(9000);
  });

  it("診断なし再試行すら入らない残量では再試行しない(見かけだけの再試行を作らない)", () => {
    // 尻尾込みの下限 = SLEEP + MIN_WAIT + NO_PROBE_TAIL = 5250。それ未満は不可。
    const floor =
      ZERO_RETRY_SLEEP_MS + ZERO_RETRY_MIN_WAIT_MS + ZERO_RETRY_NO_PROBE_TAIL_MS;
    expect(resolveZeroRetryPlan(floor).retry).toBe(true); // ちょうど=可(waitMs=MIN)
    expect(resolveZeroRetryPlan(floor - 1).retry).toBe(false);
  });

  it("診断の余裕すら無ければ診断も打たず即分類(timeout に化けるより良い)", () => {
    const plan = resolveZeroRetryPlan(3000);
    expect(plan).toEqual({ retry: false, waitMs: 0, probe: false });
  });
});

describe("resolveRetryWaitAfterSetup(検索を打つ前に待ちを確定・@codex #386 R3/R7/R9)", () => {
  it("操作が食った時間ぶん待ちが縮む(sleep+操作+待ち+診断が予算に収まる)", () => {
    // 残20秒で計画: 待ち13000を予約(=resolveZeroRetryPlan(20000).waitMs)。
    const plan = resolveZeroRetryPlan(20000);
    expect(plan.waitMs).toBe(13000);
    // sleep(1500)+ブラウザ操作(実測3秒)の後の残量=15500。
    const opsCostMs = 3000;
    const remainingAfterOps = 20000 - ZERO_RETRY_SLEEP_MS - opsCostMs;
    const w = resolveRetryWaitAfterSetup(plan.waitMs, remainingAfterOps, plan.probe);
    expect(w.proceed).toBe(true);
    expect(w.waitMs).toBe(remainingAfterOps - ZERO_RETRY_PROBE_MARGIN_MS); // 10000
    // 総和が予算に収まる=操作コストが載っても外側 timeout に化けない。
    expect(
      ZERO_RETRY_SLEEP_MS + opsCostMs + w.waitMs + ZERO_RETRY_PROBE_MARGIN_MS,
    ).toBeLessThanOrEqual(20000);
  });

  it("⚠最低値(3秒)を割る待ちしか残らないなら再試行を**断念**する(@codex #386 R7)", () => {
    // 最低値未満ではサイトの非同期ロードが終わらず、検索を打っても結果が届く前に
    // 分類してしまう=見かけだけの再試行。1〜2999ms の待ちで検索しない。
    expect(resolveRetryWaitAfterSetup(3000, 4500, true)).toEqual({
      proceed: false,
      waitMs: 0,
    });
    expect(resolveRetryWaitAfterSetup(3000, 0, true)).toEqual({
      proceed: false,
      waitMs: 0,
    });
    // 診断なし計画でも同じ(尻尾750を守れなければ断念)。
    expect(resolveRetryWaitAfterSetup(3000, 3700, false)).toEqual({
      proceed: false,
      waitMs: 0,
    });
  });

  it("⚠診断なし計画では margin でなく尻尾(750ms)だけ守る=存在しない診断のために待ちを削らない(@codex #386 R9)", () => {
    // 残9秒の診断なし計画(待ち6750)。setup が2秒食って残量5500になっても、
    // margin(5500)を引いたら 0 で断念になるところ、尻尾(750)なら 4750 で実行できる。
    const plan = resolveZeroRetryPlan(9000);
    expect(plan.probe).toBe(false);
    const w = resolveRetryWaitAfterSetup(plan.waitMs, 5500, plan.probe);
    expect(w).toEqual({ proceed: true, waitMs: 5500 - ZERO_RETRY_NO_PROBE_TAIL_MS }); // 4750
    // 待ち+尻尾が残量内=キャンセル見切り+headroom まで含めて外側に負けない。
    expect(w.waitMs + ZERO_RETRY_NO_PROBE_TAIL_MS).toBeLessThanOrEqual(5500);
  });

  it("実行するなら待ちは必ず最低値以上(遅れて届く結果を待ち切れる)", () => {
    // 境界: 残量= MIN + margin ちょうど → waitMs=MIN で実行。
    const boundary = ZERO_RETRY_MIN_WAIT_MS + ZERO_RETRY_PROBE_MARGIN_MS;
    expect(resolveRetryWaitAfterSetup(15000, boundary, true)).toEqual({
      proceed: true,
      waitMs: ZERO_RETRY_MIN_WAIT_MS,
    });
    for (const reserveProbe of [true, false]) {
      for (const remaining of [boundary, 10000, 60000]) {
        const w = resolveRetryWaitAfterSetup(15000, remaining, reserveProbe);
        if (!w.proceed) continue;
        expect(
          w.waitMs,
          `remaining=${remaining} probe=${reserveProbe}`,
        ).toBeGreaterThanOrEqual(ZERO_RETRY_MIN_WAIT_MS);
        const tail = reserveProbe
          ? ZERO_RETRY_PROBE_MARGIN_MS
          : ZERO_RETRY_NO_PROBE_TAIL_MS;
        expect(w.waitMs + tail).toBeLessThanOrEqual(remaining);
      }
    }
  });

  it("速い操作では計画した待ちをそのまま使う(縮めすぎない)", () => {
    expect(resolveRetryWaitAfterSetup(3000, 60000, true)).toEqual({
      proceed: true,
      waitMs: 3000,
    });
  });

  it("予算未設定(null)は計画値のまま実行", () => {
    expect(resolveRetryWaitAfterSetup(15000, null, true)).toEqual({
      proceed: true,
      waitMs: 15000,
    });
  });
});

describe("resolveSecondZeroProbe(2回目の0件時点で診断の要否と予算を決め直す・@codex #386 R4)", () => {
  it("予約が無傷(残量=margin ちょうど)でも headroom ぶんは譲って打つ(R2の自己矛盾は再導入しない)", () => {
    // 予約どおり残っていても、診断+キャンセルが両方とも上限まで固まる最悪ケースで
    // 外側タイマーと同時刻に並ばないよう、既定予算から headroom を引いた値になる。
    const p = resolveSecondZeroProbe(true, ZERO_RETRY_PROBE_MARGIN_MS);
    expect(p.probe).toBe(true); // 予約が生きていれば必ず打てる(>= 判定)
    expect(p.budgetMs).toBe(
      ZERO_RETRY_PROBE_MARGIN_MS -
        ZERO_RETRY_PROBE_CLEANUP_MS -
        ZERO_RETRY_TIMER_HEADROOM_MS, // 4750
    );
  });

  it("⚠開き直しの操作が margin に食い込んだら、内部予算を切り詰めて打つ(遅い操作+遅い診断でも外側に収まる)", () => {
    // R3 の挙動テストと同じ場面: 操作が4秒食って残量4500(< margin 5500)。
    const p = resolveSecondZeroProbe(true, 4500);
    expect(p.probe).toBe(true);
    expect(p.budgetMs).toBe(
      4500 - ZERO_RETRY_PROBE_CLEANUP_MS - ZERO_RETRY_TIMER_HEADROOM_MS, // 3750
    );
  });

  it("⚠遅い診断+遅いキャンセルの最悪ケースでも締切より headroom 手前で終わる(@codex #386 R6)", () => {
    // 診断が budgetMs を使い切り、キャンセルも上限(CLEANUP)まで固まっても、
    // 合計は残量−HEADROOM 以下=同じ締切で先に登録された外側 soft timer より
    // **必ず先に** not_found の分類へ到達する(等号で負けない)。
    for (const remaining of [ZERO_RETRY_PROBE_MARGIN_MS, 4500, 10000, 2250]) {
      const p = resolveSecondZeroProbe(true, remaining);
      if (!p.probe) continue;
      expect(
        (p.budgetMs ?? 0) + ZERO_RETRY_PROBE_CLEANUP_MS + ZERO_RETRY_TIMER_HEADROOM_MS,
        `remaining=${remaining}`,
      ).toBeLessThanOrEqual(remaining);
    }
  });

  it("意味のある診断すら入らない残量なら諦めて即分類(not_found が timeout に化けるより良い)", () => {
    expect(
      resolveSecondZeroProbe(
        true,
        ZERO_RETRY_PROBE_MIN_MS +
          ZERO_RETRY_PROBE_CLEANUP_MS +
          ZERO_RETRY_TIMER_HEADROOM_MS -
          1,
      ),
    ).toEqual({ probe: false, budgetMs: 0 });
  });

  it("予約が無ければ残量に関わらず打たない(1回目の計画の判断を覆さない)", () => {
    expect(resolveSecondZeroProbe(false, 60000)).toEqual({ probe: false, budgetMs: 0 });
  });

  it("予算未設定(null)は既定の内部予算(上書きなし)", () => {
    expect(resolveSecondZeroProbe(true, null)).toEqual({ probe: true, budgetMs: null });
  });

  it("margin−後始末=診断の既定内部予算(5000ms)と一致する(定数のドリフト検知)", () => {
    expect(ZERO_RETRY_PROBE_MARGIN_MS - ZERO_RETRY_PROBE_CLEANUP_MS).toBe(5000);
  });
});

describe("resolveCleanupBound(分類直前のキャンセルを待ってよい時間・@codex #386 R8)", () => {
  it("残りが潤沢なら既定の後始末予約(500ms)まで待つ", () => {
    expect(resolveCleanupBound(60000)).toBe(ZERO_RETRY_PROBE_CLEANUP_MS);
    expect(resolveCleanupBound(null)).toBe(ZERO_RETRY_PROBE_CLEANUP_MS);
  });

  it("⚠残量500ms未満(診断を打たない僅少経路)では固定500msで待たない", () => {
    // 残300ms: headroom(250)を守って 50ms だけ待つ=外側タイマーより先に分類へ。
    expect(resolveCleanupBound(300)).toBe(300 - ZERO_RETRY_TIMER_HEADROOM_MS);
    // headroom 以下なら待たずに投げる(キャンセルは撃ちっぱなしで試みる)。
    expect(resolveCleanupBound(ZERO_RETRY_TIMER_HEADROOM_MS)).toBe(0);
    expect(resolveCleanupBound(100)).toBe(0);
    expect(resolveCleanupBound(0)).toBe(0);
  });

  it("待つ場合も bound + headroom <= 残量(キャンセルが上限まで固まっても外側に負けない)", () => {
    for (const remaining of [300, 500, 750, 5500, 60000]) {
      const bound = resolveCleanupBound(remaining);
      if (bound === 0) continue;
      expect(bound + ZERO_RETRY_TIMER_HEADROOM_MS, `remaining=${remaining}`).toBeLessThanOrEqual(
        remaining,
      );
    }
  });
});
