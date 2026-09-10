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

  it("読み込み中→失敗→0件→一覧の順で排他的に切り替わる(0件は読み込み完了後にしか出ない)", () => {
    // 三項演算子の連鎖そのものを1つの正規表現で捉え、各文言が「その手前の条件が
    // 成立しなかったときだけ次を評価する」構造になっていることを確認する。
    // これにより、a) 読み込み中に「紐づく物件はありません」が出てしまう実装、
    // b) 失敗時に「紐づく物件はありません」と偽って出してしまう実装、
    // のどちらでも失敗するようにする。
    const chain = src.match(
      /\{!linkedLoaded \? \([^]*?<p[^]*?読み込んでいます[^]*?<\/p>[^]*?\) : linkedFailed \? \([^]*?<p[^]*?<\/p>[^]*?\) : linkedProperties\.length === 0 \? \([^]*?<p[^]*?紐づく物件はありません[^]*?<\/p>[^]*?\) : \(/,
    );
    expect(chain).not.toBeNull();
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
