/**
 * ピン作成モーダルの GPS 精度表示 + 低精度警告のソース静的検証。
 *
 * 現在地 / カメラファーストで自動配置したピンは、GPS 精度が悪い (>しきい値) と
 * 実際の家から離れた所に落ちる。事務所は後からどの建物か特定できない。accuracy は
 * 既に親 state (createCandidate.accuracy) にあるのに未表示だったので、値と低精度
 * 警告を出して保存前に取り直し/修正を促す。既存の純関数 util を再利用する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const MODAL = readSrc("src/components/field-survey/pin-create-modal.tsx");
const MAP = readSrc("src/components/field-survey/field-survey-map.tsx");

describe("ピン作成: GPS 精度表示は廃止 (2026-07-29)", () => {
  // 位置を必ず地図タップで決めるようにしたので、GPS の精度はピンの位置と
  // 無関係になった。「精度が低い」と出しても直しようがなく、判断を濁らせる。
  // ⚠位置記録（巡回の軌跡）側の精度表示は別用途なので残っている。
  it("作成モーダルに精度表示・低精度警告を持たない", () => {
    expect(MODAL).not.toMatch(/pin-create-accuracy/);
    expect(MODAL).not.toMatch(/pin-create-low-accuracy-warning/);
    expect(MODAL).not.toMatch(/formatAccuracyMeters|isLowAccuracyForDisplay/);
  });

  it("地図は accuracy を作成モーダルへ渡さない", () => {
    expect(MAP).not.toMatch(/initialAccuracy/);
  });

  it("位置記録側の精度表示は残す (別用途なので消さない)", () => {
    const status = readSrc(
      "src/components/field-survey/current-location-status.tsx",
    );
    expect(status).toMatch(/field-survey-current-location-util/);
  });

  // 継続: 座標を console に出さない
  it("console に座標を出さない (継続)", () => {
    expect(MODAL).not.toMatch(/console\./);
  });
});
