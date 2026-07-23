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

  it("破棄経路は flush hook を呼ばない (endpoint 停止で脱出口が再度固まらない)", () => {
    // @codex P2: discardUnsent 指定時は onBeforeSessionEnd (track-point 再送を
    // 試みる flush hook) を呼ばず PATCH へ進む。env=node の SSR テストでは
    // 実 fetch 回数を検証できないため、hook 呼び出しが !discardUnsent で
    // ガードされていることをソース構造で固定する。
    expect(TRIP_SRC).toMatch(
      /if \(onBeforeSessionEnd && !opts\?\.discardUnsent\)/,
    );
  });

  it("flush が settle しない (ハング) 場合も timeout で脱出口へ到達できる", () => {
    // @codex P2 R2: await onBeforeSessionEnd() が応答なしで固まると phase が
    // "ending" のままになり「破棄して終了」に到達できない。timeout と race して
    // 一定時間で「終了ブロック」に倒し、脱出口を必ず出す。
    expect(TRIP_SRC).toMatch(/Promise\.race\(\[/);
    expect(TRIP_SRC).toMatch(/END_FLUSH_SETTLE_TIMEOUT_MS/);
    expect(TRIP_SRC).toMatch(/timedOut = true/);
    // timeout 経路は通信起因の対処 + 破棄導線を案内する専用文言
    expect(TRIP_SRC).toMatch(/位置情報の送信が完了しません/);
  });

  it("破棄前に進行中 flush を中断し、buffer は PATCH 成功まで保持する (@codex P2)", () => {
    // discard 経路の冒頭 (PATCH より前) で onAbortPendingFlush を呼ぶ。
    // timeout race に負けた drain の遅延応答が破棄予定の点を送るのを防ぐ。
    expect(TRIP_SRC).toMatch(
      /if \(opts\?\.discardUnsent\) \{\s*onAbortPendingFlush\?\.\(\)/,
    );
    // map は recorder.abortInFlightFlush を配線する
    expect(MAP_SRC).toMatch(
      /onAbortPendingFlush=\{\(\) => recorder\.abortInFlightFlush\(\)\}/,
    );
  });

  it("abortInFlightFlush は generation bump + fetch abort だが buffer は残す", () => {
    const fn = RECORDER_SRC.match(
      /const abortInFlightFlush = useCallback\([\s\S]*?\}, \[\]\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/recorderGenerationRef\.current \+= 1/);
    expect(m).toMatch(/flushAbortRef\.current\.abort\(\)/);
    // buffer / count は消さない (終了 PATCH の成否確定後に破棄/保全)
    expect(m).not.toMatch(/bufferRef\.current = \[\]/);
    expect(m).not.toMatch(/setBufferedCount\(0\)/);
    // hook の戻り値に含まれる
    expect(RECORDER_SRC).toMatch(/\n\s+abortInFlightFlush,\r?\n/);
  });

  it("stopBeforeSessionEnd は superseded 時に UI state を上書きしない (generation guard)", () => {
    expect(RECORDER_SRC).toMatch(
      /const myGeneration = recorderGenerationRef\.current/,
    );
    expect(RECORDER_SRC).toMatch(
      /recorderGenerationRef\.current !== myGeneration\) return drained/,
    );
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
  it("巡回中のみチップを表示し、記録中/準備中/エラー/オフで文言と配色を変える", () => {
    const chip = MAP_SRC.match(
      /data-testid="location-recording-chip"[\s\S]{0,2400}?<\/button>/,
    );
    expect(chip).not.toBeNull();
    const m = chip?.[0] ?? "";
    expect(m).toMatch(/位置記録中/);
    expect(m).toMatch(/位置記録の準備中…/);
    expect(m).toMatch(/位置記録オフ/);
    expect(m).toMatch(/recorder\.status === "recording"/);
    expect(m).toMatch(/recorder\.status === "preparing"/);
    // @codex P2: 権限拒否・取得不可などの error は「意図的オフ」と区別して
    // 琥珀色で明示する (静かに止まったのを見逃さない)。
    expect(m).toMatch(/recorder\.status === "error"/);
    expect(m).toMatch(/位置記録エラー/);
    expect(m).toMatch(/border-amber-400/);
    // 一方、意図的な「オフ」は警告色でなく中立の灰色 (任意機能なので
    // 常時オフの巡回で警告が鳴りっぱなしにならないようにする)。
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
