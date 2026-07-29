import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// 販売図面の保存・出力・削除が失敗したとき、サーバーが返した**直し方が判る文言**を
// 画面に出す (総点検 2026-07-27)。
//
// 旧実装は `if (!res.ok) throw new Error("保存に失敗しました")` で、API の
// `{ error: { message } }` を丸ごと捨てていた。販売図面の保存は用紙外・画像枚数
// (50枚)・画像サイズ(512KB)・権限で弾かれ、サーバーは
// 「入力内容に問題があります: elements.3.x: …」のように何を直せばよいか判る文言を
// 返しているのに、画面には理由なしの汎用文言しか出ず、同じ操作を繰り返すしかない
// (実質詰む) 状態だった。

const SRC = readFileSync(
  "src/components/sales-sheet/editor/SalesSheetEditor.tsx",
  "utf8",
);

describe("販売図面: 失敗理由をサーバー応答から取り出して表示する", () => {
  it("API の error.message を読むヘルパがある", () => {
    expect(SRC).toContain("async function apiErrorMessage");
    expect(SRC).toContain("body?.error?.message");
  });

  it("保存・出力・削除の3経路すべてで理由文を使う", () => {
    for (const fallback of [
      "保存に失敗しました",
      "出力に失敗しました",
      "削除に失敗しました",
    ]) {
      expect(SRC).toContain(`await apiErrorMessage(res, "${fallback}")`);
    }
  });

  it("503 を固定文言に潰さない（混雑と未準備はサーバの理由文で区別する）", () => {
    // サーバは混雑(RENDER_BUSY=少し待って再実行)と未準備(PDF_UNAVAILABLE=
    // サーバ未設定)を 503 の body で区別して返す。client が status===503 を
    // 先回りして固定文言にすると、数秒で直る混雑まで恒久障害に見える（総点検P3）。
    expect(SRC).not.toContain("PDF生成エンジン未準備");
    expect(SRC).not.toMatch(/status === 503/);
  });

  it("理由が取れないときは従来の汎用文言に倒す", () => {
    // セッション切れで HTML が返る場合など。JSON でなければ fallback。
    expect(SRC).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/);
    expect(SRC).toContain("typeof message === \"string\"");
  });

  it("生のレスポンス本文をそのまま画面に出さない", () => {
    // message フィールドだけを読む (res.text() を UI へ流さない)。
    const helper = SRC.slice(
      SRC.indexOf("async function apiErrorMessage"),
      SRC.indexOf("export function SalesSheetEditor"),
    );
    expect(helper).not.toMatch(/res\.text\(\)/);
    expect(helper).not.toMatch(/JSON\.stringify\(body\)/);
  });

  it("理由文の取得より先にセッション切れ判定を行う (再ログイン案内を優先)", () => {
    // 401/redirect のときは HTML が返るので、先に案内へ倒さないと
    // 「サーバーエラー」等の的外れな文言になる。
    const save = SRC.slice(
      SRC.indexOf("async function handleSave"),
      SRC.indexOf("async function handleExport"),
    );
    expect(save.indexOf("assertAuthedResponse(res)")).toBeLessThan(
      save.indexOf("apiErrorMessage(res"),
    );
  });
});
