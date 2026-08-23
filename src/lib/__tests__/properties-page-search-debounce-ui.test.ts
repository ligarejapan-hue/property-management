/**
 * 物件一覧ページの検索入力 (keyword / 管理ID) debounce 化のソース表明テスト。
 *
 * 本プロジェクトの vitest は environment: "node" で jsdom / @testing-library 未導入のため、
 * 既存の properties-page-mgmt-id-ui.test.ts と同様にページソースを文字列として検証する。
 * 実挙動（300ms 経過前は未発火・経過後に1回）の保証は debounce.test.ts が
 * vi.useFakeTimers() で担保し、本テストは「配線が崩れていない」ことを固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);

describe("properties page: 一覧検索 (keyword/管理ID) の debounce 化", () => {
  it("debounce ユーティリティを import している", () => {
    expect(pageSrc).toMatch(/import\s*\{\s*debounce\s*\}\s*from\s*"@\/lib\/debounce"/);
  });

  it("統合ドラフト state (searchAllDraft) を URL 復元値(keyword優先)で初期化する", () => {
    // UI一貫性 第1弾(1): 検索窓を1本に統合した(旧: searchDraft / mgmtIdDraft の2本)。
    expect(pageSrc).toMatch(
      /const \[searchAllDraft, setSearchAllDraft\] = useState\(/,
    );
    expect(pageSrc).toMatch(/sp\.get\("keyword"\)/);
    expect(pageSrc).toMatch(/sp\.get\("mgmtId"\)/);
    // ⚠構文で見分けられない管理IDは接頭辞を付けて復元する(@codex #404 R7 P2:
    //   素の値のまま戻すと、次の編集で text 扱いに落ちて keyword=監査へ流れる)。
    expect(pageSrc).toContain('classifyPropertySearch(mid) === "mgmtId" ? mid : `id:${mid}`');
  });

  it("keyword / 管理ID の確定は**1本の** 300ms debounce で同時に行う", () => {
    // ⚠2本の独立タイマーだと種別またぎの打ち替えで取得が2回走り、広い方の
    //   古い結果が後着で新しい絞り込みを上書きし得る(@codex #404 R8 P1)。
    expect(pageSrc).toMatch(/const commitSearch = useMemo\(/);
    expect(pageSrc).toMatch(
      /debounce\(\(keyword: string, mgmtId: string\) => \{\s*setSearchText\(keyword\);\s*setMgmtIdText\(mgmtId\);\s*setPage\(1\);\s*\}, 300\)/,
    );
    // 旧・2本組は残っていない。
    expect(pageSrc).not.toContain("commitKeyword");
    expect(pageSrc).not.toContain("commitMgmtId");
  });

  it("取得は世代ガードで追い越しを捨てる(@codex #404 R8 P1)", () => {
    expect(pageSrc).toContain("fetchSeqRef");
    // ⚠ガードは**成功側と失敗側の2箇所**(片方だけ消す変異が toContain を
    //   すり抜けた実測があるため、出現数で固定する)。
    const guards = pageSrc.match(/seq !== fetchSeqRef\.current/g) ?? [];
    expect(guards).toHaveLength(2);
    // loading の解除も最新だけが行う(古い決着の早消し防止)。
    expect(pageSrc).toContain("if (seq === fetchSeqRef.current) setLoading(false)");
  });

  it("統合検索欄はドラフト値を表示し、onChange は見分け(classify)経由で処理する", () => {
    expect(pageSrc).toMatch(/value=\{searchAllDraft\}/);
    expect(pageSrc).toMatch(/handleUnifiedSearchChange\(e\.target\.value\)/);
    expect(pageSrc).toMatch(/classifyPropertySearch\(value\)/);
    // 1本コミット: mgmtId のとき keyword は同時に空へ(逆も同様)。
    expect(pageSrc).toContain('commitSearch("", toMgmtIdQuery(value))');
    expect(pageSrc).toContain('commitSearch(kind === "text" ? value : "", "")');
  });

  it("なりかけ(mgmtIdPartial)は確定を保留し、古い確定済み絞り込みも即座に消す", () => {
    // @codex #404 R9(保留) + R10(見えない古い条件を残さない)。
    const at = pageSrc.indexOf('if (kind === "mgmtIdPartial")');
    expect(at).toBeGreaterThan(-1);
    const branch = pageSrc.slice(at, at + 700);
    expect(branch).toContain("commitSearch.cancel()");
    expect(branch).toContain('setSearchText("")');
    expect(branch).toContain('setMgmtIdText("")');
    expect(branch).toContain("setPage(1)");
  });

  it("⚠旧ブックマーク(keyword+mgmtId両方)は見える方(keyword)だけ復元する(@codex #404 R1 P2)", () => {
    expect(pageSrc).toMatch(
      /sp\.get\("keyword"\) \? "" : \(sp\.get\("mgmtId"\) \?\? ""\)/,
    );
  });

  it("入力 onChange からの確定値への即時反映 (handleFilterChange(setSearchText/setMgmtIdText)) を排除している", () => {
    expect(pageSrc).not.toMatch(/handleFilterChange\(setSearchText\)/);
    expect(pageSrc).not.toMatch(/handleFilterChange\(setMgmtIdText\)/);
  });

  it("API・URL同期は確定値 (searchText/mgmtIdText) を使い、draft を直接流さない", () => {
    expect(pageSrc).toMatch(/params\.keyword = searchText/);
    expect(pageSrc).toMatch(/params\.mgmtId = mgmtIdText/);
    expect(pageSrc).toMatch(/params\.set\("keyword", searchText\)/);
    expect(pageSrc).toMatch(/params\.set\("mgmtId", mgmtIdText\)/);
    expect(pageSrc).not.toMatch(/params\.keyword = searchDraft/);
    expect(pageSrc).not.toMatch(/params\.set\("keyword", searchDraft\)/);
  });

  it("リセットでドラフトを空にし、保留中の debounce を cancel する", () => {
    expect(pageSrc).toMatch(/setSearchAllDraft\(""\)/);
    expect(pageSrc).toMatch(/commitSearch\.cancel\(\)/);
  });

  it("アンマウント時に debounce を cancel する cleanup を持つ", () => {
    const at = pageSrc.indexOf("return () => {\n      commitSearch.cancel();");
    expect(at).toBeGreaterThan(-1);
  });
});

describe("所有者検索の構造分離(@codex #404 R1〜R4 P1 の最終形)", () => {
  // 経緯: 自由入力の1本化では「打ち間違えた所有者名(候補0件)の Enter」を
  // 絞り込み(keyword=URL/property_list 監査)から守れなかった(R1→R2→R3→R4 と
  // 塞いでも別の穴が開いた)。→ 経路そのものを分ける:
  //   絞り込み窓 = 住所・地番・管理ID だけ(非PII前提・即時絞り込み)
  //   所有者検索 = 専用の小窓(POST の suggest のみ・keyword へ構造的に流れない)

  it("絞り込み窓の placeholder は所有者・電話を案内しない", () => {
    expect(pageSrc).toMatch(/placeholder="住所・地番・管理ID\(例: 120行, id:◯◯\)で一覧を絞り込み"/);
    expect(pageSrc).not.toMatch(/placeholder="[^"]*所有者[^"]*絞り込み/);
  });

  it("⚠所有者検索の入力(searchInput)は keyword へ一切流れない(構造の固定)", () => {
    // searchInput を setSearchText / commitKeyword に渡す行が存在しないこと。
    expect(pageSrc).not.toMatch(/setSearchText\(\s*searchInput/);
    expect(pageSrc).not.toMatch(/commitKeyword\(\s*searchInput/);
    // 統合ハンドラは suggest(searchInput)に触らない(所有者検索は別経路)。
    const hAt = pageSrc.indexOf("const handleUnifiedSearchChange");
    const hEnd = pageSrc.indexOf("};", hAt);
    const handler = pageSrc.slice(hAt, hEnd);
    expect(handler).not.toContain("setSearchInput");
  });

  it("所有者検索の小窓: 候補が無い Enter は何もしない(打ち間違いを漏らさない)", () => {
    const at = pageSrc.indexOf("所有者名・電話番号で検索");
    expect(at).toBeGreaterThan(-1);
    const block = pageSrc.slice(at, at + 2600);
    expect(block).toContain('if (suggestOpen && suggestResults.length > 0)');
    // Enter 分岐に setSearchText / commitKeyword が無い。
    expect(block).not.toContain("setSearchText");
    expect(block).not.toContain("commitKeyword");
  });

  it("所有者検索は矢印で候補を選べる(キーボード操作)", () => {
    expect(pageSrc).toContain('e.key === "ArrowDown"');
    expect(pageSrc).toContain('e.key === "ArrowUp"');
    expect(pageSrc).toContain('e.key === "Escape"');
    expect(pageSrc).toContain("activeSuggest");
  });

  it("絞り込み窓の text は従来どおり入力しながら即時絞り込み(300ms debounce)", () => {
    const hAt = pageSrc.indexOf("const handleUnifiedSearchChange");
    const hEnd = pageSrc.indexOf("};", hAt);
    const handler = pageSrc.slice(hAt, hEnd);
    expect(handler).toContain('commitSearch(kind === "text" ? value : "", "")');
  });
});
