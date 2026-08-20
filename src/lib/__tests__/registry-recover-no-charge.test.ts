/**
 * 【回収】既に課金済みのPDFを取り込む経路が、**絶対に課金しない**ことの走査ガード。
 *
 * 背景: 2026-08-19 第8回テストで請求は成立(140円)したが、行の同定に失敗して
 * PDFを取り逃した。期限(PDF取得期限)内なら再課金なしで取り込めるため、回収の
 * 導線を用意した。⚠この経路に課金操作が1つでも混ざると、**同じ書類を二度買う**。
 *
 * ⚠走査型にする理由: 課金ボタンを押さないことは「実行して確かめる」より
 * 「コードに書かれていないこと」で担保するほうが確実(fake が押下を見逃す余地を
 * 残さない)。挙動テストは playwright-adapter 側にある。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 手元(CRLF)とCIで走査結果が変わらないよう改行を揃える。 */
const CR = String.fromCharCode(13);

const AUTO_FETCH = readFileSync(
  join(process.cwd(), "src/lib/registry-fetch/auto-fetch.ts"),
  "utf8",
).split(CR).join("");

/** 回収メソッドの本体だけを切り出す(前後の課金フローを巻き込まないため)。 */
function recoverBody(): string {
  const start = AUTO_FETCH.indexOf("async recoverRegistryPdfByLocation(input: {");
  expect(start).toBeGreaterThan(-1);
  const end = AUTO_FETCH.indexOf("\n    async downloadRegistryPdf() {", start);
  expect(end).toBeGreaterThan(start);
  return AUTO_FETCH.slice(start, end);
}

describe("回収経路は課金操作を一切含まない", () => {
  const body = recoverBody();

  it("⚠請求ボタン(#btn_seikyu)に触れない", () => {
    expect(body).not.toContain("fudosanListSeikyuButton");
    expect(body).not.toContain("btn_seikyu");
  });

  it("⚠確定(fuBtnForward)・請求リストの操作を含まない", () => {
    expect(body).not.toContain("requestConfirmButton");
    expect(body).not.toContain("fuBtnForward");
    expect(body).not.toContain("fudosanListRowCheckbox");
  });

  it("⚠確認ダイアログのＯＫを押す仕掛けを含まない", () => {
    expect(body).not.toContain("seikyu-confirm-ok");
    expect(body).not.toContain("pickConfirmButtonIndex");
    expect(body).not.toContain("ui-dialog-buttonpane");
  });

  it("⚠課金境界フラグ(chargeState.charged)を立てない", () => {
    expect(body).not.toContain("chargeState");
    expect(body).not.toContain("charged = true");
  });

  it("旧マイページ課金ボタン(myPageSeikyu)も含まない", () => {
    expect(body).not.toContain("myPageSeikyu");
  });

  it("使うのは表示・保存(downloadButton)だけ=無料の操作", () => {
    expect(body).toContain("REGISTRY_SELECTORS.downloadButton");
  });
});

describe("回収経路の同定は取得と同じ規則を使う(緩めない)", () => {
  const body = recoverBody();

  it("純関数(parseMyPageRowCells / pickChargedMyPageRow)で同定する", () => {
    expect(body).toContain("parseMyPageRowCells(");
    expect(body).toContain("pickChargedMyPageRow(");
  });

  it("⚠請求済かつ期限内(readyNow)でなければ取り込まない=未請求の行を掴まない", () => {
    expect(body).toContain("!picked || !picked.readyNow");
    expect(body).toContain('"not_found"');
  });

  it("⚠基準は空で呼ぶ(回収は課金前の基準を持たない)+種別も一致させる", () => {
    expect(body).toContain("baselineReceiptNos: new Set<string>()");
    expect(body).toContain("kindLabel:");
  });

  it("⚠選んだ行の受付番号を読み戻して一致を実測してからDLする", () => {
    const selectAt = body.indexOf('probe: "mypage-select"');
    const verifyAt = body.indexOf("selected.receiptNo !== picked.receiptNo");
    const downloadAt = body.indexOf("REGISTRY_SELECTORS.downloadButton");
    expect(selectAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(selectAt);
    expect(downloadAt).toBeGreaterThan(verifyAt);
  });

  it("⚠目的ページに届かなければ取り込まない(位置ズレで別の筆を掴まない)", () => {
    expect(body).toContain("hopped !== target.pageNo");
  });
});

/**
 * 画面側の入口。⚠**有料取得のスイッチが切れている本番でも押せる**ことが要件。
 * (回収は課金しないので、課金スイッチに巻き込まれてはいけない。)
 */
const SEARCH_BUTTON_UI = readFileSync(
  join(
    process.cwd(),
    "src/components/properties/registry-location-search-button.tsx",
  ),
  "utf8",
).split(CR).join("");

const PROPERTY_PAGE = readFileSync(
  join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
).split(CR).join("");

const API_CLIENT = readFileSync(
  join(process.cwd(), "src/lib/api-client.ts"),
  "utf8",
).split(CR).join("");

describe("回収の入口(画面)", () => {
  /** 指定の onClick を持つ <button> の開始タグを切り出す。 */
  function buttonTag(onClick: string): string {
    const at = SEARCH_BUTTON_UI.indexOf(onClick);
    expect(at).toBeGreaterThan(-1);
    const start = SEARCH_BUTTON_UI.lastIndexOf("<button", at);
    const end = SEARCH_BUTTON_UI.indexOf(">", SEARCH_BUTTON_UI.indexOf("</button>", at) - 200);
    expect(start).toBeGreaterThan(-1);
    return SEARCH_BUTTON_UI.slice(start, Math.max(end, at));
  }

  it("課金なしで取り込むボタンがある(文言に『課金なし』を明記)", () => {
    expect(SEARCH_BUTTON_UI).toContain("取得済みを取り込む（課金なし）");
    expect(SEARCH_BUTTON_UI).toContain("runRecover(");
  });

  it("⚠回収ボタンは有料スイッチ(purchaseEnabled)で塞がない=切れている本番でも使える", () => {
    expect(buttonTag("runRecover(")).not.toContain("purchaseEnabled");
  });

  it("⚠有料取得ボタンの方は今までどおりスイッチで塞ぐ(準備中に課金させない)", () => {
    expect(buttonTag("runObtain}")).toContain("purchaseEnabled");
  });

  it("⚠検索できない物件にも回収の入口がある(買った書類に手が届かなくならない)", () => {
    // 取込が途中まで進むと不動産番号が入って所在検索が対象外になる。
    expect(SEARCH_BUTTON_UI).toContain("!isSearchableTarget(target.kind) && (");
    // その経路は候補を使わず物件自身の地番で探す(課金なし)。
    expect(SEARCH_BUTTON_UI).toContain("recoverRegistryFromProperty(");
    // 候補が無いとき(selected===null)は物件由来で走らせる。
    // 判断は純関数(resolveRecoverEntry)に出してある=画面には埋めない。
    expect(SEARCH_BUTTON_UI).toContain("resolveRecoverEntry({");
    expect(SEARCH_BUTTON_UI).toContain('entry === "property"');
    // ⚠候補が無いのに『何もしない』早期returnを戻さない。
    expect(SEARCH_BUTTON_UI).not.toContain("if (!fromProperty && !selected) return;");
  });

  it("⚠候補なしの回収も**種類を選ぶ画面**を通る(全部事項の購入も取り込める)", () => {
    // 既定(所有者事項)のまま走らせると、全部事項で買ったものは同定で外れて
    // 永久に取り込めない(@codex #394 R9 P1)。
    const at = SEARCH_BUTTON_UI.indexOf("!isSearchableTarget(target.kind) && (");
    expect(at).toBeGreaterThan(-1);
    const seg = SEARCH_BUTTON_UI.slice(at, at + 900);
    expect(seg).toContain('setState("confirmObtain")');
    expect(seg).not.toContain("runRecover(true)");
    // 確認パネルは候補が無くても出る(=種類の選択も出る)。
    expect(SEARCH_BUTTON_UI).toContain('{state === "confirmObtain" && (');
    expect(SEARCH_BUTTON_UI).toContain('name="certificateType"');
  });

  it("⚠候補が無いときは有料取得のボタンを出さない(回収専用の入口)", () => {
    const at = SEARCH_BUTTON_UI.indexOf("onClick={runObtain}");
    expect(at).toBeGreaterThan(-1);
    const before = SEARCH_BUTTON_UI.slice(Math.max(0, at - 300), at);
    expect(before).toContain("{selected && (");
  });

  it("回収は専用の通信関数を使い、mode:recover を必ず送る", () => {
    expect(SEARCH_BUTTON_UI).toContain("recoverRegistryByCandidate(");
    const fn = API_CLIENT.slice(
      API_CLIENT.indexOf("export async function recoverRegistryByCandidate"),
      API_CLIENT.indexOf("// ---- 謄本 一括取得"),
    );
    expect(fn).toContain('mode: "recover"');
  });

  it("⚠画面は『見せていた内容』を一緒に送る(取り違えをserverで止められる)", () => {
    // 確認の後に誰かが地番を編集すると、見たものと違う筆を取り込む
    // (@codex #394 R20 P1)。画面側が版番号と識別子を送らないと検査できない。
    expect(SEARCH_BUTTON_UI).toContain("version: savedVersion ?? propertyVersion");
    expect(SEARCH_BUTTON_UI).toContain("identifier: hasBothIdentifiers");
    const fn = API_CLIENT.slice(
      API_CLIENT.indexOf("export async function recoverRegistryFromProperty"),
      API_CLIENT.indexOf("// ---- 謄本 一括取得"),
    );
    expect(fn).toContain("expectedVersion: expected.version");
    expect(fn).toContain("expectedIdentifier: expected.identifier");
  });

  it("⚠使える機能まで『利用できません』と言わない", () => {
    // 所在検索が使えないだけなのに『謄本取得は利用できません』と出すと、
    // 期限のある取り込みまで諦めさせてしまう(@codex #394 R17 P2)。
    const at = SEARCH_BUTTON_UI.indexOf("{providerDisabled && (");
    expect(at).toBeGreaterThan(-1);
    const seg = SEARCH_BUTTON_UI.slice(at, SEARCH_BUTTON_UI.indexOf("</p>", at));
    expect(seg).toContain("recoverConfigured");
    expect(seg).toContain("取得済みの謄本の取り込みはご利用いただけます");
  });

  it("物件ページは回収の可否を**取得の可否**から渡す(所在検索の校正に依らない)", () => {
    expect(PROPERTY_PAGE).toContain("registryRecoverConfigured");
    expect(PROPERTY_PAGE).toContain(
      "meCapabilities?.registryAutoFetch === true",
    );
    expect(PROPERTY_PAGE).toContain(
      "recoverConfigured={registryRecoverConfigured}",
    );
  });

  it("⚠回収の入口は所在検索とは別条件(検索が使えなくても取り込める)", () => {
    // 所在検索の校正が外れると検索ボタンごと無効になる。回収まで道連れにすると、
    // 買った書類に手が届かない(@codex #394 R16 P2)。
    expect(SEARCH_BUTTON_UI).toContain("recoverConfigured");
    // idle でも回収の入口を出す(検索ボタンの有効/無効とは無関係)。
    expect(SEARCH_BUTTON_UI).toContain("{showButton && recoverConfigured && (");
    // ⚠回収の入口は providerDisabled(=所在検索の可否)で塞がない。
    const at = SEARCH_BUTTON_UI.indexOf("{showButton && recoverConfigured && (");
    const seg = SEARCH_BUTTON_UI.slice(
      at,
      SEARCH_BUTTON_UI.indexOf("</button>", at),
    );
    expect(seg).not.toContain("providerDisabled");
    expect(seg).not.toContain("purchaseEnabled");
  });

  it("⚠地番と家屋番号の両方がある物件は、どちらを取り込むか選ばせる", () => {
    // 放っておくと家屋番号が優先され、土地の購入を取り込めない/建物のPDFを
    // 土地の物件へ入れてしまう(@codex #394 R13 P1)。
    expect(SEARCH_BUTTON_UI).toContain("hasBothIdentifiers");
    expect(SEARCH_BUTTON_UI).toContain('name="recoverKind"');
    expect(SEARCH_BUTTON_UI).toContain("土地（地番");
    expect(SEARCH_BUTTON_UI).toContain("建物（家屋番号");
    // 選んだ結果を通信に載せる(両方あるときだけ意味を持つ)。
    expect(SEARCH_BUTTON_UI).toContain(
      "hasBothIdentifiers ? recoverKind : undefined",
    );
  });

  it("⚠有料取得の通信関数には mode を混ぜない(取り違えで課金経路が回収に化けない)", () => {
    const fn = API_CLIENT.slice(
      API_CLIENT.indexOf("export async function obtainRegistryByCandidate"),
      API_CLIENT.indexOf("export async function recoverRegistryByCandidate"),
    );
    expect(fn).not.toContain("mode");
  });
});
