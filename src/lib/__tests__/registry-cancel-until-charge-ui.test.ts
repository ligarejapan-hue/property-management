/**
 * 「中止は請求(課金)の直前まで効く」の画面側 source assertion。
 *
 * 発注者指示 (2026-08-21):「確定ボタンを押すまでは中止ボタンを出してください。」
 *
 * ⚠このリポは jsdom 未導入。クリック挙動は検証できないので、
 *   **判定を純関数へ出し**(cancel-visibility.ts)、画面側は
 *   「その純関数を使っていること」「文言から推測していないこと」を走査で固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const PANEL = read("src/components/properties/registry-live-panel.tsx");
const BUTTON = read(
  "src/components/properties/registry-location-search-button.tsx",
);
const CLIENT = read("src/lib/api-client.ts");
const STORE = read("src/lib/registry-fetch/live-view-store.ts");
const PROVIDER = read("src/lib/registry-fetch/official-provider.ts");
const ROUTE = read("src/app/api/properties/[id]/registry/auto-fetch/route.ts");
const AUTO = read("src/lib/registry-fetch/auto-fetch.ts");

describe("サーバーが中止の可否を答える", () => {
  it("実況の取得結果に cancelable が含まれる", () => {
    expect(STORE).toContain("cancelable:");
    expect(CLIENT).toContain("cancelable?: boolean;");
  });

  it("⚠完了後は cancelable を true にしない", () => {
    // 終わったのに「中止できます」と答えると、押しても効かないボタンが出る。
    expect(STORE).toContain("cancelable: !entry.done && activeOps.has(k)");
  });
});

describe("パネルはサーバーの答えだけで判断する", () => {
  it("判定を純関数 cancelControlView に委ねている", () => {
    // ⚠2026-08-23(@codex #401 R3): 2値(出す/出さない)では「中止しています…」を
    //   出せなかったため、3状態(action/pending/hidden)を返す関数に置き換えた。
    expect(PANEL).toContain("cancelControlView({");
    expect(PANEL).toContain("cancelWindowOpen: serverCancelable");
  });

  it("⚠実況の文言から課金前かを推測していない", () => {
    // 文言照合で可否を決めると、文言を1つ変えただけで**課金中に中止ボタンが出る**。
    expect(PANEL).not.toContain("まだ課金されていません");
    expect(PANEL).not.toContain("ここから請求");
  });

  it("応答に cancelable が無い(古いサーバー)ときは不明として扱う", () => {
    // ⚠`?? true` のような既定値にすると、効かないボタンが出る。
    expect(PANEL).toContain(
      'typeof res.data.cancelable === "boolean" ? res.data.cancelable : null',
    );
  });

  it("受付が閉じたら理由を出す(黙って消さない)", () => {
    expect(PANEL).toContain("cancelClosedNotice({");
    expect(PANEL).toContain("{closedNotice}");
  });
});

describe("有料取得でも中止の話をしてよい経路になっている", () => {
  it("取得中もパネルに cancelable を渡す。⚠回収中は渡さない", () => {
    // ⚠searching だけに戻ると、サーバーが受け付けていても画面に出ない。
    // ⚠**回収(recovering)は対象外**(@codex #401 R2 P1)。回収の経路には中止を
    //   見る場所が無いので、出すと「止めたつもりで最後まで走り PDF が添付される」。
    const at = BUTTON.indexOf("cancelable={");
    expect(at).toBeGreaterThan(-1);
    const block = BUTTON.slice(at, at + 200);
    expect(block).toContain('state === "searching"');
    expect(block).toContain('state === "obtaining"');
    expect(block).not.toContain('state === "recovering"');
  });

  it("中止を押した瞬間に画面側でも覚える(応答待ちの間に自動で進まない)", () => {
    expect(BUTTON).toContain("onCancelRequested");
    expect(BUTTON).toContain("searchCancelledRef.current = true;");
  });
});

// ── @codex #401 R3 ────────────────────────────────────────────────────
describe("中止を押した後も状態が見える(@codex #401 R3 P2)", () => {
  it("パネルは3状態(押せる/中止しています…/出さない)を純関数で決める", () => {
    // ⚠初版は「押したら隠す」だったため、`中止しています…` が**一度も出せなかった**。
    expect(PANEL).toContain("cancelControlView({");
    expect(PANEL).toContain('cancelView !== "hidden"');
    expect(PANEL).toContain('disabled={cancelView === "pending"}');
  });

  it("押した後の文言がボタンに残っている", () => {
    expect(PANEL).toContain('cancelling ? "中止しています…" : "中止"');
  });
});

describe("順番待ちの中止は待たずに決着させる(@codex #401 R3 P2)", () => {
  it("見張りは印を立てるだけでなく待ちを打ち切る", () => {
    // ⚠印だけだと、待ち(最大30分)が終わるまで画面は「中止しています…」のまま・
    //   物件も scheduled のまま。**待ちそのものを cancelled で決着**させる。
    expect(PROVIDER).toContain("abandonForCancel");
    expect(PROVIDER).toMatch(/abandonForCancel\?\.\(\)/);
    expect(PROVIDER).toMatch(/reject\(new RegistryFetchError\("cancelled"\)\)/);
  });

  it("⚠取得が始まっていたら打ち切らない(課金境界は adapter が見る)", () => {
    const at = PROVIDER.indexOf("abandonForCancel = () => {");
    expect(at).toBeGreaterThan(-1);
    expect(PROVIDER.slice(at, at + 260)).toContain("if (acquired || gaveUp) return;");
  });

  it("⚠印は残す(あとから順番が回っても外部に触れずに抜ける)", () => {
    // gaveUp も立てるので、遅れて回ってきたコールバックは冒頭で rate_limited。
    const at = PROVIDER.indexOf("abandonForCancel = () => {");
    expect(PROVIDER.slice(at, at + 260)).toContain("gaveUp = true;");
  });
});

// ── @codex #401 R4 ────────────────────────────────────────────────────
describe("中止の節目を実装している経路だけ受付を開ける(@codex #401 R4 P2)", () => {
  it("route: 回収と旧経路(candidateRef なし)は受付を即閉じる", () => {
    // ⚠旧経路(不動産番号での購入)は live を orchestration に渡しておらず、
    //   誰も中止を見ない。開けたままだと accepted:true なのに最後まで走る。
    expect(ROUTE).toMatch(
      /if \(isRecover \|\| !candidateRef\) \{\s*\n\s*closeLiveViewCancelWindow\(session\.id, id, liveRef\);/,
    );
  });

  it("orchestration: 候補があっても所在購入でなければ受付を閉じる", () => {
    // 候補が番号で買われる(willPurchaseByLocation=false)場合、所在購入の
    // adapter の節目(abortIfCancelledPaid)を通らない=誰も中止を見ない。
    // ⚠R5 で「閉じる前に既に受け付けた中止を確認する」が間に入った。
    //   閉じること自体はこの分岐の中に残る(順序は R5 の固定が見る)。
    const at = AUTO.indexOf("if (!isRecover && !willPurchaseByLocation) {");
    expect(at).toBeGreaterThan(-1);
    expect(AUTO.slice(at, at + 1600)).toContain("args.live?.endCancelable?.();");
  });
});

describe("文言は流れに合わせる(@codex #401 R4 P2)", () => {
  it("有料取得の中止ボタンに「この検索では課金は発生しません」と出さない", () => {
    // title は chargeable で切り替える(有料の説明は「課金の前に受け付けられた
    // 中止では、課金は発生しません」)。
    expect(PANEL).toContain("chargeable");
    expect(PANEL).toContain(
      "課金の前に受け付けられた中止では、課金は発生しません",
    );
  });

  it("呼び出し側は有料取得のときだけ chargeable を立てる", () => {
    expect(BUTTON).toMatch(/chargeable=\{state === "obtaining"\}/);
  });

  it("閉じた知らせも流れごとの文言(無料検索に「請求手続き中」を出さない)", () => {
    expect(PANEL).toContain("chargeInvolved: chargeable");
  });
});

// ── @codex #401 R5 ────────────────────────────────────────────────────
describe("受付を閉じる前に、既に受け付けた中止を敬う(@codex #401 R5 P2)", () => {
  it("番号購入へ落ちる分岐は、閉じる前に isCancelRequested を確認する", () => {
    // route が受付を開けたまま候補解決〜判定まで進む間に押された中止は
    // accepted:true で返っている。黙って閉じると「止めたつもりなのに実行が走る」。
    const at = AUTO.indexOf("if (!isRecover && !willPurchaseByLocation) {");
    expect(at).toBeGreaterThan(-1);
    const block = AUTO.slice(at, at + 1600);
    const check = block.indexOf("isCancelRequested?.() === true");
    const close = block.indexOf("args.live?.endCancelable?.()");
    expect(check).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(check); // 確認が先・閉じるのが後
    // 止めたことは監査に cancelled で残し、画面には中止専用コードで返す。
    expect(block).toContain('status: "cancelled"');
    expect(block).toContain('"REGISTRY_AUTO_FETCH_CANCELLED"');
  });
});
