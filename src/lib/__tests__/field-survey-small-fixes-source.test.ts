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
      /onConverted=\{\(propertyId\)\s*=>\s*\{[\s\S]{0,400}router\.push\(`\/properties\/\$\{propertyId\}`\)/,
    );
  });

  it("property:read が無い構成では 403 へ飛ばさず一覧に留まり成功を案内する (Codex P2)", () => {
    // write のみ付与 (read 無し) は独立権限のため有効な構成。判定不能時も
    // 安全側 (留まる) に倒す。
    expect(QUEUE_SRC).toMatch(/canReadProperty/);
    const onConverted = QUEUE_SRC.match(
      /onConverted=\{\(propertyId\)\s*=>\s*\{[\s\S]*?\}\}/,
    );
    expect(onConverted).not.toBeNull();
    const m = onConverted?.[0] ?? "";
    expect(m).toMatch(/if\s*\(canReadProperty\)\s*\{[\s\S]*?router\.push/);
    expect(m).toMatch(/setConvertedNotice\(true\)/);
    expect(m).toMatch(/void load\(\)/);
    // 成功案内はダーク配色付きで表示される
    expect(QUEUE_SRC).toMatch(/data-testid="candidate-converted-notice"/);
    expect(QUEUE_SRC).toMatch(/物件を作成しました/);
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

  it("JST の日付境界で経過日数表示を自動更新する (開きっぱなしの夜跨ぎ対策)", () => {
    // Codex P2: ageBase が読込時のまま固定だと、日付を跨いでも「今日/昨日」や
    // 放置強調が更新されない。次の 0:00 JST への自己継続タイマーで更新する。
    expect(QUEUE_SRC).toMatch(/msUntilNextJstMidnight\(new Date\(\)\)/);
    const rollover = QUEUE_SRC.match(
      /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(!ageBase\)\s*return;[\s\S]*?\},\s*\[ageBase\]\);/,
    );
    expect(rollover).not.toBeNull();
    const m = rollover?.[0] ?? "";
    expect(m).toMatch(/setTimeout\([\s\S]{0,100}setAgeBase\(new Date\(\)\)/);
    // unmount / 再スケジュール時にタイマーを必ず片付ける
    expect(m).toMatch(/clearTimeout\(timer\)/);
  });

  it("上限は route と共有の CANDIDATE_LIST_LIMIT (乖離しない)", () => {
    expect(QUEUE_SRC).toMatch(/CANDIDATE_LIST_LIMIT/);
    expect(CANDIDATES_ROUTE_SRC).toMatch(
      /const MAX = CANDIDATE_LIST_LIMIT/,
    );
  });

  it("件数バッジは切り捨て時に「以上」を付ける (警告と矛盾しない)", () => {
    expect(QUEUE_SRC).toMatch(/truncated \? "件以上" : "件"/);
  });

  it("進入時に権限を再取得し、完了まで判定を保留する (stale 権限で遷移しない)", () => {
    // Codex P2: provider は layout mount 時のみ取得のため滞在中の権限変更に
    // 追従できない。ページ進入あたり 1 回 refetch し、pending 中は
    // canRead/canWriteProperty を false (安全側) に倒す。
    expect(QUEUE_SRC).toMatch(/refetchPermissions\(\)\.finally/);
    expect(QUEUE_SRC).toMatch(/permissionsRefreshRequestedRef/);
    const readDef = QUEUE_SRC.match(
      /const canReadProperty\s*=[\s\S]{0,200}?\.some/,
    );
    expect(readDef?.[0] ?? "").toMatch(/!permissionsRefreshPending/);
    const writeDef = QUEUE_SRC.match(
      /const canWriteProperty\s*=[\s\S]{0,200}?\.some/,
    );
    expect(writeDef?.[0] ?? "").toMatch(/!permissionsRefreshPending/);
  });

  it("並び順切替で古い候補へ到達できる (上限超過時の案内と矛盾しない)", () => {
    // Codex P2: 新しい順 200 件のみだと「古いものから処理して」と案内しつつ
    // 古い候補が開けない。allowlist の order パラメータ (newest/oldest) を追加。
    expect(CANDIDATES_ROUTE_SRC).toMatch(
      /searchParams\.get\("order"\)\s*===\s*"oldest"/,
    );
    expect(CANDIDATES_ROUTE_SRC).toMatch(/\{ createdAt: order \}/);
    expect(QUEUE_SRC).toMatch(/candidate-order-\$\{value\}/);
    expect(QUEUE_SRC).toMatch(/\["newest", "新しい順"\]/);
    expect(QUEUE_SRC).toMatch(/\["oldest", "古い順"\]/);
    expect(QUEUE_SRC).toMatch(/listCandidatePins\(order\)/);
    // 切替直後の遅延応答 (先行リクエスト) を破棄する世代ガード (Codex P2)
    expect(QUEUE_SRC).toMatch(/loadGenerationRef/);
    const loadFn = QUEUE_SRC.match(
      /const load = useCallback\([\s\S]*?\}, \[order\]\);/,
    );
    expect(loadFn).not.toBeNull();
    const generationChecks =
      (loadFn?.[0] ?? "").match(
        /generation !== loadGenerationRef\.current/g,
      ) ?? [];
    // 成功側・失敗側の両方でチェックする
    expect(generationChecks.length).toBeGreaterThanOrEqual(2);
    // 取得前に一覧をクリア (失敗時に反対側のデータが残って
    // トグル表示と食い違うのを防ぐ。Codex P2)
    expect(loadFn?.[0] ?? "").toMatch(
      /setRows\(null\);[\s\S]{0,40}setTruncated\(false\)/,
    );
    // 失敗時はスピナーを回し続けない (エラー表示のみ)
    expect(QUEUE_SRC).toMatch(/error \? null : \(/);
    // 警告文は並び順に応じて「どちら側が隠れているか」を正しく伝える
    expect(QUEUE_SRC).toMatch(/「古い順」に切り替える/);
    expect(QUEUE_SRC).toMatch(/古い順で表示中/);
  });

  it("上限警告は truncated フラグ基準 (ちょうど上限件数では誤警告しない)", () => {
    // Codex P2: 件数一致 (length >= LIMIT) では 200 件ちょうどと 201 件以上を
    // 区別できない。route が 1 件余分に取得して truncated を返し、UI はそれを見る。
    expect(CANDIDATES_ROUTE_SRC).toMatch(/take:\s*MAX \+ 1/);
    expect(CANDIDATES_ROUTE_SRC).toMatch(/truncated\s*=\s*rows\.length > MAX/);
    expect(CANDIDATES_ROUTE_SRC).toMatch(/apiResponse\(\{ data, truncated \}\)/);
    expect(QUEUE_SRC).toMatch(/truncated && \(/);
    expect(QUEUE_SRC).not.toMatch(/rows\.length >= CANDIDATE_LIST_LIMIT/);
  });

  it("警告・強調はダークモード配色を持つ", () => {
    const warning = QUEUE_SRC.match(
      /data-testid="candidate-limit-warning"[\s\S]{0,300}/,
    );
    expect(warning?.[0] ?? "").toMatch(/dark:/);
  });
});

describe("5. 物件化モーダルの不動産番号 (任意)", () => {
  it("入力欄があり、正規化した値を payload に渡す (生値保存で重複判定をすり抜けない)", () => {
    expect(CONVERT_SRC).toMatch(/data-testid="convert-real-estate-number"/);
    // Codex P2: 全角数字・区切り付きの生値を保存すると CSV 取込の重複判定
    // (完全一致) をすり抜ける → normalizeRealEstateNumber で正規化して送る
    expect(CONVERT_SRC).toMatch(/normalizeRealEstateNumber\(rawRen\)/);
    expect(CONVERT_SRC).toMatch(
      /realEstateNumber:\s*rawRen === "" \? null : normalizedRen/,
    );
    // 数字にならない/桁足らずの入力は黙って捨てず・保存もせず、その場エラー
    // (桁足らずでも値が入ると所在検索が誤無効化され、自動取得に不正番号が渡る)
    expect(CONVERT_SRC).toMatch(/不動産番号は13桁の数字で入力してください/);
    expect(CONVERT_SRC).toMatch(/\\d\{13\}/);
    // 任意項目 (必須ガードに含めない)
    expect(CONVERT_SRC).toMatch(/任意/);
  });
});
