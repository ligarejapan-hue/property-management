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

describe("ピン作成: GPS 精度表示 + 低精度警告", () => {
  it("既存 util (formatAccuracyMeters / isLowAccuracyForDisplay) を再利用する", () => {
    expect(MODAL).toMatch(
      /import \{[\s\S]*?formatAccuracyMeters,[\s\S]*?isLowAccuracyForDisplay,[\s\S]*?\} from "@\/lib\/field-survey-current-location-util"/,
    );
    expect(MODAL).toMatch(
      /const accuracyText = formatAccuracyMeters\(initialAccuracy\)/,
    );
    expect(MODAL).toMatch(
      /const lowAccuracy = isLowAccuracyForDisplay\(initialAccuracy\)/,
    );
  });

  it("accuracy がある時だけ位置精度を表示する (地図タップは非表示)", () => {
    expect(MODAL).toMatch(/initialAccuracy\?:\s*number \| null/);
    // accuracyText が "—" (accuracy 無し) の時は精度行を出さない
    expect(MODAL).toMatch(
      /\{accuracyText !== "—" &&[\s\S]{0,200}?data-testid="pin-create-accuracy"/,
    );
  });

  it("低精度のときだけ警告を出し、取り直し/修正を案内する", () => {
    const warn = MODAL.match(
      /\{lowAccuracy &&[\s\S]*?data-testid="pin-create-low-accuracy-warning"[\s\S]*?<\/p>/,
    );
    expect(warn).not.toBeNull();
    const m = warn?.[0] ?? "";
    expect(m).toMatch(/精度が低め/);
    // 取り直し (現在地を使う) と 修正 (地図タップ) の両導線を案内
    expect(m).toMatch(/現在地を使う/);
    expect(m).toMatch(/地図をタップ/);
  });

  it("map は createCandidate.accuracy を initialAccuracy として渡す", () => {
    expect(MAP).toMatch(
      /initialAccuracy=\{createCandidate\.accuracy \?\? null\}/,
    );
  });

  it("accuracy / 座標を console に出さない (継続ガード)", () => {
    // 精度・座標は表示専用。console/ログに流さない (PII 方針)。
    expect(MODAL).not.toMatch(/console\./);
  });
});
