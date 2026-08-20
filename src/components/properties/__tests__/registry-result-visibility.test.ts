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
 * 発注者指示(2026-08-20): **知らせるのは失敗のときだけ**。成功時は**新しい通知を足さない**
 *   (トースト・自動タブ切替・自動スクロールを付けない)＝画面が最新化されれば足りる。
 * ⚠**従来からの一行の完了表示(role="status")は残す**。設計提示時に「今ある緑の一行は
 *   現状のまま残す」と明示して承認を得ている（減らす指示は受けていない）。
 *   @codex R2 P2 は「通知を出さないと書いてあるのに完了表示がある」という**文言と実装の
 *   食い違い**を指したもので、正しい指摘。直したのは**文言の側**（下の検査で固定）。
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

  it("成功時に新しい通知は足さない(トースト・自動タブ切替・自動スクロールを増やさない)", () => {
    // ⚠自動スクロールは**失敗の帯だけ**。成功経路にも付けると「知らせるのは失敗だけ」
    //   という指示を破る（数で固定＝1か所だけ外す変異でも落ちる）。
    const scrolls = BUTTON.split("scrollIntoView").length - 1;
    expect(scrolls).toBe(1);
    // 成功の合図でタブを勝手に切り替えない（見ていたタブが変わるのは驚きになる）。
    const hBegin = PAGE.indexOf("const handleRegistryResultApplied");
    expect(hBegin).toBeGreaterThan(-1);
    const hBody = PAGE.slice(
      hBegin,
      PAGE.indexOf("}, [refreshPropertyQuietly]);", hBegin),
    );
    expect(hBody).not.toContain("setActiveTab");
    // ⚠**従来からの完了表示は残す**（承認済み。消すと「閉じる（物件情報を更新）」の
    //   導線が宙に浮き、いつ閉じてよいのか分からなくなる）。
    expect(BUTTON).toContain('role="status"');
    expect(BUTTON).toContain("取得済みの謄本を取り込みました");
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

  it("『読み込み中』の解除は最新の通常の取り直しだけが行う", () => {
    // ⚠罠その1(実装中に踏んだ): 中身の世代(propertyReqSeq)を finally に掛けると、
    //   静かな取り直しが割り込んだとき**誰も loading を戻せず**画面が
    //   「読み込み中」から抜けられなくなる(静かな取り直しは loading を触らない)。
    // ⚠罠その2(@codex #395 R1 P2): かといって無条件に戻すと、**古い**取り直しが
    //   先に返っただけで解除され、最新の取得を待たずに古い内容や
    //   「物件が見つかりません」を見せてしまう(その状態で操作もできてしまう)。
    // ⇒ loading の持ち主は「通常の取り直し」専用の世代で決める。
    const begin = PAGE.indexOf("const fetchProperty = useCallback");
    expect(begin).toBeGreaterThan(-1);
    const body = PAGE.slice(begin, PAGE.indexOf("}, [id, loadQualityIssues]);", begin));
    const fin = body.slice(body.indexOf("} finally {"));
    expect(fin).toContain("if (fullSeq === fullRefreshSeq.current) setLoading(false);");
    expect(fin).not.toContain("if (seq === propertyReqSeq.current) setLoading(false)");
  });

  it("失敗した静かな取り直しは世代を進めない(成功した取り直しを無効にしない)", () => {
    // @codex #395 R3 P2: 通常の取り直しが走っている最中に取り込みが成功すると、
    //   静かな取り直しが世代を進める。そこで静かな取り直しが**失敗**すると
    //   (エラーは握りつぶす設計)、ちゃんと返ってきた通常の取り直しの結果まで
    //   「古い」と判定されて捨てられ、**画面が古いまま残る**。
    // ⇒ 世代を進めるのは「中身を反映できたとき」だけ。
    const qBegin = PAGE.indexOf("const refreshPropertyQuietly");
    expect(qBegin).toBeGreaterThan(-1);
    const qBody = PAGE.slice(qBegin, PAGE.indexOf("}, [id, loadQualityIssues]);", qBegin));
    // 成功したときは進める。
    expect(qBody).toContain("propertyAppliedSeq.current = seq;");
    // 失敗したとき(catch)は触らない。
    const qCatch = qBody.slice(qBody.indexOf("} catch {"));
    expect(qCatch).not.toContain("propertyAppliedSeq.current =");
  });

  it("静かな取り直しは『読み込み中』の世代を触らない(取り残しの再発防止)", () => {
    const qBegin = PAGE.indexOf("const refreshPropertyQuietly");
    expect(qBegin).toBeGreaterThan(-1);
    const qBody = PAGE.slice(qBegin, PAGE.indexOf("}, [id, loadQualityIssues]);", qBegin));
    expect(qBody).not.toContain("fullRefreshSeq");
  });

  it("添付一覧は後着勝ち(古い読み取りが新しい一覧を上書きしない)", () => {
    // @codex #395 R1 P2: 取り込み直後の読み直しが、先に始まっていた読み取り
    //   (初回表示・アップロード後の再取得)に上書きされると、
    //   **まさに直したはずの「成功が見えない」が復活する**。
    const begin = ATTACH.indexOf("const fetchAttachmentsData = useCallback");
    expect(begin).toBeGreaterThan(-1);
    const body = ATTACH.slice(begin, ATTACH.indexOf("}, [propertyId]);", begin));
    expect(body).toContain("const seq = ++attachmentsReqSeq.current;");
    // ⚠**成功したときと失敗したときの両方**で古い結果を捨てる(片方だけだと、
    //   もう一方の経路で古い一覧・古いエラーが最新を上書きする)。
    const guards =
      body.split("if (seq !== attachmentsReqSeq.current) return;").length - 1;
    expect(guards).toBe(2);
    // ⚠loading は世代で縛らない(縛ると静かな読み直しの割り込みで取り残す)。
    expect(body).not.toContain("attachmentsReqSeq.current) setLoading(false)");
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
