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
    // ⚠**回数では固定しない**。合図は他の場面(回収の入口を押したとき=版番号を
    //   新しくするため)でも使うので、回数を増やすたびにピンが壊れる。
    //   守るべきは「**両方の成功経路が合図を出す**」こと。
    const LF = String.fromCharCode(10);
    const bodyOf = (name: string) => {
      const at = BUTTON.indexOf("const " + name + " = async (");
      expect(at).toBeGreaterThan(-1);
      const end = BUTTON.indexOf(LF + "  };", at);
      expect(end).toBeGreaterThan(at);
      return BUTTON.slice(at, end);
    };
    expect(bodyOf("runObtain")).toContain("onRegistryResultApplied();");
    expect(bodyOf("runRecover")).toContain("onRegistryResultApplied();");
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
    // 静かな読み直しは「読み込み中」にもエラー表示にも触らない
    //   （見えている表を乱さない）。触ってよいのは見える取り直しだけ。
    const begin = ATTACH.indexOf("const fetchAttachmentsData = useCallback");
    expect(begin).toBeGreaterThan(-1);
    const body = ATTACH.slice(begin, ATTACH.indexOf("}, [propertyId]);", begin));
    const guarded = body.slice(
      body.indexOf("if (!options?.silent) {"),
      body.indexOf("try {"),
    );
    expect(guarded).toContain("setLoading(true);");
    expect(guarded).toContain("setError(null);");
    // ガードの外で「読み込み中」にしていないこと（数で固定）。
    expect(body.split("setLoading(true);").length - 1).toBe(1);
  });

  it("物件ページは合図を添付タブと謄本ブロックの両方へ配る", () => {
    expect(PAGE).toContain("attachmentsRefreshToken");
    expect(PAGE).toContain("onRegistryResultApplied={");
    expect(PAGE).toContain("refreshToken={attachmentsRefreshToken}");
  });

  it("取り直しの交通整理は純関数に委ねる(画面で世代を数え直さない)", () => {
    // ⚠ここは @codex に**5巡連続で別々の穴**を指摘された場所
    //   (後着勝ち / 「読み込み中」の取り残し / 失敗が成功を無効化 /
    //    追い越された失敗でページ全体がエラー画面 / 両方失敗したときに黙る)。
    //   原因は、判定を画面に直書きしたせいで**文字列の照合でしか確かめられなかった**こと。
    //   判定は refresh-coordinator(純関数)へ出し、**順番を並べた本物のテスト**で固定する
    //   (src/lib/property-refresh/__tests__/refresh-coordinator.test.ts)。
    //   ここで固定するのは「画面がそれに委ねている」ことだけ。
    expect(PAGE).toContain('from "@/lib/property-refresh/refresh-coordinator"');
    expect(PAGE).toContain('beginRefresh(refreshStateRef.current, "full")');
    expect(PAGE).toContain('beginRefresh(refreshStateRef.current, "quiet")');
    expect(PAGE).toContain("shouldClearLoading(refreshStateRef.current, ticket)");
    // ⚠画面側で世代を数え直さない(二重管理は必ずずれる)。
    expect(PAGE).not.toContain("propertyReqSeq");
    expect(PAGE).not.toContain("fullRefreshSeq");
    expect(PAGE).not.toContain("deferredErrorRef");
  });

  it("添付一覧は後着勝ち(古い読み取りが新しい一覧を上書きしない)", () => {
    // @codex #395 R1 P2: 取り込み直後の読み直しが、先に始まっていた読み取り
    //   (初回表示・アップロード後の再取得)に上書きされると、
    //   **まさに直したはずの「成功が見えない」が復活する**。
    // @codex #395 R7 P2: 独自の世代ガードだと、**新しい取り直しが失敗しただけ**で
    //   先に届いていた使える一覧を捨て、タブが空/古いままエラーになる。
    //   ⇒ 物件ページと**同じ純関数**（総当たり検証つき）に委ねる。
    expect(ATTACH).toContain('from "@/lib/property-refresh/refresh-coordinator"');
    expect(ATTACH).toContain('options?.silent ? "quiet" : "full"');
    expect(ATTACH).toContain("shouldClearLoading(refreshStateRef.current, ticket)");
    // 画面側で世代を数え直さない（二重管理は必ずずれる）。
    expect(ATTACH).not.toContain("attachmentsReqSeq");
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
