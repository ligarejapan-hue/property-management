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
    // @codex P2 R6/R7: idle にはしない (PATCH 中に新 watch を開始させない)。
    // 直前 flush が通常失敗して idle になっていても、明示的に "stopping"
    // (非 startable) へ倒す。
    expect(m).toMatch(/setStatus\("stopping"\)/);
    expect(m).not.toMatch(/setStatus\("idle"\)/);
    // hook の戻り値に含まれる
    expect(RECORDER_SRC).toMatch(/\n\s+abortInFlightFlush,\r?\n/);
  });

  it("recorder 復帰は reconcile が active を返した時のみ (unknown/ended は復帰しない)", () => {
    // @codex P2 R6/P1 R9-R10: PATCH 中は "stopping" 固着で新 watch 開始を防ぎ、
    // reconcile が active を返した (= session が確実に未終了) 時だけ recorder を
    // idle に戻す。ended は reset effect が片付け、unknown は状態不明ゆえ復帰
    // させない (新 watch を開始させない)。
    const fn = RECORDER_SRC.match(
      /const restoreIdleAfterFailedEnd = useCallback\([\s\S]*?\}, \[\]\);/,
    );
    expect(fn).not.toBeNull();
    expect(fn?.[0] ?? "").toMatch(/setStatus\("idle"\)/);
    expect(RECORDER_SRC).toMatch(/\n\s+restoreIdleAfterFailedEnd,\r?\n/);
    // active 分岐でのみ recorder 復帰 (かつ @codex R14/R15: commit し得ない時のみ)
    expect(TRIP_SRC).toMatch(
      /reconciled\.kind === "active"[\s\S]{0,800}?if \(!outstandingEndMayCommitRef\.current\) onEndFailedRestoreRecorder\?\.\(\)/,
    );
    // unknown 分岐は session/buffer を消さず active に戻す (recorder は復帰しない)
    expect(TRIP_SRC).toMatch(
      /reconciled\.kind === "unknown"[\s\S]{0,320}?setPhase\("active"\)/,
    );
    // map が配線する
    expect(MAP_SRC).toMatch(/recorder\.restoreIdleAfterFailedEnd\(\)/);
  });

  it("commit し得る失敗 (timeout/network/5xx) は active reconcile でも復帰しない (@codex P1 R14/R15)", () => {
    // client abort は server 側の commit を止めない。単発 reconcile が active でも
    // 遅延 commit と記録再開がレースし新規点が 409 で失われるため、commit し得る
    // 間は recorder を stopping のまま残し、ユーザーの終了再試行で確定させる。
    expect(TRIP_SRC).toMatch(/let mutationMayHaveCommitted = false/);
    // 5xx 応答は commit 済みかも / 4xx は明確に未 commit
    expect(TRIP_SRC).toMatch(/mutationMayHaveCommitted = res\.status >= 500/);
    // timeout / network も送信済みかも
    expect(TRIP_SRC).toMatch(/mutationMayHaveCommitted = true/);
    // @codex R15: 再試行を跨いで保持する session 単位 ref に累積する。
    expect(TRIP_SRC).toMatch(
      /const outstandingEndMayCommitRef = useRef\(false\)/,
    );
    expect(TRIP_SRC).toMatch(
      /if \(mutationMayHaveCommitted\) outstandingEndMayCommitRef\.current = true/,
    );
    // 復帰判定は ref を見る (local ではない)
    expect(TRIP_SRC).toMatch(
      /if \(!outstandingEndMayCommitRef\.current\) onEndFailedRestoreRecorder\?\.\(\)/,
    );
    // 確実な終了 (200 OK / reconcile ended) と新規 session 開始で解除する
    const clears =
      TRIP_SRC.match(/outstandingEndMayCommitRef\.current = false/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });

  it("曖昧な終了の間は両経路とも recorder を stopping + watch 停止する (@codex P1 R11/R13)", () => {
    // 通常終了は flush 成功で idle のため、PATCH commit + 応答喪失 + reconcile
    // unknown で active に戻すと記録再開→409 で失われる。終了フローの早い段階で
    // blockRecorderForPendingEnd で stopping にし、active 確認まで解除しない。
    const fn = RECORDER_SRC.match(
      /const blockRecorderForPendingEnd = useCallback\([\s\S]*?\}, \[stopWatchingInternal\]\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/setStatus\("stopping"\)/);
    // @codex R13: watch 停止 + generation bump + in-flight abort で snuck-in
    // watch を残さない。buffer は消さない。
    expect(m).toMatch(/stopWatchingInternal\(\)/);
    expect(m).toMatch(/recorderGenerationRef\.current \+= 1/);
    expect(m).toMatch(/flushAbortRef\.current\.abort\(\)/);
    expect(m).not.toMatch(/bufferRef\.current = \[\]/);
    expect(RECORDER_SRC).toMatch(/\n\s+blockRecorderForPendingEnd,\r?\n/);
    // @codex R13: block は touch await より前に呼ぶ (touch 最大 8 秒の間に idle
    // で「位置記録開始」が露出するのを防ぐ)。
    expect(TRIP_SRC).toMatch(
      /onBlockRecorderForEnd\?\.\(\)[\s\S]{0,900}?if \(resumedRef\.current === target\.id/,
    );
    // map が配線する
    expect(MAP_SRC).toMatch(/recorder\.blockRecorderForPendingEnd\(\)/);
  });

  it("既存 active session 復元時は予約 quick-start をクリアする (@codex P2)", () => {
    // 放置しておくと後の refresh (別クライアント終了→conflict 再取得) が
    // 古い予約を消化して再調整/終了中に開始確認 modal を開いてしまう。
    expect(TRIP_SRC).toMatch(/if \(own\) pendingStartRef\.current = false/);
  });

  it("非 200 の終了結果はすべて曖昧として reconcile する (@codex P1)", () => {
    // session 終了 API が無応答でも phase="ending" 固着で UI が無効化されない。
    // timeout / 5xx / conflict / network はいずれも「server が終了を commit した
    // か不明」= 曖昧。active 決め打ちでなく reconcile で真の状態に整合する。
    expect(TRIP_SRC).toMatch(/END_PATCH_TIMEOUT_MS/);
    expect(TRIP_SRC).toMatch(/patchTimedOut = true/);
    expect(TRIP_SRC).toMatch(/ambiguous = true/);
    // 非 ok / catch とも ambiguous にし、try/catch/finally の外で reconcile する
    expect(TRIP_SRC).toMatch(/if \(!ambiguous \|\| !mountedRef\.current\) return/);
    expect(TRIP_SRC).toMatch(
      /await fetchActiveSession\(\{\s*timeoutMs: RECONCILE_TIMEOUT_MS,\s*preserveOnFailure: true,?\s*\}\)/,
    );
    // patch timer は finally で解除する
    expect(TRIP_SRC).toMatch(/finally \{\s*clearTimeout\(patchTimer\)/);
  });

  it("reconcile GET 自体にも timeout があり、失敗は unknown で判定不能 (@codex P1)", () => {
    // GET が blackhole でも終了脱出口が固まらない。失敗時は session を消さず
    // unknown を返す (integrity: 終了整合中に buffer/points を失わない)。
    expect(TRIP_SRC).toMatch(/RECONCILE_TIMEOUT_MS/);
    expect(TRIP_SRC).toMatch(
      /if \(opts\?\.timeoutMs\)[\s\S]{0,140}?setTimeout\(\(\) => ac\.abort\(\)/,
    );
    // 3 値の結果を返す
    expect(TRIP_SRC).toMatch(/Promise<ReconcileResult>/);
    expect(TRIP_SRC).toMatch(
      /return own \? \{ kind: "active", session: own \} : \{ kind: "ended" \}/,
    );
    // preserveOnFailure 経路は session を消さず unknown
    expect(TRIP_SRC).toMatch(
      /if \(opts\?\.preserveOnFailure\)[\s\S]{0,160}?return \{ kind: "unknown" \}/,
    );
  });

  it("flushAllBufferedChunks は drain 全体を generation でガードする (@codex P2)", () => {
    // abort/discard 後に本ループが新規 flush を始めると、その POST は更新後の
    // generation を捕捉して flushBuffer 内 stale guard に掛からず、破棄予定の
    // 点を送ってしまう。await 明けと各再送の前後で generation を確認して打ち切る。
    const fn = RECORDER_SRC.match(
      /const flushAllBufferedChunks = useCallback\([\s\S]*?\}, \[flushBuffer\]\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/const myGeneration = recorderGenerationRef\.current/);
    const guards =
      m.match(/recorderGenerationRef\.current !== myGeneration/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it("stopBeforeSessionEnd は superseded 時に UI state を上書きしない (generation guard)", () => {
    expect(RECORDER_SRC).toMatch(
      /const myGeneration = recorderGenerationRef\.current/,
    );
    expect(RECORDER_SRC).toMatch(
      /recorderGenerationRef\.current !== myGeneration\) return drained/,
    );
  });

  it("破棄経路では best-effort touch も省く (touch ハングで脱出口が固まらない)", () => {
    // @codex P2 R4: touchSession は signal/timeout 無し。discardUnsent 経路で
    // await すると touch 無応答時に phase="ending" 固着で PATCH に到達できない。
    expect(TRIP_SRC).toMatch(
      /if \(resumedRef\.current === target\.id && !opts\?\.discardUnsent\)/,
    );
  });

  it("通常終了の best-effort touch にも timeout/abort を付ける (@codex P1 R12)", () => {
    // 続行済み stale session の通常終了で touch PATCH が blackhole しても、
    // 永久待機せず先へ進む (phase="ending" 固着を防ぐ)。
    const fn = TRIP_SRC.match(
      /const touchSession = useCallback\([\s\S]*?\[fetchActiveSession\],\s*\);/,
    );
    expect(fn).not.toBeNull();
    const m = fn?.[0] ?? "";
    expect(m).toMatch(/TOUCH_TIMEOUT_MS/);
    expect(m).toMatch(/setTimeout\(\(\) => ac\.abort\(\)/);
    expect(m).toMatch(/signal: ac\.signal/);
    expect(m).toMatch(/clearTimeout\(timer\)/);
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
