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

describe("土地/建物の選択は流れの中に残す(@codex #398 R1 P1)", () => {
  it("判断は純関数に渡す(画面に条件を書き写さない)", () => {
    expect(src).toContain("hasBothIdentifiers,");
    expect(src).toContain("resolveRecoverEntry({");
  });

  it("⚠『どちらを取り込みますか』は候補を選んだ後でも出る", () => {
    // 候補あり分岐(selected ? ( ... )) の中だけに置くと、検索から入った人は選べない。
    const start = src.indexOf("{selected ? (");
    const elseAt = src.indexOf(") : (", start);
    expect(start).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(start);
    const candidateBranch = src.slice(start, elseAt);
    expect(candidateBranch).not.toContain("どちらを取り込みますか");
    // ⚠**三項(候補あり/なし)の外**にあること。片方の分岐に置くと、もう片方から
    //   入った人は選べない(=買った方の謄本に手が届かない)。
    // ⚠エスケープを使わずに改行を作る(この環境ではバックスラッシュが失われることがある)。
    const LF = String.fromCharCode(10);
    const ternaryEnd = src.indexOf("</>" + LF + "          )}", elseAt);
    const both = src.indexOf("{hasBothIdentifiers && (");
    const kindFieldset = src.indexOf("取得する種類");
    expect(ternaryEnd).toBeGreaterThan(elseAt);
    expect(both).toBeGreaterThan(ternaryEnd);
    expect(both).toBeLessThan(kindFieldset);
  });
});
