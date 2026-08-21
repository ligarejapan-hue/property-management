/**
 * 「この物件から外す」/「別の所有者に付け替える」の画面側 source assertion。
 *
 * 背景 (2026-08-21・発注者報告):
 *   「所有者欄の問題あり。追加はできるが、誤って追加した人の削除ができない。」
 *   実測すると**外す機能は存在していた**が、入口が「誤紐づき修正」という名前の
 *   ボタンの中のラジオで、**一度も使われていなかった**(監査ログ 0 件)。
 *   ⇒ 名前で見つけられなかったのが実態。
 *
 * 発注者判断: 「削除と付け替えは別のボタンにしてほしい。事務担当は付け替えだけに」
 *
 * ⚠このリポは jsdom 未導入。クリック挙動は検証できないため、
 *   **入口の存在と権限条件と文言**をソース走査で固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

const pageSrc = read("src/app/(dashboard)/properties/[id]/page.tsx");
const modalSrc = read("src/components/owners/OwnerMislinkModal.tsx");
const apiClientSrc = read("src/lib/api-client.ts");

/**
 * ラベルを含む <button> 要素だけを切り出す。
 * ⚠同じ語はコメントや title にも出るので、**全出現を試して**
 *   「開きタグと閉じタグに挟まれ、間に別の <button> が無い」ものを採る
 *   (最初の1件で決め打ちすると、コメントを掴んで落ちる)。
 */
function buttonContaining(src: string, label: string): string {
  let at = src.indexOf(label);
  expect(at, `ラベルが見つからない: ${label}`).toBeGreaterThan(-1);
  while (at !== -1) {
    const open = src.lastIndexOf("<button", at);
    const close = src.indexOf("</button>", at);
    if (open !== -1 && close !== -1) {
      const el = src.slice(open, close);
      // 開きタグ以降に別の <button> が無い = この要素の中にラベルがある
      if (!el.slice(1).includes("<button")) return el;
    }
    at = src.indexOf(label, at + 1);
  }
  throw new Error(`<button> の中に見つからない: ${label}`);
}

describe("所有者を外す導線", () => {
  it("物件ページに「この物件から外す」ボタンがある", () => {
    expect(pageSrc).toContain("この物件から外す");
  });

  it("api-client に紐付け解除の関数があり、DELETE を送る", () => {
    expect(apiClientSrc).toContain("unlinkPropertyOwner");
    const at = apiClientSrc.indexOf("export async function unlinkPropertyOwner");
    expect(at).toBeGreaterThan(-1);
    const body = apiClientSrc.slice(at, at + 900);
    expect(body).toContain("/owners/${ownerId}");
    expect(body).toContain('method: "DELETE"');
  });

  it("画面もその関数を使う(実装だけあって呼ばれていない、を防ぐ)", () => {
    expect(pageSrc).toContain("unlinkPropertyOwner");
  });

  it("外すボタンは、管理者(user_management:read)にだけ出す", () => {
    // 画面側で管理者かどうかを判定していること。
    expect(pageSrc).toContain("user_management");
    // ⚠**ボタン要素の位置**から遡る。語の初出はコメントなので、そこから
    //   探すと必ず外す(実際に一度落ちた)。
    const btn = buttonContaining(pageSrc, "この物件から外す");
    const btnAt = pageSrc.indexOf(btn);
    expect(btnAt).toBeGreaterThan(-1);
    const guardAt = pageSrc.lastIndexOf("{canRemoveOwnerLink", btnAt);
    expect(
      guardAt,
      "外すボタンが canRemoveOwnerLink で囲われていない",
    ).toBeGreaterThan(-1);
    // 囲いとボタンの間に別のボタンが挟まっていない = この囲いがこのボタンに掛かっている
    expect(pageSrc.slice(guardAt, btnAt)).not.toContain("</button>");
  });

  it("押す前に確認し、何が消えて何が残るかを書く", () => {
    // ⚠「本当に外しますか」だけでは、所有者そのものが消えると誤解される。
    expect(pageSrc).toContain("所有者の情報そのものは残ります");
    expect(pageSrc).toContain("この物件でのメモ");
  });
});

describe("付け替えの導線(名前と役割を1つに)", () => {
  it("ボタン名が「別の所有者に付け替える」になっている", () => {
    expect(pageSrc).toContain("別の所有者に付け替える");
  });

  it("旧名「誤紐づき修正」はボタンの文字として出さない", () => {
    // ⚠この名前だったせいで発注者が「外す」機能を見つけられなかった。
    // 由来をコメントに残すのは有用なので、**表示される要素だけ**を見る。
    const relinkBtn = buttonContaining(pageSrc, "別の所有者に付け替える");
    expect(relinkBtn).not.toContain("誤紐づき修正");
    // モーダルの見出しも新しい名前になっていること。
    expect(modalSrc).toContain("別の所有者に付け替える");
  });

  it("モーダルから「外す」の選択肢を無くす(入口を1つに)", () => {
    expect(modalSrc).not.toContain('value="remove"');
    expect(modalSrc).not.toContain('name="mislink-op"');
    // 切り替えできる状態が残っていると、入口が2か所に戻る。
    expect(modalSrc).not.toContain("setOperation");
  });

  it("モーダルは付け替え専用として operation を送る", () => {
    expect(modalSrc).toContain('"relink"');
  });
});
