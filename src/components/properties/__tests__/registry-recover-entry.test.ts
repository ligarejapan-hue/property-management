import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 「取得済みの謄本を取り込む（課金なし）」の入口。
 *
 * 発注者指示(2026-08-21): **取り込みは「所在で謄本を検索」の流れに組み込む**。
 * 検索の流れの中には既に「候補を選ぶ → 取得する（有料）／取得済みを取り込む（課金なし）」の
 * 2択があるので、ボタンの下に独立して置いていたリンクは**出さない**。
 *
 * ⚠ただし**検索そのものが使えない設定のとき**は、リンクを消すと買った書類に手が届かなくなる
 *   （謄本には取得期限があるので実害になる）。その場合だけ入口を残す。
 * ⚠このリポは jsdom 未導入のため source-assertion で配線を固定する。改行は LF に正規化。
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "registry-location-search-button.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("取り込みの入口は検索の流れに一本化する", () => {
  it("検索が使えるときは独立したリンクを出さない", () => {
    // 旧: {showButton && recoverConfigured && ( ... )} が常に出ていた。
    expect(src).not.toContain("{showButton && recoverConfigured && (");
  });

  it("検索が使えないときだけ入口を残す(買った書類に手が届かなくならない)", () => {
    expect(src).toContain("providerDisabled && recoverConfigured");
  });

  it("検索の流れの中の2択は残っている(ここが本来の導線)", () => {
    expect(src).toContain("取得する（有料）");
    expect(src).toContain("取得済みを取り込む（課金なし）");
  });
});
