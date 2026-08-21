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
    expect(buttonTag("runObtain(undefined,")).toContain("purchaseEnabled");
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
    const at = SEARCH_BUTTON_UI.indexOf("onClick={() => runObtain(undefined,");
    expect(at).toBeGreaterThan(-1);
    // ⚠注釈が増えて 300 では届かなくなったので広げる(見ている中身は不変)。
    const before = SEARCH_BUTTON_UI.slice(Math.max(0, at - 800), at);
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

  it("⚠失敗した回収の後は物件を取り直す(古い版番号で永久に409にならない)", () => {
    // 取得の予約(ロック)が版番号を上げるため、古い版のまま再実行すると
    // サーバーが毎回409で弾く(@codex #394 R27 P2)。
    const at = SEARCH_BUTTON_UI.indexOf("const runRecover = async");
    const seg = SEARCH_BUTTON_UI.slice(at, SEARCH_BUTTON_UI.indexOf("const showButton", at));
    // catch 側にも refresh の予約がある(成功側だけではない)。
    const catchAt = seg.indexOf("} catch (e) {");
    expect(catchAt).toBeGreaterThan(-1);
    expect(seg.slice(catchAt)).toContain("propertyRefreshPendingRef.current = true;");
  });

  it("⚠CSV取込の重複更新は謄本取得中(scheduled)の物件を書き換えない", () => {
    // 取得は所在・地番を鍵に書類を選ぶ。取得中に書き換わると別の対象になった
    // 物件へ添付される(@codex #394 R26/R27 P1)。CSV側で弾いて行エラーにする。
    const csv = readFileSync(
      join(process.cwd(), "src/app/api/import/csv/route.ts"),
      "utf8",
    ).split(CR).join("");
    expect(csv).toContain('registryStatus: { not: "scheduled" }');
    expect(csv).toContain("謄本の自動取得の処理中です");
    // ⚠弾いた行では建物の郵便番号も反映しない(@codex #394 R28 P2)。
    const guardAt = csv.indexOf("if (guarded.count === 0) {");
    const guardSeg = csv.slice(guardAt, csv.indexOf("continue;", guardAt));
    expect(guardSeg).not.toContain("commitBuildingPostalCode");
  });

  it("⚠手動編集も取得中は鍵の項目(所在・地番など)を変えられない", () => {
    // CSVだけ塞いでも、通常の編集APIから同じ書き換えができては意味が無い
    // (@codex #394 R28 P1)。メモ等、鍵に関係ない編集は止めない。
    const patch = readFileSync(
      join(process.cwd(), "src/app/api/properties/[id]/route.ts"),
      "utf8",
    ).split(CR).join("");
    expect(patch).toContain('current.registryStatus === "scheduled"');
    // ⚠**書き込み自体にも条件を付ける**(@codex #394 R29 P1)。読んだ時点の判定
    //   だけだと、読んだ後にロックを取られて書き換えられる。
    const writeAt = patch.indexOf("const guardedUpdate = await prisma.property.updateMany");
    expect(writeAt).toBeGreaterThan(-1);
    const writeSeg = patch.slice(writeAt, patch.indexOf("});", writeAt));
    expect(writeSeg).toContain("version,");
    expect(writeSeg).toContain('registryStatus: { not: "scheduled" }');
    // 条件付き更新が0件のときは必ず 409 で返す(黙って成功にしない)。
    expect(patch).toContain("if (guardedUpdate.count === 0) {");
    expect(patch).toContain("REGISTRY_FETCH_IN_PROGRESS");
    expect(patch).toContain('"realEstateNumber",');
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

  it("⚠検索が使えないときは回収の入口が独立して出る(買った書類に手が届かなくならない)", () => {
    // 所在検索の校正が外れると検索ボタンごと無効になる。回収まで道連れにすると、
    // 買った書類に手が届かない(@codex #394 R16 P2)。
    // ⚠2026-08-21 発注者指示で**入口を検索の流れに一本化**した(重複した導線を置かない)。
    //   守る中身は変わらない: 検索が使える → 流れの中の2択で到達できる /
    //   検索が使えない → ここに独立した入口を出す。
    // ⚠2026-08-21: 入口の定義を1か所(recoverEntryLink)にまとめ、行き止まりの各所へ
    //   差し込む形にした(@codex #398 R2 P1)。条件の書き写しを作らないため。
    expect(SEARCH_BUTTON_UI).toContain("const recoverEntryLink = recoverConfigured ? (");
    expect(SEARCH_BUTTON_UI).toContain("{showButton && providerDisabled && recoverEntryLink}");
    // ⚠回収は有料スイッチでは塞がない(切れている本番でも取り込める)。
    const at = SEARCH_BUTTON_UI.indexOf("const recoverEntryLink = recoverConfigured ? (");
    const seg = SEARCH_BUTTON_UI.slice(
      at,
      SEARCH_BUTTON_UI.indexOf("</button>", at),
    );
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
