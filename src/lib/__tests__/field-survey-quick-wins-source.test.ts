/**
 * 現地調査の使い勝手改善 4 点のソース静的検証。
 *
 * 1. 地図の既存物件吹き出し (InfoWindow) の値を日本語ラベルで表示
 *    (生の enum 英字を出さない。未知の値は素通しフォールバック)
 * 2. ピン作成モーダルの「種類」を直前の保存から引き継ぐ (連続ピンの入力時短)
 * 3. 完成待ち一覧の「候補から外す」ボタン (既存 DELETE=論理削除の再利用。
 *    own=field_survey:write / 他人=manage のみ表示する fail-closed ゲート)
 * 4. 地図の「対応済みのピンを隠す」トグル
 *
 * vitest は env=node のためクリック等は検証できない。ここでは実装の要所を
 * ソース文字列で固定し、インタラクションはレビューで担保する。
 * 改行固定アンカー (\n) は CRLF の working tree で壊れるため使わない
 * (\s+ / [\s\S]*? を使う)。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const MODAL_SRC = readSrc(
  "src/components/field-survey/pin-create-modal.tsx",
);
const QUEUE_SRC = readSrc("src/components/field-survey/candidate-queue.tsx");
const CANDIDATES_PAGE_SRC = readSrc(
  "src/app/(dashboard)/field-survey/candidates/page.tsx",
);

describe("1. 既存物件 InfoWindow の日本語ラベル表示", () => {
  const propertyInfo =
    MAP_SRC.match(/function PropertyInfo[\s\S]*?function PinInfo/)?.[0] ?? "";

  it("PropertyInfo が存在する", () => {
    expect(propertyInfo).not.toBe("");
  });

  it("種別/登記/DM/案件の 4 値すべてを共有ラベル辞書で表示する", () => {
    expect(propertyInfo).toMatch(
      /PROPERTY_TYPE_LABELS\[row\.propertyType\]\s*\?\?\s*row\.propertyType/,
    );
    expect(propertyInfo).toMatch(
      /REGISTRY_STATUS_LABELS\[row\.registryStatus\]\s*\?\?\s*row\.registryStatus/,
    );
    expect(propertyInfo).toMatch(
      /DM_STATUS_LABELS\[row\.dmStatus\]\s*\?\?\s*row\.dmStatus/,
    );
    expect(propertyInfo).toMatch(
      /CASE_STATUS_LABELS\[row\.caseStatus\]\s*\?\?\s*row\.caseStatus/,
    );
  });

  it("ラベル辞書は property-types の正本を import する (独自辞書を作らない)", () => {
    expect(MAP_SRC).toMatch(
      /import\s*\{[\s\S]*?PROPERTY_TYPE_LABELS[\s\S]*?\}\s*from\s*"@\/lib\/property-types"/,
    );
  });
});

describe("2. ピン作成モーダルの種類引き継ぎ", () => {
  it("モーダルは initialPinType prop を受け、無指定は candidate に倒す", () => {
    expect(MODAL_SRC).toMatch(/initialPinType\?\s*:\s*FieldSurveyPinType/);
    expect(MODAL_SRC).toMatch(
      /useState<FieldSurveyPinType>\(\s*initialPinType\s*\?\?\s*"candidate"\s*,?\s*\)/,
    );
  });

  it("親は保存成功時のみ種類を記憶する (allowlist 検証つき)", () => {
    const submit =
      MAP_SRC.match(
        /const handlePinCreateSubmit\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
      )?.[0] ?? "";
    expect(submit).toMatch(/isFieldSurveyPinType\(input\.pinType\)/);
    expect(submit).toMatch(/setLastPinType\(input\.pinType\)/);
  });

  it("親はモーダルへ記憶した種類を渡す", () => {
    expect(MAP_SRC).toMatch(/initialPinType=\{lastPinType\}/);
  });

  it("巡回の切替/終了で記憶を既定 (candidate) に戻す", () => {
    const sessionChange =
      MAP_SRC.match(
        /const handleActiveSessionChange\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
      )?.[0] ?? "";
    // 巡回 id が変わった分岐の中でリセットしている
    expect(sessionChange).toMatch(/prevId !== nextId/);
    expect(sessionChange).toMatch(/setLastPinType\("candidate"\)/);
  });
});

describe("3. 完成待ち一覧の「候補から外す」", () => {
  it("page は server-side で確定した currentUserId を渡す (client 推測をしない)", () => {
    expect(CANDIDATES_PAGE_SRC).toMatch(/getApiSession\(\)/);
    expect(CANDIDATES_PAGE_SRC).toMatch(
      /<CandidateQueue\s+currentUserId=\{currentUserId\}/,
    );
    // 失敗時は null (= ボタン非表示の fail-closed) に倒す
    expect(CANDIDATES_PAGE_SRC).toMatch(/catch[\s\S]*?currentUserId\s*=\s*null/);
  });

  it("表示ゲート: manage または (write かつ自分のピン) のみ。権限再取得中は出さない", () => {
    // field_survey:write / manage の判定は provider 配布の権限から fail-closed で導出
    expect(QUEUE_SRC).toMatch(
      /!permissionsRefreshPending[\s\S]*?p\.resource === "field_survey" && p\.action === "write"/,
    );
    expect(QUEUE_SRC).toMatch(
      /!permissionsRefreshPending[\s\S]*?p\.resource === "field_survey" && p\.action === "manage"/,
    );
    // 行単位: 他人の行は manage が無い限り出さない (DELETE の認可と一致)
    expect(QUEUE_SRC).toMatch(
      /canManageFieldSurvey\s*\|\|\s*\(canWriteFieldSurvey\s*&&[\s\S]*?staffUserId === currentUserId\)/,
    );
  });

  it("既存の論理削除 (deletePin=archived) を再利用し、確認ステップを挟む", () => {
    expect(QUEUE_SRC).toMatch(/useFieldSurveyPinMutations\(\)/);
    expect(QUEUE_SRC).toMatch(/deletePin\(/);
    // 誤タップ即削除を防ぐ 2 段階 (確認してから実行)
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-reject"/);
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-reject-confirm"/);
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-reject-cancel"/);
  });

  it("成功後は一覧を再取得し、失敗はメッセージ表示に倒す (黙って握り潰さない)", () => {
    const reject =
      QUEUE_SRC.match(
        /const handleRejectConfirm\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
      )?.[0] ?? "";
    expect(reject).toMatch(/deletePin\(/);
    expect(reject).toMatch(/load\(\)/);
    expect(reject).toMatch(/候補から外せませんでした/);
  });

  it("削除進行中は行またぎの操作を止める (トリガー無効化 + 陳腐化 completion 照合)", () => {
    // 削除リクエスト進行中に別行 (または同じ行) の「候補から外す」を押すと、
    // 確認ボックスの表示と実際に進行中の DELETE が食い違う。トリガー自体を
    // 進行中は無効化する。
    const trigger =
      QUEUE_SRC.match(
        /data-testid="candidate-reject"[\s\S]{0,700}?候補から外す/,
      )?.[0] ?? "";
    expect(trigger).toMatch(/disabled=\{pinMutations\.deleteLoading\}/);
    // 二重防御: await 明けに確認対象が変わっていたら古い completion で
    // UI state を触らない (ref 照合)。成功時の一覧再取得だけは server 状態が
    // 変わったので常に行う。
    const reject =
      QUEUE_SRC.match(
        /const handleRejectConfirm\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
      )?.[0] ?? "";
    expect(reject).toMatch(/rejectPinIdRef\.current === pinId/);
  });
});

describe("4. 対応済みのピンを隠すトグル", () => {
  it("トグル state があり、MapDataLayer は closed を描画から除外できる", () => {
    expect(MAP_SRC).toMatch(/hideClosedPins/);
    expect(MAP_SRC).toMatch(
      /pins\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.status !== "closed"\s*\)/,
    );
  });

  it("開いている吹き出しも隠す対象なら描画しない (marker と表示が食い違わない)", () => {
    expect(MAP_SRC).toMatch(
      /selected\.kind === "pin"[\s\S]{0,200}hideClosedPins[\s\S]{0,120}selected\.row\.status === "closed"/,
    );
  });

  it("表示切替パネルに「対応済みのピンを隠す」チェックがある (調査ピン表示中のみ)", () => {
    expect(MAP_SRC).toMatch(/対応済みのピンを隠す/);
    expect(MAP_SRC).toMatch(/checked=\{hideClosedPins\}/);
  });
});
