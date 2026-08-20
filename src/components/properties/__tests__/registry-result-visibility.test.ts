import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 謄本の取得・取り込みの「結果が画面に出る」ことを固定する走査型テスト。
 *
 * 背景(2026-08-20): 本番で回収に成功したのに、発注者は『取り込めていない』と認識した。
 * 原因は通知の不足ではなく **画面が更新されないこと**:
 *   - 添付ファイルタブは「開いた瞬間に一度だけ」読み込む作りで、タブを開いたまま
 *     取り込んでも一覧が読み直されない。
 *   - 更新手段が「ページ全体を読み込み中に差し替える取り直し」しか無く、成功直後に
 *     呼ぶと **実況パネルごと消える**(@codex #380 R3 P2)ため呼べなかった。
 * ⇒ 「全体を作り直さずに、必要な2か所だけ静かに更新する」を配線として固定する。
 *
 * 発注者指示(2026-08-20): **成功時に通知は出さない**(画面が最新化されれば足りる)。
 *                          **失敗したときだけ**見落とせない形で知らせる。
 *
 * ⚠このリポは jsdom/RTL 未導入のため source-assertion で配線を固定する。
 * ⚠改行は LF に正規化する(手元 CRLF と CI で判定が変わるため)。
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const dir = dirname(fileURLToPath(import.meta.url));
const BUTTON = read(join(dir, "..", "registry-location-search-button.tsx"));
const ATTACH = read(join(dir, "..", "attachment-tab.tsx"));
const PAGE = read(
  join(dir, "..", "..", "..", "app", "(dashboard)", "properties", "[id]", "page.tsx"),
);

describe("謄本の結果が画面に出る(2026-08-20 の誤解の再発防止)", () => {
  it("成功したら『静かな更新』の合図を出す(有料取得・課金なしの回収の両方)", () => {
    const calls = BUTTON.match(/onRegistryResultApplied\(\)/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("成功しても画面を作り直す取り直しは呼ばない(実況の見返しが消える回帰)", () => {
    // onPropertyRefresh() は reset()(=閉じるとき)の 1 か所だけであること。
    const calls = BUTTON.match(/onPropertyRefresh\(\)/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("合図の口は任意ではなく必須(配線を忘れても型で気づけない事故を防ぐ)", () => {
    expect(BUTTON).toContain("onRegistryResultApplied: () => void;");
  });

  it("失敗は見落とせない帯にして、その場まで自動でスクロールする", () => {
    expect(BUTTON).toContain('role="alert"');
    expect(BUTTON).toContain("scrollIntoView");
  });

  it("添付ファイルタブは合図で一覧だけを読み直す(タブを開いたままでも増える)", () => {
    expect(ATTACH).toContain("refreshToken");
    expect(ATTACH).toContain("{ silent: true }");
  });

  it("合図での取り直しは一覧を『読み込み中』に差し替えない(表が消えてちらつく)", () => {
    expect(ATTACH).toContain("if (!options?.silent) setLoading(true);");
  });

  it("物件ページは合図を添付タブと謄本ブロックの両方へ配る", () => {
    expect(PAGE).toContain("attachmentsRefreshToken");
    expect(PAGE).toContain("onRegistryResultApplied={");
    expect(PAGE).toContain("refreshToken={attachmentsRefreshToken}");
  });

  it("通常の取り直しは、どんな場合でも『読み込み中』を解除する", () => {
    // ⚠実装中に一度踏んだ罠: 世代ガード(後着勝ち)を finally にも掛けると、
    //   通常の取り直しの最中に静かな取り直しが割り込んだとき、
    //   **誰も loading を false に戻せず**画面が「読み込み中」から抜けられなくなる
    //   (静かな取り直しは loading を触らない設計のため)。
    //   世代ガードは「中身の上書き」(setProperty / setError)にだけ効かせる。
    const begin = PAGE.indexOf("const fetchProperty = useCallback");
    expect(begin).toBeGreaterThan(-1);
    const end = PAGE.indexOf("}, [id, loadQualityIssues]);", begin);
    const body = PAGE.slice(begin, end);
    const fin = body.slice(body.indexOf("} finally {"));
    expect(fin).toContain("setLoading(false);");
    expect(fin).not.toMatch(/if \([^)]*\)\s*setLoading\(false\)/);
  });

  it("静かな取り直しはページ全体を『読み込み中』にしない", () => {
    // ここに setLoading(true) を書くと、このページの子である実況パネルごと
    // 作り直され、「成功したのに実況が消える」逆回帰になる。
    const begin = PAGE.indexOf("const refreshPropertyQuietly");
    expect(begin).toBeGreaterThan(-1);
    const end = PAGE.indexOf("\n  }, [", begin);
    expect(end).toBeGreaterThan(begin);
    expect(PAGE.slice(begin, end)).not.toContain("setLoading(");
  });
});
