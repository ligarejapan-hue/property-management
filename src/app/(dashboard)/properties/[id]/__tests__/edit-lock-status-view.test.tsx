/**
 * 見ている側(物件詳細・仕様 6.3・Task 9)の配線を node で検証する。
 *
 * ⚠このリポジトリは jsdom を使わない方針(vitest.config.ts が environment: "node" を
 *   固定)。帯・disabledの描画をクリックして確かめるテストは書けないため、
 *   - 周期・分割・staleの破棄(判断そのもの)は `status-controller.test.ts` で、
 *   - どの行が止まるか(仕様6.3の表そのもの)は `save-gate.test.ts` の
 *     `isEditLockHeldByOther` で、
 *   実挙動を検証済み。ここで固定するのは「この画面がそれらを正しい引数・正しい
 *   場所で呼んでいるか」だけ(`owner-card-edit-lock.test.tsx` と同じ役割分担)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const PAGE_PATH = resolve(
  process.cwd(),
  "src/app/(dashboard)/properties/[id]/page.tsx",
);
// ⚠(review round1 Important 7) このファイルはCRLFで保存されている(このリポジトリの
//   走査型テストの規約=「走査型テストは改行をLFに正規化」)。距離(文字数)で判定する
//   検査があるため、正規化しないとローカル(CRLF)とCI/他環境で窓の残り幅がずれる
//   (save-entrypoints-scan.test.tsの`.replace(/\r\n/g, "\n")`と同じ対処)。
const src = readFileSync(PAGE_PATH, "utf8").replace(/\r\n/g, "\n");

/** トップレベルの `function Xxx(` から次のトップレベル `function`/`export` 宣言の手前までを切り出す。 */
function extractTopLevelFunction(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const bodyStart = start + marker.length;
  const next = source.slice(bodyStart).match(/\n(function |export (default )?(async )?function )/);
  const end = next ? bodyStart + next.index! : source.length;
  return source.slice(start, end);
}

/**
 * `openTag` から始まる JSX 要素を、その要素自身の閉じ(自己終了 `/>`)までで
 * 切り出す(review round1 Important 3)。`[\s\S]*?editLockHeld=...` のように
 * 右側が無制限だと、同じ prop 名を持つ**次の別要素**まで読み飛ばしてマッチして
 * しまい、対象要素からその prop を消しても検査が green のままになる
 * (実際に `<BasicTab` の同名propに飛んで誤検知することを確認済み)。
 */
function extractJsxElement(source: string, openTag: string): string {
  const start = source.indexOf(openTag);
  if (start === -1) return "";
  const closeIdx = source.indexOf("/>", start);
  if (closeIdx === -1) return source.slice(start);
  return source.slice(start, closeIdx + 2);
}

const PROPERTY_DETAIL_PAGE_SRC = extractTopLevelFunction(
  src,
  "export default function PropertyDetailPage({",
);
const OWNER_CARD_SRC = extractTopLevelFunction(src, "function OwnerCard({");
const OWNER_TAB_SRC = extractTopLevelFunction(src, "function OwnerTab({");
const CASE_STATUS_FIELD_SRC = extractTopLevelFunction(src, "function CaseStatusField({");
const INTRODUCTION_ROUTE_FIELD_SRC = extractTopLevelFunction(src, "function IntroductionRouteField({");

describe("見ている側の下ごしらえ(useEditLockStatus・PropertyDetailPage)", () => {
  it("PropertyDetailPageが実在する", () => {
    expect(PROPERTY_DETAIL_PAGE_SRC.length).toBeGreaterThan(0);
  });

  it("useEditLockStatusをimportし、物件+全所有者を1つの資源一覧として渡す", () => {
    expect(src).toMatch(/from\s+["']@\/hooks\/use-edit-lock-status["']/);
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /\{\s*resourceType:\s*"property",\s*resourceId:\s*property\.id\s*\}/,
    );
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /property\.propertyOwners\.map\(\(po\)\s*=>\s*\(\{\s*resourceType:\s*"owner"\s*as\s*const,\s*resourceId:\s*po\.ownerId\s*\}\)\)/,
    );
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /useEditLockStatus\(editLockStatusResources,\s*\{\s*\n?\s*enabled:\s*property\s*!==\s*null,?\s*\n?\s*\}\)/,
    );
  });

  it("propertyの行はeditLockStatus.byKeyで引き、isEditLockHeldByOtherで止めるか決める(判断の再実装をしない)", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/edit-lock\/save-gate["']/);
    expect(src).toContain("isEditLockHeldByOther");
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /const propertyEditLockRow = editLockStatus\.byKey\("property", property\.id\);/,
    );
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /const propertyEditLockHeld = isEditLockHeldByOther\(propertyEditLockRow\);/,
    );
  });

  it("管理者かどうかはlockIdの有無で決める(窓口が管理者にしか返さない=権限境界そのもの)", () => {
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /const propertyEditLockIsAdmin = propertyEditLockRow\?\.lockId !== undefined;/,
    );
  });
});

describe("仕様6.3の表: 物件が他の人の鍵のとき止まる4つ", () => {
  it("① 上部に帯(EditLockHolderBanner)を出す", () => {
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /propertyEditLockHeld && propertyEditLockRow && \([\s\S]{0,120}<EditLockHolderBanner[\s\S]{0,200}row=\{propertyEditLockRow\}[\s\S]{0,200}onReleased=\{editLockStatus\.refresh\}/,
    );
  });

  it("② 編集ボタン(物件を編集)を無効化する。titleは帯と矛盾しない文言をeditLockUnavailableTitleに委ねる(review round1 Important 5)", () => {
    const idx = PROPERTY_DETAIL_PAGE_SRC.indexOf("onClick={() => setShowEditForm(true)}");
    expect(idx).toBeGreaterThan(-1);
    const block = PROPERTY_DETAIL_PAGE_SRC.slice(idx, idx + 300);
    expect(block).toMatch(/disabled=\{propertyEditLockHeld\}/);
    expect(block).toContain("物件を編集");
    // ⚠修理前は両方のheld状態で固定文言(「他の利用者が…」)を出しており、
    //   held_by_self_other_screenでは帯(「あなたが別の画面で編集中です」)と
    //   矛盾していた。判断をeditLockUnavailableTitleへ委ね、文言を複製しない。
    expect(block).toMatch(
      /title=\{propertyEditLockHeld \? editLockUnavailableTitle\(propertyEditLockRow\) : "物件情報を編集"\}/,
    );
  });

  it("③ 案件ステータス・導入ルートのプルダウンを無効化する(BasicTab経由でeditLockHeldを渡す)", () => {
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /<BasicTab[\s\S]{0,400}editLockHeld=\{propertyEditLockHeld\}[\s\S]{0,400}editLockPropertyRow=\{propertyEditLockRow\}/,
    );
    expect(CASE_STATUS_FIELD_SRC).toMatch(/disabled=\{saving \|\| editLockHeld\}/);
    expect(INTRODUCTION_ROUTE_FIELD_SRC).toMatch(/disabled=\{saving \|\| editLockHeld\}/);
  });

  it("④ 所在検索の地番保存を無効化する(RegistryLocationSearchButtonにeditLockHeldを渡す)", () => {
    // ⚠(review round1 Important 3) unbounded な `[\s\S]*?` は、この画面の
    //   もっと後方にある別要素(`<BasicTab`)の**同名prop**まで読み飛ばして
    //   マッチしてしまい、この要素自身からeditLockHeldを消しても green のままに
    //   なることを実測で確認した(4147文字先)。要素自身の閉じ`/>`までに窓を絞る。
    const registryButtonBlock = extractJsxElement(
      PROPERTY_DETAIL_PAGE_SRC,
      "<RegistryLocationSearchButton",
    );
    expect(registryButtonBlock.length).toBeGreaterThan(0);
    expect(registryButtonBlock).toMatch(/editLockHeld=\{propertyEditLockHeld\}/);
  });

  it("空いた(free)なら帯を出さない(propertyEditLockHeldがfalseならバナーのJSXが評価されない)", () => {
    // ⚠「文字列としてEditLockHolderBannerが存在する」だけでは、条件を外して
    //   常時描画しても検査は落ちない。条件式が banner の直近(この間には
    //   div className="mb-4" の折り返し1つだけ)にあることを固定する。
    const bannerIdx = PROPERTY_DETAIL_PAGE_SRC.indexOf("<EditLockHolderBanner");
    expect(bannerIdx).toBeGreaterThan(-1);
    const conditionIdx = PROPERTY_DETAIL_PAGE_SRC.lastIndexOf(
      "propertyEditLockHeld && propertyEditLockRow && (",
      bannerIdx,
    );
    expect(conditionIdx).toBeGreaterThan(-1);
    expect(bannerIdx - conditionIdx).toBeLessThan(150);
  });
});

describe("仕様6.3の表: 所有者Nが鍵のとき止まるのはそのカードだけ", () => {
  it("OwnerTabはeditLockStatusByKeyとonEditLockReleasedを親から受け取る", () => {
    expect(PROPERTY_DETAIL_PAGE_SRC).toMatch(
      /<OwnerTab[\s\S]{0,600}editLockStatusByKey=\{editLockStatus\.byKey\}[\s\S]{0,200}onEditLockReleased=\{editLockStatus\.refresh\}/,
    );
  });

  it("OwnerTabは所有者ごとに editLockStatusByKey(\"owner\", po.ownerId) を引いてOwnerCardへ渡す(全カードで同じ行を使い回さない)", () => {
    expect(OWNER_TAB_SRC).toMatch(
      /editLockStatusRow=\{editLockStatusByKey\("owner", po\.ownerId\)\}/,
    );
    expect(OWNER_TAB_SRC).toMatch(/onEditLockReleased=\{onEditLockReleased\}/);
  });

  it("OwnerCardはこのカードの行だけでisEditLockHeldByOtherを判断する(親由来の共有変数ではない)", () => {
    expect(OWNER_CARD_SRC).toMatch(
      /const editLockHeld = isEditLockHeldByOther\(editLockStatusRow\);/,
    );
    expect(OWNER_CARD_SRC).toMatch(
      /const editLockIsAdmin = editLockStatusRow\?\.lockId !== undefined;/,
    );
  });

  it("OwnerCardの「所有者情報を編集」ボタンだけを無効化する。titleも同じeditLockUnavailableTitleに委ねる(review round1 Important 5)", () => {
    // ⚠`indexOf("所有者情報を編集")`はこのカードの説明コメントにも出現する。
    //   ボタン本体(onClick={handleEdit})を起点にする(この画面に1箇所しか無い)。
    const idx = OWNER_CARD_SRC.indexOf("onClick={handleEdit}");
    expect(idx).toBeGreaterThan(-1);
    const block = OWNER_CARD_SRC.slice(idx, idx + 300);
    expect(block).toMatch(/disabled=\{editLockHeld\}/);
    expect(block).toContain("所有者情報を編集");
    expect(block).toMatch(
      /title=\{editLockHeld \? editLockUnavailableTitle\(editLockStatusRow\) : "所有者情報を編集"\}/,
    );
  });

  it("OwnerCardの中にだけ帯(EditLockHolderBanner)を出す(一覧全体には広げない)", () => {
    expect(OWNER_CARD_SRC).toMatch(
      /editLockHeld && editLockStatusRow && \([\s\S]{0,120}<EditLockHolderBanner[\s\S]{0,200}row=\{editLockStatusRow\}[\s\S]{0,200}onReleased=\{onEditLockReleased\}/,
    );
  });
});

describe("Task 7の一発問い合わせをTask 9の状態行で置き換える(2回目の追加リクエストを避ける)", () => {
  it("案件ステータス・導入ルートの保存は、親(useEditLockStatus)が持っている物件の行をrunNoLockPropertyPatchへ渡す", () => {
    expect(CASE_STATUS_FIELD_SRC).toMatch(
      /runNoLockPropertyPatch\([\s\S]*?saveSeqRef,[\s\S]*?editLockPropertyRow && \[editLockPropertyRow\],/,
    );
    expect(INTRODUCTION_ROUTE_FIELD_SRC).toMatch(
      /runNoLockPropertyPatch\([\s\S]*?saveSeqRef,[\s\S]*?editLockPropertyRow && \[editLockPropertyRow\],/,
    );
  });

  it("runNoLockPropertyPatchはpreFetchedRowsを受け取り、composeEditLockedMessageへそのまま渡す", () => {
    expect(src).toMatch(
      /composeEditLockedMessage\("property", propertyId, envelopeMessage, preFetchedRows\)/,
    );
  });
});
