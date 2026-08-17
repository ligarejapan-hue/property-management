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
    expect(SRC).toContain('logRegistryPageProbe(page, "paid-dialog-zero")');
    const probeAt = SRC.indexOf('logRegistryPageProbe(page, "paid-dialog-zero")');
    // 診断 → キャンセル → not_found の順(診断より先に閉じると画面が消える)。
    const after = SRC.slice(probeAt, probeAt + 400);
    expect(after).toContain("dialogCancel");
    expect(after).toContain('"not_found"');
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
  ZERO_RETRY_PROBE_MARGIN_MS,
  ZERO_RETRY_SLEEP_MS,
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

  it("再試行の余裕が無い残量では再試行せず、診断だけ打つ", () => {
    const plan = resolveZeroRetryPlan(9000); // waitBudget=2000 < 3000
    expect(plan.retry).toBe(false);
    expect(plan.probe).toBe(true); // 9000 > 5500
  });

  it("診断の余裕すら無ければ診断も打たず即分類(timeout に化けるより良い)", () => {
    const plan = resolveZeroRetryPlan(3000);
    expect(plan).toEqual({ retry: false, waitMs: 0, probe: false });
  });
});
