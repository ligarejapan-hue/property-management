/**
 * 写真の端末内自動変換 (HEIC/大容量対策) の配線ソース静的検証。
 *
 * - upload hook が送信前に prepare を通し、変換後 file を送る
 * - 変換失敗はサーバーに投げず、平易な案内をエラー表示経路に流す
 * - 作成 modal は具体的な失敗理由 (互換性優先の案内など) を併記できる
 * - 変換モジュールは node import 安全 (browser API は存在ガード付き)
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

const HOOK_SRC = readSrc(
  "src/components/field-survey/use-field-survey-pin-photo-mutations.ts",
);
const PREPARE_SRC = readSrc("src/lib/field-survey-photo-prepare.ts");
const PREPARE_CODE = stripComments(PREPARE_SRC);
const MODAL_SRC = readSrc("src/components/field-survey/pin-create-modal.tsx");
const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");

describe("use-field-survey-pin-photo-mutations — 送信前の自動変換", () => {
  it("uploadPhoto は FormData 前に prepare を通し、変換後 file を送る", () => {
    const upload = HOOK_SRC.match(
      /const uploadPhoto\s*=\s*useCallback\([\s\S]*?\},\s*\[[^\]]*\],?\s*\);/,
    );
    expect(upload).not.toBeNull();
    const m = upload?.[0] ?? "";
    const prepareIdx = m.indexOf("prepareFieldSurveyPhotoForUpload(file)");
    const formIdx = m.indexOf("new FormData()");
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(formIdx).toBeGreaterThan(prepareIdx);
    // 生の file でなく変換後 (prepared.file) を append する
    expect(m).toMatch(/formData\.append\("file",\s*prepared\.file\)/);
    expect(m).not.toMatch(/formData\.append\("file",\s*file\)/);
  });

  it("変換失敗はサーバーへ送らず、案内文言を uploadError に流して返す", () => {
    const upload = HOOK_SRC.match(
      /const uploadPhoto\s*=\s*useCallback\([\s\S]*?\},\s*\[[^\]]*\],?\s*\);/,
    );
    const m = upload?.[0] ?? "";
    // setUploadState は unmount 後の setState を抑止するヘルパ経由で呼ぶ
    // (総点検 2026-07-27: 変換中に unmount しても送信は継続させるため)。
    expect(m).toMatch(
      /if\s*\(!prepared\.ok\)\s*\{[\s\S]*?setUploadStateIfMounted\(\{\s*loading:\s*false,\s*error:\s*prepared\.error\s*\}\)[\s\S]*?return\s*\{\s*ok:\s*false,\s*error:\s*prepared\.error\s*\}/,
    );
  });
});

describe("field-survey-photo-prepare.ts — node 安全 / 副作用なし", () => {
  it("browser API は存在ガード付きで、node import してもクラッシュしない", () => {
    expect(PREPARE_SRC).toMatch(/typeof createImageBitmap === "function"/);
    expect(PREPARE_SRC).toMatch(/typeof document === "undefined"/);
  });

  it("console / storage / fetch を使わない", () => {
    expect(PREPARE_CODE).not.toMatch(/console\./);
    expect(PREPARE_CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(PREPARE_CODE).not.toMatch(/\bfetch\(/);
  });

  it("PNG 透過対策で白背景を敷いてから JPEG 化する", () => {
    expect(PREPARE_SRC).toMatch(/fillStyle\s*=\s*"#ffffff"/);
    expect(PREPARE_SRC).toMatch(/toBlob\([\s\S]{0,80}"image\/jpeg"/);
  });

  it("objectURL fallback は失敗経路でも revoke する", () => {
    const revokes = PREPARE_SRC.match(/URL\.revokeObjectURL\(url\)/g) ?? [];
    expect(revokes.length).toBeGreaterThanOrEqual(2);
  });

  it("環境起因の生成失敗 (blob 全滅) はサイズ超過文言に誤帰属しない", () => {
    // getContext / toBlob が null の端末では一度もサイズ判定に到達しないため、
    // PHOTO_TOO_LARGE_MESSAGE でなく形式案内 (photoPrepareFailureMessage) を返す。
    expect(PREPARE_SRC).toMatch(/producedBlob/);
    expect(PREPARE_SRC).toMatch(
      /producedBlob\s*\?\s*PHOTO_TOO_LARGE_MESSAGE\s*:\s*photoPrepareFailureMessage/,
    );
  });
});

describe("pin-create-modal — 失敗中の写真差し替え", () => {
  it("失敗中も「写真を撮る/追加」は押せる (文言「別の写真を」と操作を一致)", () => {
    // 撮る/追加ボタンの disabled から photoUploadFailed を外す
    const cameraBtn = MODAL_SRC.match(
      /data-testid="pin-create-photo-camera"[\s\S]{0,300}/,
    );
    const addBtn = MODAL_SRC.match(
      /data-testid="pin-create-photo-add"[\s\S]{0,300}/,
    );
    // disabled 属性はボタン記述の testid より前にあるため、ボタン周辺全体で確認
    const buttons = MODAL_SRC.match(
      /<div className="flex gap-2">[\s\S]*?写真を追加[\s\S]{0,40}<\/button>/,
    );
    expect(buttons).not.toBeNull();
    expect(buttons?.[0] ?? "").not.toMatch(/busy\s*\|\|\s*photoUploadFailed/);
    expect(cameraBtn).not.toBeNull();
    expect(addBtn).not.toBeNull();
  });

  it("失敗中の選び直しは onReplaceRetryPhoto で親の再試行 file を差し替える", () => {
    expect(MODAL_SRC).toMatch(/onReplaceRetryPhoto\?:\s*\(file:\s*File\)/);
    expect(MODAL_SRC).toMatch(
      /if\s*\(photoUploadFailed\)\s*onReplaceRetryPhoto\?\.\(file\)/,
    );
    // 親は pendingPhotoFileRef を更新する
    expect(MAP_SRC).toMatch(
      /onReplaceRetryPhoto=\{\(file\)\s*=>\s*\{[\s\S]{0,200}pendingPhotoFileRef\.current\s*=\s*file/,
    );
  });
});

describe("pin-create-modal — 具体的な失敗理由の併記", () => {
  it("photoUploadErrorDetail prop を持ち、失敗ブロック内に表示する", () => {
    expect(MODAL_SRC).toMatch(/photoUploadErrorDetail\?:\s*string\s*\|\s*null/);
    expect(MODAL_SRC).toMatch(
      /data-testid="pin-create-photo-error-detail"/,
    );
    // 失敗ブロック (pin-create-photo-failed) の内側にある
    const failedBlock = MODAL_SRC.match(
      /data-testid="pin-create-photo-failed"[\s\S]*?写真なしで完了/,
    );
    expect(failedBlock?.[0] ?? "").toMatch(/photoUploadErrorDetail/);
  });

  it("親 (FieldSurveyMap) は uploadError を detail として渡す", () => {
    expect(MAP_SRC).toMatch(
      /photoUploadErrorDetail=\{photoMutations\.uploadError\}/,
    );
  });
});
