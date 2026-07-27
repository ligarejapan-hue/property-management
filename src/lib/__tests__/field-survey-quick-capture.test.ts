import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { cameraFirstButtonState } from "@/lib/field-survey-camera-first";

// 巡回なし撮影 (field_survey:quick_capture)。
//
// 経営判断: アルバイトが巡回を開始しなくてもワンタッチで撮って登録できるようにする。
// ただし巡回外の pin は移動軌跡 (track_points) が残らず巡回履歴にも出ないため、
// 誰でも使える状態にはせず専用権限で絞る (既定はどのテンプレートにも付かない)。
//
// ここでは (1) 表示判定の純関数 (2) 権限の配線 (seed / migration / 管理画面2枚 /
// mock) (3) サーバ側 fail-closed ゲートの存在 を固定する。

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const MAP_SRC = read("src/components/field-survey/field-survey-map.tsx");
const PINS_ROUTE_SRC = read("src/app/api/field-survey/pins/route.ts");
const SEED_SRC = read("prisma/seed.ts");
const USERS_PERM_SRC = read(
  "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
);
const TEMPLATES_PERM_SRC = read(
  "src/app/(dashboard)/admin/templates/[id]/page.tsx",
);
const API_HELPERS_SRC = read("src/lib/api-helpers.ts");
const MIGRATION_SRC = read(
  "prisma/migrations/20260727120000_add_field_survey_quick_capture_permission/migration.sql",
);

describe("cameraFirstButtonState — 巡回なし撮影の表示判定", () => {
  const base = {
    canWrite: true,
    phase: "idle" as const,
    modalOpen: false,
  };

  it("巡回中でなく権限も無ければ従来どおり出さない", () => {
    expect(
      cameraFirstButtonState({
        ...base,
        hasActiveSession: false,
        canCaptureWithoutTrip: false,
      }).visible,
    ).toBe(false);
  });

  it("巡回中でなくても quick_capture があれば出す", () => {
    expect(
      cameraFirstButtonState({
        ...base,
        hasActiveSession: false,
        canCaptureWithoutTrip: true,
      }).visible,
    ).toBe(true);
  });

  it("権限判定が不能 (null) のときは出さない (押させて 403 にしない)", () => {
    expect(
      cameraFirstButtonState({
        ...base,
        hasActiveSession: false,
        canCaptureWithoutTrip: null,
      }).visible,
    ).toBe(false);
  });

  it("巡回中は権限の有無によらず出す (従来の動作を変えない)", () => {
    for (const canQuick of [false, true, null]) {
      expect(
        cameraFirstButtonState({
          ...base,
          hasActiveSession: true,
          canCaptureWithoutTrip: canQuick,
        }).visible,
      ).toBe(true);
    }
  });

  it("modal 表示中・地図タップ待ちでは巡回外でも出さない (二重起動防止は不変)", () => {
    expect(
      cameraFirstButtonState({
        ...base,
        hasActiveSession: false,
        canCaptureWithoutTrip: true,
        modalOpen: true,
      }).visible,
    ).toBe(false);
    expect(
      cameraFirstButtonState({
        ...base,
        hasActiveSession: false,
        canCaptureWithoutTrip: true,
        phase: "awaiting-map-tap",
      }).visible,
    ).toBe(false);
  });

  it("write が false 確定なら巡回外でも押下不可 (disabled は従来どおり)", () => {
    expect(
      cameraFirstButtonState({
        ...base,
        canWrite: false,
        hasActiveSession: false,
        canCaptureWithoutTrip: true,
      }).disabled,
    ).toBe(true);
  });
});

describe("サーバ側 fail-closed ゲート (POST /api/field-survey/pins)", () => {
  it("sessionId 無しの作成に quick_capture を要求する", () => {
    expect(PINS_ROUTE_SRC).toMatch(
      /!input\.sessionId\s*&&\s*\n?\s*!hasPermission\(permissions,\s*"field_survey",\s*"quick_capture"\)/,
    );
    expect(PINS_ROUTE_SRC).toMatch(/QUICK_CAPTURE_FORBIDDEN/);
  });

  it("既存の write ゲートは残す (quick_capture だけでは作れない)", () => {
    expect(PINS_ROUTE_SRC).toMatch(
      /hasPermission\(permissions,\s*"field_survey",\s*"write"\)/,
    );
  });

  it("PATCH の巡回紐づけ解除も同じ権限を要求する (POST ゲートの迂回防止)", () => {
    // 「巡回中に作ってから紐づけを外す」で巡回外ピンを作れてしまうと
    // POST 側のゲートが無意味になる。同じ quick_capture を要求する。
    const patchSrc = read("src/app/api/field-survey/pins/[id]/route.ts");
    expect(patchSrc).toMatch(
      /patch\.sessionId === null &&\s*\n?\s*existing\.sessionId !== null &&\s*\n?\s*!hasPermission\(permissions,\s*"field_survey",\s*"quick_capture"\)/,
    );
    expect(patchSrc).toMatch(/QUICK_CAPTURE_FORBIDDEN/);
  });
});

const CREATE_MODAL_SRC = read("src/components/field-survey/pin-create-modal.tsx");

describe("巡回外は種類を候補に固定する (@codex R1: 初期値だけでは固定にならない)", () => {
  it("modal は sessionId 無しのとき種類のラジオを出さず候補固定を表示する", () => {
    expect(CREATE_MODAL_SRC).toMatch(/const lockPinType = sessionId === null;/);
    // 固定時は初期引き継ぎ (lastPinType) より候補を優先する
    expect(CREATE_MODAL_SRC).toMatch(
      /lockPinType \? "candidate" : \(initialPinType \?\? "candidate"\)/,
    );
    // ラジオ群は固定時に描画しない (選べてしまうと孤児ピンが作れる)
    expect(CREATE_MODAL_SRC).toMatch(
      /\{lockPinType \? \([\s\S]{0,600}?data-testid="pin-create-type-locked"/,
    );
    // 固定時はラジオ (pin-create-type-<種類>) を出さない構造であること
    expect(CREATE_MODAL_SRC).toMatch(
      /\) : \([\s\S]{0,400}?FIELD_SURVEY_PIN_TYPES\.map/,
    );
    // 理由も見せる (現場で「なぜ選べない」を迷わせない)
    expect(CREATE_MODAL_SRC).toMatch(/物件化の完成待ち」に必ず出すため/);
  });

  it("更新側も不変条件を守る: 巡回外で候補以外になる更新を拒否 (@codex #328 R1 P1)", () => {
    const patchSrc = read("src/app/api/field-survey/pins/[id]/route.ts");
    // 更新後の姿 (sessionId / pinType) で判定する。作成時だけ守っても
    // ①巡回外ピンの種類変更 ②候補以外ピンの巡回解除 で同じ状態が作れる。
    expect(patchSrc).toMatch(
      /const nextSessionId =[\s\S]{0,120}?patch\.sessionId !== undefined \? patch\.sessionId : existing\.sessionId;/,
    );
    expect(patchSrc).toMatch(
      /const nextPinType = patch\.pinType \?\? existing\.pinType;/,
    );
    expect(patchSrc).toMatch(
      /nextSessionId === null && nextPinType !== "candidate"/,
    );
    expect(patchSrc).toMatch(/QUICK_CAPTURE_PIN_TYPE/);
    // check-then-write の競合で孤児状態を作られないよう、判定の根拠列を
    // where に含めた CAS (updateMany + 件数 0 で 409) で更新する。
    expect(patchSrc).toMatch(
      /updateMany\(\{[\s\S]{0,240}?sessionId: existing\.sessionId,[\s\S]{0,80}?pinType: existing\.pinType,/,
    );
    expect(patchSrc).toMatch(/casResult\.count === 0/);
    expect(patchSrc).toMatch(/CONCURRENT_UPDATE/);
  });

  it("サーバも巡回外の候補以外を拒否する (API 直叩きでも孤児ピンを作れない)", () => {
    expect(PINS_ROUTE_SRC).toMatch(
      /!input\.sessionId && input\.pinType !== "candidate"/,
    );
    expect(PINS_ROUTE_SRC).toMatch(/QUICK_CAPTURE_PIN_TYPE/);
  });
});

describe("クライアント配線 (field-survey-map)", () => {
  it("provider 配布の権限から canQuickCapture を導出する", () => {
    expect(MAP_SRC).toMatch(
      /p\.action === "quick_capture" &&\s*\n?\s*p\.granted === true/,
    );
    expect(MAP_SRC).toMatch(/canCaptureWithoutTrip: canQuickCapture/);
  });

  it("巡回中は sessionId を必ず付ける (session touch = 放置確認/自動終了の誤発火防止)", () => {
    expect(MAP_SRC).toMatch(/sessionId: activeSession\?\.id/);
    // 巡回中に無条件で null を送る実装になっていないこと
    expect(MAP_SRC).not.toMatch(/sessionId: null,\s*\n\s*pinType/);
  });

  it("巡回外は撮影ボタンと巡回開始ボタンを横並びにする (座標が重ならない)", () => {
    // 両方が bottom-14 left-1/2 -translate-x-1/2 を占めると完全に重なるため、
    // 巡回外の枠は flex 行にして CameraFirstButton を inline で描画する。
    expect(MAP_SRC).toMatch(
      /\{!activeSession && !panelOpen && \([\s\S]{0,300}flex -translate-x-1\/2/,
    );
    expect(MAP_SRC).toMatch(/<CameraFirstButton\s*\n?\s*inline/);
  });

  it("地図の吹き出しは巡回なしを「巡回外の撮影」と表示する", () => {
    expect(MAP_SRC).toMatch(/row\.sessionId \? "あり" : "巡回外の撮影"/);
  });

  it("撮影中に巡回が開始されても撮影を破棄しない (@codex R1)", () => {
    // 巡回外→巡回中の遷移だけは resetCameraFirst を呼ばない。呼ぶと
    // 隣の「巡回を開始」を押した瞬間に撮った写真が消える。
    expect(MAP_SRC).toMatch(
      /if \(prevId !== null \|\| nextId === null\) \{\s*\n?\s*resetCameraFirst\(\);/,
    );
  });

  it("巡回外の作成 modal でも「現在地を使う」の再取得を許す (@codex R1)", () => {
    // 位置情報が一時的に失敗した後・その場で許可を出し直した後に再取得できないと
    // 巡回外フローが詰む。modal が開いている間は null session でも通す。
    expect(MAP_SRC).toMatch(
      /if \(!requestSessionId && !createCandidateOpenRef\.current\) \{/,
    );
    // 遅延 callback の session ガードも巡回中に限定する (巡回外の取得を捨てない)。
    expect(MAP_SRC).toMatch(
      /requestSessionId !== null &&\s*\n?\s*activeSessionIdRef\.current !== requestSessionId/,
    );
  });
});

describe("権限の配線 (既定は誰も持たない fail-closed)", () => {
  it("seed は管理者テンプレートにだけ付与する", () => {
    expect(SEED_SRC).toMatch(
      /adminTemplate\.id, resource: "field_survey", action: "quick_capture", granted: true/,
    );
    for (const t of ["fieldStaffTemplate", "officeStaffTemplate"]) {
      expect(SEED_SRC).not.toMatch(
        new RegExp(`${t}\\.id, resource: "field_survey", action: "quick_capture"`),
      );
    }
  });

  it("本番反映用の migration は DDL を持たない冪等な INSERT だけ", () => {
    expect(MIGRATION_SRC).toMatch(/INSERT INTO "template_permissions"/);
    expect(MIGRATION_SRC).toMatch(/ON CONFLICT .*DO NOTHING/);
    expect(MIGRATION_SRC).toMatch(/WHERE pt\."name" = '管理者用'/);
    // DDL (テーブル/列/型の変更) を含めない = rollback でスキーマが壊れない
    expect(MIGRATION_SRC).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP /i);
  });

  it("管理画面2枚に同じ行がある (片方だけだと付与できず必ず403になる)", () => {
    for (const src of [USERS_PERM_SRC, TEMPLATES_PERM_SRC]) {
      expect(src).toMatch(
        /key: "field_survey",[\s\S]{0,120}"quick_capture"/,
      );
      // 英語コードの生表示を避ける
      expect(src).toMatch(/quick_capture: "巡回なしで撮影"/);
      expect(src).toMatch(/read_all: "全員分の閲覧"/);
      expect(src).toMatch(/manage: "他の人の分も編集"/);
    }
  });

  it("mock 権限 (dev) にも入れる (入れないと dev で常に403)", () => {
    expect(API_HELPERS_SRC).toMatch(
      /resource: "field_survey", action: "quick_capture", granted: true/,
    );
  });
});
