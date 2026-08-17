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

  it("無料検索側の0件文言は「もう一度」を促す(一時的な0件がある旨)", () => {
    expect(SRC).toMatch(/候補は見つかりませんでした \(0 件\)。[^"]*もう一度/);
  });
});
