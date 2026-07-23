/**
 * 現地調査まわりの小さな使い勝手改善 5 点のソース静的検証。
 *
 * 1. 保存トーストに「取り消す」「写真を追加」ボタン (誤作成の即時 undo /
 *    2 枚目写真の最短経路)
 * 2. 利用者向け文言から技術用語「session」を一掃 (平易語ルール)
 * 3. 物件化成功後は新しい物件ページへ直行 (propertyId を捨てない)
 * 4. 完成待ち一覧: 件数バッジ + 経過日数 (7日以上は強調) + 上限到達警告
 * 5. 物件化モーダルに不動産番号 (任意) 入力欄
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");
const QUEUE_SRC = readSrc("src/components/field-survey/candidate-queue.tsx");
const CONVERT_SRC = readSrc(
  "src/components/field-survey/convert-pin-to-property-modal.tsx",
);
const CANDIDATES_ROUTE_SRC = readSrc(
  "src/app/api/field-survey/pins/candidates/route.ts",
);

describe("1. 保存トーストのアクションボタン", () => {
  it("トーストは操作可能 (pointer-events-auto) で 2 つのボタンを持つ", () => {
    const toast = MAP_SRC.match(
      /data-testid="pin-saved-toast"[\s\S]*?ピンを保存しました[\s\S]*?<\/div>/,
    );
    expect(toast).not.toBeNull();
    const m = toast?.[0] ?? "";
    expect(m).toMatch(/data-testid="pin-saved-add-photo"/);
    expect(m).toMatch(/data-testid="pin-saved-undo"/);
    // ボタン付きなので pointer-events-none ではない
    const container = MAP_SRC.match(
      /\{savedToastPinId && \([\s\S]{0,400}pointer-events-auto/,
    );
    expect(container).not.toBeNull();
  });

  it("「取り消す」は作成した pin を論理削除し marker を再取得する", () => {
    const undo = MAP_SRC.match(
      /const handleUndoCreatedPin\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
    );
    expect(undo).not.toBeNull();
    const m = undo?.[0] ?? "";
    expect(m).toMatch(/pinMutations\.deletePin\(pinId\)/);
    expect(m).toMatch(/bumpRefetch\(\)/);
    // 失敗時は代替導線 (ピンをタップして削除) を案内する
    expect(m).toMatch(/ピンの取り消しに失敗しました/);
    // unmount 後の setState を防ぐ
    expect(m).toMatch(/fsMapMountedRef\.current/);
  });

  it("「写真を追加」は作成した pin の詳細パネルを開く", () => {
    const add = MAP_SRC.match(
      /const handleAddPhotoToCreatedPin\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
    );
    expect(add).not.toBeNull();
    const m = add?.[0] ?? "";
    expect(m).toMatch(/setDetailPinId\(pinId\)/);
    // functional update: 別ピンのトーストへ切替済みなら消さない (undo と同型)
    expect(m).toMatch(/cur === pinId \? null : cur/);
  });

  it("「取り消す」も切替済みトーストを誤って消さない (functional update)", () => {
    const undo = MAP_SRC.match(
      /const handleUndoCreatedPin\s*=\s*useCallback\([\s\S]*?\],?\s*\);/,
    );
    expect(undo?.[0] ?? "").toMatch(/cur === pinId \? null : cur/);
  });

  it("トースト表示は pin id を保持し、ボタン操作の猶予として表示を延長している", () => {
    expect(MAP_SRC).toMatch(/setSavedToastPinId\(pinId\)/);
    expect(MAP_SRC).toMatch(/\}, 7000\)/);
  });
});

describe("2. 技術用語「session」の一掃 (利用者向け文言)", () => {
  const files = [
    "src/components/field-survey/field-survey-map.tsx",
    "src/components/field-survey/pin-create-modal.tsx",
    "src/components/field-survey/field-survey-history-map.tsx",
    "src/components/field-survey/trip-controls.tsx",
    "src/components/field-survey/use-field-survey-location-recorder.ts",
    "src/lib/field-survey-trip-util.ts",
  ];
  it("「巡回 session」を含む利用者向け文言が残っていない (コメント除く)", () => {
    for (const f of files) {
      const code = stripComments(readSrc(f));
      expect(code, f).not.toMatch(/巡回 session/);
      expect(code, f).not.toMatch(/active な巡回/);
    }
  });

  it("InfoWindow の項目名も session でなく「巡回」", () => {
    expect(MAP_SRC).not.toMatch(/<dt>session<\/dt>/);
    expect(MAP_SRC).toMatch(/<dt>巡回<\/dt>/);
  });

  it("置換後の平易文言が存在する", () => {
    expect(readSrc("src/components/field-survey/pin-create-modal.tsx")).toMatch(
      /巡回中でないため保存できません/,
    );
    expect(MAP_SRC).toMatch(/巡回を開始してから現在地を取得してください/);
    expect(readSrc("src/lib/field-survey-trip-util.ts")).toMatch(
      /すでに巡回中です/,
    );
  });
});

describe("3. 物件化成功後の遷移", () => {
  it("candidate-queue は propertyId を受け取り物件ページへ直行する", () => {
    expect(QUEUE_SRC).toMatch(/useRouter/);
    expect(QUEUE_SRC).toMatch(
      /onConverted=\{\(propertyId\)\s*=>\s*\{[\s\S]{0,200}router\.push\(`\/properties\/\$\{propertyId\}`\)/,
    );
  });
});

describe("4. 完成待ち一覧の放置可視化", () => {
  it("件数バッジ・経過日数・上限警告の表示要素がある", () => {
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-count"/);
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-age"/);
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-limit-warning"/);
  });

  it("経過日数は純関数 describeCandidateAge 経由 (stale で強調)", () => {
    expect(QUEUE_SRC).toMatch(/describeCandidateAge\(/);
    expect(QUEUE_SRC).toMatch(/age\.stale/);
  });

  it("上限は route と共有の CANDIDATE_LIST_LIMIT (乖離しない)", () => {
    expect(QUEUE_SRC).toMatch(/CANDIDATE_LIST_LIMIT/);
    expect(CANDIDATES_ROUTE_SRC).toMatch(
      /const MAX = CANDIDATE_LIST_LIMIT/,
    );
  });

  it("警告・強調はダークモード配色を持つ", () => {
    const warning = QUEUE_SRC.match(
      /data-testid="candidate-limit-warning"[\s\S]{0,300}/,
    );
    expect(warning?.[0] ?? "").toMatch(/dark:/);
  });
});

describe("5. 物件化モーダルの不動産番号 (任意)", () => {
  it("入力欄があり、payload に realEstateNumber を渡す", () => {
    expect(CONVERT_SRC).toMatch(/data-testid="convert-real-estate-number"/);
    expect(CONVERT_SRC).toMatch(
      /realEstateNumber:\s*realEstateNumber\.trim\(\)\s*\|\|\s*null/,
    );
    // 任意項目 (必須ガードに含めない)
    expect(CONVERT_SRC).toMatch(/任意/);
  });
});
