/**
 * 現地調査「1日運用」改善 3 点のソース静的検証。
 *
 * 1. 巡回開始の短縮: 地図上に「巡回を開始」直置き (パネル探索 → 2 タップ)
 * 2. 圏外時の巡回終了の脱出口: 「未送信の位置記録を破棄して終了」
 * 3. 位置記録の可視化: 巡回中の状態チップ (記録中/オフ・無音停止に気づける)
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
const TRIP_SRC = readSrc("src/components/field-survey/trip-controls.tsx");
const RECORDER_SRC = readSrc(
  "src/components/field-survey/use-field-survey-location-recorder.ts",
);
const RECORDER_CODE = stripComments(RECORDER_SRC);

describe("1. 巡回開始の短縮 (地図直置きボタン)", () => {
  it("巡回していない時のみ「巡回を開始」を地図に出す (パネル展開中は出さない)", () => {
    expect(MAP_SRC).toMatch(
      /\{!activeSession && !panelOpen && \([\s\S]{0,400}trip-quick-start/,
    );
    expect(MAP_SRC).toMatch(/巡回を開始/);
  });

  it("押下でパネルを開き、TripControls の開始確認 modal を直接出す", () => {
    const btn = MAP_SRC.match(
      /\{!activeSession && !panelOpen &&[\s\S]{0,900}?<\/button>/,
    );
    expect(btn).not.toBeNull();
    const m = btn?.[0] ?? "";
    expect(m).toMatch(/setPanelOpen\(true\)/);
    expect(m).toMatch(/startTripRef\.current\?\.\(\)/);
    expect(m).toMatch(/quickStartRef\.current = true/);
  });

  it("TripControls はハンドラを effect で登録し、idle 時のみ確認 modal を開く", () => {
    // effect 内 setState を避け、event 駆動 (登録した関数を親が呼ぶ) にする
    expect(TRIP_SRC).toMatch(/registerStartRequest\?\.\(requestStart\)/);
    expect(TRIP_SRC).toMatch(/registerStartRequest\?\.\(null\)/);
    expect(TRIP_SRC).toMatch(/if \(p === "idle"\) return "confirmStart"/);
  });

  it("session 取得中 (loading) に押されたら予約し、取得完了で確認 modal を開く", () => {
    // 取得中の空打ちを取りこぼさない: loading 中は予約し idle 確定時に開く
    expect(TRIP_SRC).toMatch(
      /if \(p === "loading"\) pendingStartRef\.current = true/,
    );
    // fetchActiveSession の解決 (active session 無し) で予約を消化する
    expect(TRIP_SRC).toMatch(
      /pendingStartRef\.current[\s\S]{0,120}?setPhase\("confirmStart"\)/,
    );
  });

  it("ボタン経由の開始成功でパネルを自動で畳む (撮影 FAB へ直行)", () => {
    expect(MAP_SRC).toMatch(
      /prevId === null && nextId !== null && quickStartRef\.current/,
    );
    // 手動のパネル開閉で quickStart 印をリセット (誤作動防止)
    expect(MAP_SRC).toMatch(
      /onTogglePanelOpen=\{\(\) => \{\s*quickStartRef\.current = false;/,
    );
  });
});

describe("2. 圏外時の巡回終了の脱出口", () => {
  it("recorder に discardBufferAndStop があり、fetch せず buffer を破棄する", () => {
    const fn = RECORDER_SRC.match(
      /const discardBufferAndStop = useCallback\([\s\S]*?\}, \[stopWatchingInternal\]\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/recorderGenerationRef\.current \+= 1/);
    expect(m).toMatch(/bufferRef\.current = \[\]/);
    expect(m).toMatch(/inFlightFlushRef\.current = false/);
    expect(m).not.toMatch(/\bfetch\(/);
    // hook の戻り値に含まれる (return object の shorthand 行)
    expect(RECORDER_SRC).toMatch(/\n\s+discardBufferAndStop,\r?\n/);
  });

  it("終了ブロック時に「破棄して終了」ボタンを出し、PATCH 成功後に破棄する", () => {
    expect(TRIP_SRC).toMatch(/setEndBlockedByBuffer\(true\)/);
    const btn = TRIP_SRC.match(
      /data-testid="trip-discard-and-end"[\s\S]{0,600}?<\/button>/,
    );
    expect(btn).not.toBeNull();
    const m = btn?.[0] ?? "";
    // 破棄 (recorder) は endSession に委ね、PATCH 成功後にのみ行う
    expect(m).toMatch(/void endSession\(session, \{ discardUnsent: true \}\)/);
    // offline で終了自体が失敗する場合に軌跡を失わないよう、破棄は
    // outcome.kind === "ok" の後で onDiscardUnsentLocations を呼ぶ
    expect(TRIP_SRC).toMatch(
      /outcome\.kind === "ok"[\s\S]{0,200}?onDiscardUnsentLocations\?\.\(\)/,
    );
    // 失うものと残るものを平易に説明する
    expect(TRIP_SRC).toMatch(/ピンと写真は保存済みです/);
  });

  it("失う軌跡の規模を実数 (bufferedCount) で示す (「数点」固定にしない)", () => {
    expect(TRIP_SRC).toMatch(/unsentLocationCount/);
    expect(TRIP_SRC).not.toMatch(/移動の記録 \(数点\)/);
    expect(MAP_SRC).toMatch(/unsentLocationCount=\{recorder\.bufferedCount\}/);
  });

  it("終了失敗の文言は通信起因の対処 (電波の良い場所で) を含む", () => {
    expect(TRIP_SRC).toMatch(/電波の良い場所で、もう一度「巡回終了」を押すと再送信します/);
    expect(TRIP_SRC).toMatch(/巡回終了に失敗しました。電波の良い場所で、もう一度お試しください。/);
  });

  it("map は recorder.discardBufferAndStop を TripControls へ配線する", () => {
    expect(MAP_SRC).toMatch(
      /onDiscardUnsentLocations=\{\(\) => recorder\.discardBufferAndStop\(\)\}/,
    );
  });
});

describe("3. 位置記録の可視化 (状態チップ)", () => {
  it("巡回中のみチップを表示し、記録中/準備中/オフで文言と配色を変える", () => {
    const chip = MAP_SRC.match(
      /data-testid="location-recording-chip"[\s\S]{0,2000}?<\/button>/,
    );
    expect(chip).not.toBeNull();
    const m = chip?.[0] ?? "";
    expect(m).toMatch(/位置記録中/);
    expect(m).toMatch(/位置記録の準備中…/);
    expect(m).toMatch(/位置記録オフ/);
    expect(m).toMatch(/recorder\.status === "recording"/);
    expect(m).toMatch(/recorder\.status === "preparing"/);
    // 位置記録は任意機能。オフは警告色 (amber) でなく中立の灰色にして
    // 常時オフの巡回で警告が鳴りっぱなしになるのを防ぐ。
    expect(m).not.toMatch(/amber/);
    expect(m).toMatch(/border-gray-300/);
    // タップでパネルを開き、記録の開始/停止操作へ誘導
    expect(m).toMatch(/setPanelOpen\(true\)/);
    // ダークモード配色
    expect(m).toMatch(/dark:/);
    // 巡回中のみ (CRLF/LF いずれの改行でも通るよう \s+ で連結)
    expect(MAP_SRC).toMatch(
      /\{activeSession && \(\s*<button\s+type="button"\s+data-testid="location-recording-chip"/,
    );
  });

  it("チップ・破棄経路とも座標を console に出さない (継続)", () => {
    expect(RECORDER_CODE).not.toMatch(/console\./);
  });
});
