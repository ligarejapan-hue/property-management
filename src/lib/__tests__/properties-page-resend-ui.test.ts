/**
 * 物件一覧ページ「再送候補のみ」トグルの source assertion。
 *
 * ⚠この画面はフィルタを **2箇所**(fetch 用 buildFilterParams / URL sync)で組み立てる。
 * 片方に足し忘れると「絞り込めない」または「共有したURLで再現しない」ので、
 * 両方に現れることを別々に固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);

describe("properties page: 再送候補のみトグル", () => {
  it("resendOnly state を URL から初期化する", () => {
    expect(pageSrc).toMatch(/setResendOnly/);
    expect(pageSrc).toMatch(/sp\.get\("resendOnly"\)\s*===\s*"1"/);
  });

  it("fetchProperties のクエリに resendOnly を送る", () => {
    expect(pageSrc).toMatch(/params\.resendOnly\s*=\s*"1"/);
  });

  it("URL query にも resendOnly を sync する", () => {
    expect(pageSrc).toMatch(/params\.set\("resendOnly",\s*"1"\)/);
  });

  it("リセットで resendOnly も消える", () => {
    expect(pageSrc).toMatch(/setResendOnly\(false\)/);
  });

  it("有効フィルタ判定に resendOnly が入っている", () => {
    expect(pageSrc).toMatch(/warningOnly \|\| undeliverableOnly \|\| resendOnly/);
  });

  it("チェックボックスのラベルが「再送候補のみ」", () => {
    expect(pageSrc).toMatch(/再送候補のみ/);
  });

  // トグルの onChange 本体だけを切り出して中身を見る。
  // 文字数の窓(/[\s\S]{0,200}/)で見ると、コメントを1行足しただけで落ちる脆いテストになる
  // (実際に踏んだ)。何が呼ばれるかだけを見れば、書き方が変わっても意図は守れる。
  const toggleHandler = (() => {
    const from = pageSrc.indexOf("setResendOnly(next);");
    const to = pageSrc.indexOf("setPage(1);", from);
    return from < 0 || to < 0 ? "" : pageSrc.slice(from, to);
  })();

  it("切り出したハンドラが本体だけを指している(空振り・広すぎの防止)", () => {
    // ⚠切り出しが壊れて範囲が広がると、handleResetFilters にある同名の呼び出しを
    // 拾って下の2件が素通りする。長さで頭打ちにして空振りを検出する。
    expect(toggleHandler.length).toBeGreaterThan(20);
    expect(toggleHandler.length).toBeLessThan(600);
  });

  it("トグルONで DM状況 を「送る」に合わせる(0件になる組み合わせを画面から作らせない)", () => {
    expect(toggleHandler).toContain('setDmFilter("send")');
  });

  it("トグルONで「未送信(0回)」の絞り込みも解除する(定義上両立しない)", () => {
    // 再送候補は「送付記録が1件以上ある」が条件(設計§4-2)なので、
    // 「未送信(0回)」と併用すると必ず0件になる。画面から作れないようにする。
    expect(toggleHandler).toContain('setSendCountMaxFilter("")');
  });

  it("日数を画面の文言に焼き込んでいない(env で変えられるため)", () => {
    expect(pageSrc).not.toMatch(/90日/);
  });
});
