/**
 * 復帰時の権限再検証フック(use-permissions-revalidation)の配線固定。@codex #367 P2。
 *
 * 背景: 各画面の「進入時に最大1回」だけでは、開きっぱなしの画面で管理者が権限を剥奪しても
 * 遷移・リロードまで反映されなかった。タブへ復帰したタイミングで裏で取り直すことで追従する。
 *
 * ⚠**画面保護(S1b-2)の enforcement ではない**。S1b-2 は「provider に visibilitychange /
 * blur の監視挙動を持ち込まない」というスコープ線引きをしており、権限鮮度はその関心の外。
 * だからこそ別モジュールに分離しており、このテストは**分離が保たれていること**も固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const HOOK = read("src/components/screen-protection/use-permissions-revalidation.ts");
const PROVIDER = read("src/components/screen-protection/screen-protection-provider.tsx");

describe("復帰時の権限再検証フック", () => {
  it("可視タブのときだけ取り直す(非表示タブでは叩かない)", () => {
    expect(HOOK).toMatch(/if \(document\.visibilityState !== "visible"\) return;/);
  });

  it("直近の取得から一定時間未満なら間引く(タブ切替の連打で叩かない)", () => {
    expect(HOOK).toMatch(/const PERMISSIONS_REVALIDATE_INTERVAL_MS = 60_000;/);
    expect(HOOK).toMatch(
      /const elapsed = Date\.now\(\) - lastLoadedAtRef\.current;/,
    );
    expect(HOOK).toMatch(
      /if \(elapsed >= PERMISSIONS_REVALIDATE_INTERVAL_MS\) \{\s*onRevalidate\(\);\s*return;\s*\}/,
    );
  });

  it("間引いた分は捨てずに残り時間で1回だけ予約する(#367 P2)", () => {
    // 60秒以内に戻ってそのままタブに留まると、離席中の剥奪が次の切替まで反映されない。
    expect(HOOK).toMatch(
      /timerRef\.current = setTimeout\(\(\) => \{\s*timerRef\.current = null;\s*runIfVisible\(\);\s*\}, PERMISSIONS_REVALIDATE_INTERVAL_MS - elapsed\);/,
    );
    // 予約は同時に1本だけ(連打で増やさない)
    expect(HOOK).toMatch(/if \(timerRef\.current !== null\) return;/);
    // 予約実行時にも可視判定をやり直す(裏に回っている間に発火しても叩かない)
    expect(HOOK).toMatch(
      /const runIfVisible = \(\) => \{[\s\S]*?document\.visibilityState !== "visible"[\s\S]*?onRevalidate\(\);\s*\};/,
    );
  });

  it("予約は unmount で必ず解除する(離脱後に叩かない)", () => {
    expect(HOOK).toMatch(
      /if \(timerRef\.current !== null\) \{\s*clearTimeout\(timerRef\.current\);\s*timerRef\.current = null;\s*\}/,
    );
  });

  it("visibilitychange と focus の両方を購読し、unmount で必ず解除する", () => {
    expect(HOOK).toMatch(/document\.addEventListener\("visibilitychange", handler\)/);
    expect(HOOK).toMatch(/window\.addEventListener\("focus", handler\)/);
    expect(HOOK).toMatch(/document\.removeEventListener\("visibilitychange", handler\)/);
    expect(HOOK).toMatch(/window\.removeEventListener\("focus", handler\)/);
  });

  it("SSR で document を触らない", () => {
    expect(HOOK).toMatch(/if \(typeof document === "undefined"\) return;/);
  });

  it("画面保護の関心(透かし・コピー抑止・監査)には触れない=分離が保たれている", () => {
    expect(HOOK).not.toMatch(/watermark/i);
    expect(HOOK).not.toMatch(/overlay/i);
    expect(HOOK).not.toMatch(/bypass/i);
    expect(HOOK).not.toMatch(/audit/i);
    // 取得そのものもしない(呼び出し側から渡された関数を呼ぶだけ)
    expect(HOOK).not.toMatch(/fetch\(/);
  });

  it("provider は背景取得で呼ぶ(復帰のたびにボタンが一瞬消えない)", () => {
    expect(PROVIDER).toMatch(
      /const revalidatePermissions = useCallback\(\(\) => \{\s*loadPermissions\(\{ background: true \}\);\s*\}, \[loadPermissions\]\);/,
    );
    expect(PROVIDER).toMatch(
      /usePermissionsRevalidation\(revalidatePermissions, lastPermissionsLoadRef\);/,
    );
  });

  it("S1b-2 の線引きどおり provider 本体には監視の実体を置かない", () => {
    expect(PROVIDER).not.toMatch(/visibilitychange/);
    expect(PROVIDER).not.toMatch(/addEventListener\(\s*["']blur/);
  });
});
