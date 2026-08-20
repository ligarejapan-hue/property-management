import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 売却DM設定画面の「使える/使えない」案内が、**サーバーの判定と食い違わない**こと。
 *
 * 背景: 実績91で AI直結の生成を廃止したのに、画面だけが「AI種別＋APIキー」を要求し続け、
 * **使えるのに「使えません」と表示**していた（管理者が不要な有料API契約に進みかねない）。
 * 原因は同じ規則を画面とサーバーに別々に書いたこと。⇒ 判定は純関数1本に集約し、
 * 両方がそれを使うことをここで固定する。
 * ⚠このリポは jsdom 未導入のため、画面は source-assertion で固定する。
 * ⚠改行は LF に正規化（手元 CRLF と CI で判定が変わるため）。
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(dir, "..", "..");
const PAGE = read(
  join(SRC, "app", "(dashboard)", "admin", "sale-dm-settings", "page.tsx"),
);
const PERMISSIONS_ROUTE = read(
  join(SRC, "app", "api", "me", "permissions", "route.ts"),
);

describe("売却DM設定画面の案内がサーバーの判定と食い違わない", () => {
  it("画面もサーバーも同じ判定（純関数）を使う", () => {
    expect(PAGE).toContain("isSaleDmPrintReady");
    expect(PERMISSIONS_ROUTE).toContain("isSaleDmPrintReady");
  });

  it("⚠画面の有効判定に AI種別・APIキーを混ぜない（今回の誤表示の原因）", () => {
    expect(PAGE).not.toContain("providerKeyOk");
    // 「使えない」ときの案内文にも API キーを持ち出さない。
    expect(PAGE).not.toContain("AI種別+APIキー");
  });

  it("不足項目の案内は純関数から作る（画面に条件を書き写さない）", () => {
    expect(PAGE).toContain("missingSaleDmPrintRequirements");
  });

  it("⚠もう要求されない権限を勧めない（sale_dm:generate は外部AI方式で不要）", () => {
    expect(PAGE).not.toContain("売却促進DMのAI生成");
    // 実際に要るのは物件情報の編集権限（route-guard の requireSaleDmWriteAccess）。
    expect(PAGE).toContain("物件情報の編集");
  });

  it("AIの種類・APIキーの欄は残すが、使っていないことを明記する", () => {
    // 欄自体を消すかは別判断。残す以上、埋めなくてよいと分かる必要がある
    //（分からないと不要な有料API契約に進みかねない）。
    expect(PAGE).toContain("現在の運用では使いません");
  });
});
