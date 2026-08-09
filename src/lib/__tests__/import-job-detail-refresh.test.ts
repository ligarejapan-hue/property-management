/**
 * 取込ジョブ詳細画面の再取得(refresh)でちらつかせない配線。
 *
 * 症状: 行を1件解決するたびに `fetchJob()` が `setLoading(true)` するため、
 * `if (loading) return <spinner/>` の早期 return が発火して**画面全体が消える**。
 * 「要確認」行を数十件まとめて捌く作業でそのたびに視界が飛ぶ。
 *
 * 規約: 全画面スピナーは**初回読み込みのときだけ**。データを持っている状態での
 * 再取得は画面を保ったまま行い、操作の抑止は既存の `disabled={loading}` に任せる
 * (行ごとの進捗は actionLoading が別に出している)。
 *
 * vitest は env=node(jsdom 無し)のため、ここではソース配線を固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("src/app/(dashboard)/import/jobs/[jobId]/page.tsx");

describe("取込ジョブ詳細: 再取得でちらつかせない", () => {
  it("全画面スピナーの早期 return は初回読み込み限定(データがある間は出さない)", () => {
    // `if (loading) {` の裸の形は、再取得のたびに画面を消すので禁止。
    expect(PAGE).not.toMatch(/\n\s*if \(loading\) \{/);
    // 初回=まだ job を持っていないときだけ全画面スピナー。
    expect(PAGE).toMatch(/if \(loading && !job\) \{/);
  });

  it("再取得中も操作は抑止されたまま(二重送信の防止は維持)", () => {
    // ページ送り等の disabled={loading} は残す(早期 return が無くなった分、
    // ここが操作抑止の唯一の担保になる)。
    expect(PAGE).toMatch(/disabled=\{loading\}/);
    expect(PAGE).toMatch(/disabled=\{!job\.pagination\.hasNextPage \|\| loading\}/);
  });

  it("ステータスタブも再取得中は押せない(古い応答での上書きを防ぐ)", () => {
    // 早期 return を初回限定にしたことで「画面ごと消える」暗黙のガードが無くなった。
    // タブだけ素通しだと fetchJob が in-flight のまま2本目が走り、先に解決した古い
    // 応答が job を上書きして「選択中のタブと表示行が食い違う」ことがある。
    // onClick から タブ見出しの描画までが1つのタブ button の属性範囲。
    const start = PAGE.indexOf("onClick={() => changeFilter(tab.key)}");
    const end = PAGE.indexOf("{tab.label}", start);
    expect(start, "フィルタタブの onClick が見つからない").toBeGreaterThan(-1);
    expect(end, "タブ見出しの描画が見つからない").toBeGreaterThan(start);
    expect(PAGE.slice(start, end)).toMatch(/disabled=\{loading\}/);
  });

  it("行ごとの操作には別の進捗表示がある(再取得が静かでも無反応に見えない)", () => {
    expect(PAGE).toMatch(/actionLoading/);
    // どの行を処理中かは従来どおり見せる(スピナー表示は行固有のまま)
    expect(PAGE).toMatch(/const isLoading = actionLoading === row\.id;/);
    expect(PAGE).toMatch(/\{isLoading \? \(/);
  });

  it("書き込み操作は「いずれかの処理中・再取得中」で全て止まる(二重作成の防止)", () => {
    // @codex #367 P1: 行ごとの disabled が `actionLoading === row.id` だけだと、
    // A行の処理中にB行を押せ、A の finally が共有 actionLoading を null に戻した
    // 瞬間に B のリクエストが飛んだままB が再び押せる(create_new が2件作られ得る)。
    expect(PAGE).toMatch(
      /const mutationLocked = actionLoading !== null \|\| loading;/,
    );
    // 行操作・一括操作の disabled は全て mutationLocked に統一されている
    expect(PAGE).not.toMatch(/disabled=\{isLoading\}/);
    expect(PAGE).not.toMatch(/disabled=\{actionLoading === "batch"\}/);
    const locked = PAGE.match(/disabled=\{mutationLocked\}/g) ?? [];
    expect(locked.length).toBeGreaterThanOrEqual(8);
  });

  it("再取得の失敗は従来どおり画面に出す(黙って古い表示を残さない)", () => {
    expect(PAGE).toMatch(/if \(error \|\| !job\) \{/);
  });
});
