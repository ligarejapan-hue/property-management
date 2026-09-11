/**
 * 所有者詳細に「紐づく物件」の一覧が出ることの配線テスト。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  resolve(__dirname, "../[id]/page.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

// コメント(// 行コメント / ブロックコメント・JSXの{/* */}含む)を除いたソース。
// 表示文言まわりのアサーションはこちらを使い、コメント中の開発者語彙
// (「スコープ」「担当外」等、実装の背景説明として書いてあるもの)を
// ユーザー向け文言の検査に巻き込まない。"://" のような文字列内の // は
// 壊さないよう、直前が ":" の // は対象外にする。
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const stripped = stripComments(src);

describe("所有者詳細の紐づく物件一覧", () => {
  it("専用APIを作らず既存の物件一覧APIを所有者で絞って呼ぶ(権限とスコープを継承する)", () => {
    expect(src).toContain('fetchProperties({ ownerId, limit: "20" })');
    expect(src).not.toContain("/api/admin/owners/${ownerId}/properties");
  });

  it("20件を超えたら物件一覧へ逃がす導線を出す(超えているときだけ描画される)", () => {
    // URL は直書きせず共有ヘルパーで組み立てる(所有者補正候補の同種リンクと
    // 食い違わないように1箇所に閉じ込めてある。src/lib/owner-property-link.ts)。
    expect(src).toContain(
      'import { ownerFilteredPropertyListHref } from "@/lib/owner-property-link"',
    );
    expect(src).toContain("href={ownerFilteredPropertyListHref(ownerId)}");
    expect(src).not.toContain("/properties?ownerId=");
    // 「すべて見る」の直前が「(表示済み件数) < (総数)」のガードで閉じていること。
    // 文字列がどこかに存在するだけでは、常時描画するリファクタでも通ってしまうため、
    // ガード式が「すべて見る」を含む JSX ブロックを直接囲んでいることを構造で確認する。
    const moreLinkBlock = src.match(
      /\{linkedLoaded && !linkedFailed && linkedTotal > linkedProperties\.length && \(\s*<Link[\s\S]*?すべて見る[\s\S]*?<\/Link>\s*\)\}/,
    );
    expect(moreLinkBlock).not.toBeNull();
  });

  it("見出しは平易な日本語にする", () => {
    expect(src).toContain("紐づく物件");
  });

  it("読み込み中→失敗→表示範囲外→0件→一覧の順で排他的に切り替わる(各状態は読み込み完了後・手前の条件が不成立のときだけ出る)", () => {
    // 三項演算子の連鎖そのものを1つの正規表現で捉え、各文言が「その手前の条件が
    // 成立しなかったときだけ次を評価する」構造になっていることを確認する。
    // これにより、a) 読み込み中に「紐づく物件はありません」が出てしまう実装、
    // b) 失敗時に「紐づく物件はありません」と偽って出してしまう実装、
    // c) 件数>0なのに一覧が空という第4状態を「0件」に丸めてしまう実装、
    // d) 第4状態の分岐が0件分岐より後(または削除)になっている実装、
    // のどれでも失敗するようにする。コメントを除いた stripped で検査するため、
    // コメント中の語彙がこの構造チェックに紛れ込まない。
    const chain = stripped.match(
      /\{!linkedLoaded \? \([^]*?<p[^]*?読み込んでいます[^]*?<\/p>[^]*?\) : linkedFailed \? \([^]*?<p[^]*?<\/p>[^]*?\) : linkedProperties\.length === 0 && owner\.propertyOwnerCount > 0 \? \([^]*?<p[^]*?<\/p>[^]*?\) : linkedProperties\.length === 0 \? \([^]*?<p[^]*?紐づく物件はありません[^]*?<\/p>[^]*?\) : \(/,
    );
    expect(chain).not.toBeNull();
  });

  it("紐づき物件数>0なのに一覧が空のときは『0件です』とは別の専用文言を出す(件数表示との矛盾を解消する第4状態)", () => {
    // Finding(外部レビュー): 「紐づき物件数」は可視範囲スコープ対象外の件数
    // (owner.propertyOwnerCount)なので、担当外の物件しか無い所有者では
    // 一覧(スコープ済み)が0件でも件数は0より大きいまま出る。その矛盾を
    // 解消するため、"linkedProperties.length === 0 && owner.propertyOwnerCount > 0"
    // という実際の分岐条件に文言を直接紐づけて検査する(文字列がファイルの
    // どこかに存在するだけでは、分岐条件を外してもこのテストは通ってしまうため)。
    const hiddenBlock = stripped.match(
      /: linkedProperties\.length === 0 && owner\.propertyOwnerCount > 0 \? \(\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*\) : linkedProperties\.length === 0 \?/,
    );
    expect(hiddenBlock).not.toBeNull();
    const hiddenMessage = hiddenBlock ? hiddenBlock[1].trim() : "";
    expect(hiddenMessage.length).toBeGreaterThan(0);

    // 「無い」と「見えない」を混同しない(既存の0件文言そのままの流用禁止)。
    expect(hiddenMessage).not.toBe("紐づく物件はありません");
    // 「物件はある」ことが伝わる(0件だと誤読させない)。
    expect(hiddenMessage).toContain("あります");
    // コーディネーター指示: 制限を告げるだけでなく理由も伝える(「担当」の語を使う)。
    // 単なる部分一致ではなく文言全体をピン留めする。
    expect(hiddenMessage).toBe(
      "紐づく物件はありますが、担当範囲外のため表示できません",
    );
    // 開発者語彙("スコープ"・"field_staff"・権限/ロール名)をユーザー文言に出さない。
    expect(hiddenMessage).not.toMatch(
      /スコープ|scope|field_staff|field-staff|権限|ロール|role/i,
    );
    // 画面がすでに出している「紐づき物件数」を超えて、ここで新たに件数(数字)を
    // 語らない(見えない物件の件数を教えない)。
    expect(hiddenMessage).not.toMatch(/[0-9０-９]/);
  });

  it("読み込み中・失敗・表示範囲外・0件・一覧の5状態の文言はすべて異なる", () => {
    const loadingBlock = stripped.match(
      /\{!linkedLoaded \? \(\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>/,
    );
    const failedBlock = stripped.match(
      /: linkedFailed \? \(\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*\) : linkedProperties\.length === 0 && owner\.propertyOwnerCount > 0/,
    );
    const hiddenBlock = stripped.match(
      /: linkedProperties\.length === 0 && owner\.propertyOwnerCount > 0 \? \(\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*\) : linkedProperties\.length === 0 \?/,
    );
    const emptyBlock = stripped.match(
      /: linkedProperties\.length === 0 \? \(\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*\) : \(/,
    );
    for (const block of [loadingBlock, failedBlock, hiddenBlock, emptyBlock]) {
      expect(block).not.toBeNull();
    }
    const texts = [loadingBlock, failedBlock, hiddenBlock, emptyBlock].map(
      (b) => (b ? b[1].trim() : ""),
    );
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("取得に失敗したときは『0件です』と偽らず、失敗と分かる平易な文言を専用に出す", () => {
    // Finding 3: 失敗と「本当に0件」を混同しない。失敗ブロックの中身に成功時の
    // 0件文言(紐づく物件はありません)が紛れ込んでいないことも合わせて確認する。
    const failedBlock = src.match(
      /: linkedFailed \? \(\s*[\s\S]*?<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*\) : linkedProperties\.length === 0/,
    );
    expect(failedBlock).not.toBeNull();
    const failedMessage = failedBlock ? failedBlock[1] : "";
    expect(failedMessage.length).toBeGreaterThan(0);
    expect(failedMessage).not.toContain("紐づく物件はありません");
    // エラーコードやスタックではなく平易な日本語であること(数字・英字の羅列でない)。
    expect(failedMessage).not.toMatch(/^[A-Za-z0-9_.:/-]+$/);
  });

  it("owner が切り替わっても前owner分の一覧を『現在の結果』として出さない(stale表示防止)", () => {
    // Finding 1: 取得結果は「どの ownerId に対する結果か」を保持し、現在の ownerId と
    // 一致するときだけ読み込み完了とみなす。effect 先頭で同期的に state をクリアする
    // 直し方(react-hooks/set-state-in-effect 違反)ではなく、結果側に紐づけて判定する
    // 実装になっていることを確認する。
    expect(src).toContain("loadedForOwnerId");
    expect(src).toContain("linkedResult?.loadedForOwnerId === ownerId");
    // effect の先頭(ownerId ガード直後)で候補state を同期的に空へ戻す典型的な誤答を
    // 検出する: "if (!ownerId) return;" の直後の行が setLinkedResult(null) 等の
    // クリア呼び出しになっていないこと。
    const effectHead = src.match(
      /useEffect\(\(\) => \{\s*if \(!ownerId\) return;\s*([^\n]*)\n/,
    );
    expect(effectHead).not.toBeNull();
    const lineAfterGuard = effectHead ? effectHead[1] : "";
    expect(lineAfterGuard).not.toMatch(/setLinkedResult\(/);
  });

  it("0件のときに何も無いと分かる文言を出す", () => {
    expect(src).toContain("紐づく物件はありません");
  });
});
