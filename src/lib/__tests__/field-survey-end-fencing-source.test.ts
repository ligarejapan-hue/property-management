/**
 * 巡回終了の確実化 (#317) — 終了 commit の活動フェンス化のソース検証。
 *
 * 設計 (@codex R1〜R7 で確定した最終形。世代カウンタ activitySeq を追加する
 * additive migration を含む):
 *  1. 「位置記録の開始」だけが世代 (activitySeq) を +1 する (fence: true の
 *     touch)。flush は世代を進めない (終了フロー自身の drain がピンを壊さない)。
 *     整数の単調増加 = 時計・ms 精度・遅延に依存しない。
 *  2. 終了/キャンセルは「client が終了意図の時点 (drain より前) に読み取り GET
 *     でピンした世代 (expectedActivitySeq) と等値」の時のみ commit できる
 *     (tokenless は schema で拒否)。意図より後に記録が再開された終了は、
 *     リクエストがどの段階で遅延していても必ず不成立になる。読み取りは何も
 *     書かないため、遅延・陳腐化した GET は古いピン = 安全側にしか倒れない。
 *  3. 「位置記録開始」は watch 開始前にフェンス touch を打つ (2xx の成立確認時
 *     のみ開始・409/404 は終了検知・その他は再試行ブロック)。
 *
 * vitest は env=node のため、hook の実挙動はソース静的検証 + route 挙動テスト
 * (field-survey-sessions-route.test.ts) で担保する。改行固定アンカーは使わない
 * (CRLF working tree 対策)。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { classifyStartFence } from "@/lib/field-survey-trip-util";

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
}

const ROUTE_SRC = readSrc(
  "src/app/api/field-survey/sessions/[id]/route.ts",
);
const RECORDER_SRC = readSrc(
  "src/components/field-survey/use-field-survey-location-recorder.ts",
);
const TRIP_SRC = readSrc("src/components/field-survey/trip-controls.tsx");
const MAP_SRC = readSrc("src/components/field-survey/field-survey-map.tsx");

describe("classifyStartFence — フェンス touch 応答の分類 (純関数)", () => {
  it("409 (終了済み) / 404 (session 消失) は終了検知としてブロックする", () => {
    expect(classifyStartFence(409)).toBe("blocked-ended");
    expect(classifyStartFence(404)).toBe("blocked-ended");
  });

  it("2xx (フェンス成立を確認) のみ開始を許可する", () => {
    expect(classifyStartFence(200)).toBe("proceed");
    expect(classifyStartFence(204)).toBe("proceed");
  });

  it("成立を確認できない失敗 (null/5xx/401/403 等) は再試行ブロック (@codex P1)", () => {
    // fail-open だと「touch だけ timeout/5xx して後続 GET が通る」劣化網で
    // フェンス未成立のまま記録が始まり、遅延終了 commit に負けて以降の点を
    // 失う。開始は元々既存ルート取得 GET 必須 (オフライン開始は従来から不可)
    // なので、fail-closed にしても失う動作は無い。
    expect(classifyStartFence(null)).toBe("blocked-retry");
    expect(classifyStartFence(500)).toBe("blocked-retry");
    expect(classifyStartFence(401)).toBe("blocked-retry");
    expect(classifyStartFence(403)).toBe("blocked-retry");
    expect(classifyStartFence(422)).toBe("blocked-retry");
  });
});

describe("route — 終了 commit の活動フェンス (世代等値 + stale の updatedAt 併用)", () => {
  it("終了/キャンセルの updateMany は世代等値 (+ stale は updatedAt 等値) を条件にする", () => {
    // 終了/キャンセル分岐の updateMany を掴む
    const block =
      ROUTE_SRC.match(
        /if \(patch\.status === "ended" \|\| patch\.status === "cancelled"\) \{[\s\S]*?INVALID_STATE/,
      )?.[0] ?? "";
    expect(block).not.toBe("");
    // @codex R2〜R7: server 側で観測する値では遅延を区別できない。client が
    // 意図時点にピン留めした世代の等値を条件にする。token 無し (deploy を
    // 跨いだ旧タブ) は従来条件で受ける (R8: 拒否すると reload まで終了不能)。
    expect(block).toMatch(
      /\.\.\.\(patch\.expectedActivitySeq !== undefined && \{\s*activitySeq: patch\.expectedActivitySeq,?\s*\}\)/,
    );
    // @codex R8: stale 終了は flush (世代を進めない) の割り込みを検出するため
    // 読取時 updatedAt 等値も併用する
    expect(block).toMatch(/isStaleEnd && \{ updatedAt: existing\.updatedAt \}/);
    expect(block).not.toMatch(/updatedAt:\s*fenceToken/);
    // 到着時刻フォールバック自体を廃止 (R4)
    expect(ROUTE_SRC).not.toMatch(/requestArrivedAt/);
  });

  it("世代を進めるのはフェンス touch のみ・flush は進めない (@codex R7)", () => {
    // フェンス (記録開始) だけが世代を +1 する。条件は持たない = 遅延した
    // フェンスも「古いピンの終了を弾く」安全方向にしか働かない。
    expect(ROUTE_SRC).toMatch(
      /patch\.fence && \{ activitySeq: \{ increment: 1 \} \}/,
    );
    // flush (track-points) は世代を進めない = 終了フロー自身の drain が
    // 意図時点のピンを壊さない。
    const TRACK_SRC = readSrc(
      "src/app/api/field-survey/sessions/[id]/track-points/route.ts",
    );
    expect(TRACK_SRC).not.toMatch(/activitySeq:\s*\{\s*increment/);
  });

  it("世代ピンは終了意図の時点 (drain より前) に取る (@codex R7)", () => {
    const TRIP = readSrc("src/components/field-survey/trip-controls.tsx");
    const pinIdx = TRIP.indexOf("fetchOwnActiveGeneration(target.id)");
    const drainIdx = TRIP.indexOf("Promise.resolve(onBeforeSessionEnd())");
    expect(pinIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeLessThan(drainIdx);
  });

  it("stale 直接終了は touch せず client 既知の activitySeq をトークンにする", () => {
    // touch すると stale 判定が解除され endedAt=now の過大記録に戻る (B-7 R3)。
    // 復元 GET の activitySeq を echo すれば、touch 無しでゾンビ排除条件を満たせる。
    const TRIP = readSrc("src/components/field-survey/trip-controls.tsx");
    expect(TRIP).toMatch(
      /if \(opts\?\.staleDirect\) \{\s*if \(typeof target\.activitySeq === "number"\)/,
    );
    expect(TRIP).toMatch(/staleDirect: true/);
  });

  it("トークンはスキーマで整数検証 (旧タブ互換のため必須にはしない)・fence flag あり", () => {
    const VALIDATORS_SRC = readSrc("src/lib/validators.ts");
    const schema =
      VALIDATORS_SRC.match(
        /patchFieldSurveySessionSchema[\s\S]*?fieldSurveySessionListQuerySchema/,
      )?.[0] ?? "";
    expect(schema).toMatch(
      /expectedActivitySeq:\s*z\.number\(\)\.int\(\)\.min\(0\)\.optional\(\)/,
    );
    // @codex R7: フェンス指定 flag (記録開始 touch のみ世代を進める)
    expect(schema).toMatch(/fence:\s*z\.literal\(true\)\.optional\(\)/);
    // @codex R8: token を schema 必須にしない (deploy を跨いだ旧タブが reload
    // まで終了不能になるため)。本 client は常に同封する (trip-controls 参照)。
    expect(schema).not.toMatch(
      /v\.status === undefined \|\| v\.expectedActivitySeq !== undefined/,
    );
  });
});

describe("recorder — 位置記録開始のフェンス touch", () => {
  it("start は既存ルート取得の前にフェンス touch を打つ", () => {
    const startBlock =
      RECORDER_SRC.match(
        /const start = useCallback\([\s\S]*?\]\s*,?\s*\);/,
      )?.[0] ?? "";
    expect(startBlock).toMatch(/touchFence|startFence/);
    // フェンス → 既存ルート取得の順 (fence の index が先)
    const fenceIdx = startBlock.search(/touchFence|startFence/);
    const fetchIdx = startBlock.indexOf("fetchExistingTrackPoints");
    expect(fenceIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(fenceIdx).toBeLessThan(fetchIdx);
    // blocked 時は watch を開始せず、親へ終了検知を通知して idle に戻す
    expect(startBlock).toMatch(/classifyStartFence/);
    expect(startBlock).toMatch(/onSessionEnded/);
  });

  it("フェンスは touch PATCH (touch: true, fence: true) で timeout 付き・成立確認 (2xx) のみ開始", () => {
    expect(RECORDER_SRC).toMatch(/START_FENCE_TIMEOUT_MS/);
    // fence: true = 世代 (activitySeq) を +1 する記録開始フェンス (@codex R7)
    expect(RECORDER_SRC).toMatch(/touch:\s*true,\s*fence:\s*true/);
    // @codex R9: 200 でも応答 body の session status を確認する (フェンス直後に
    // 互換経路の終了が commit されたケースを検知)。active 以外は 409 相当・
    // 解析不能は null (blocked-retry = fail-closed)。
    expect(RECORDER_SRC).toMatch(/sessStatus === "active"/);
    expect(RECORDER_SRC).toMatch(
      /if \(typeof sessStatus === "string"\) return 409/,
    );
    // 成立不明 (blocked-retry) でも開始せず、再試行を案内する
    expect(RECORDER_SRC).toMatch(/blocked-retry/);
    expect(RECORDER_SRC).toMatch(
      /位置情報の記録を開始できませんでした。通信状態を確認して、もう一度お試しください。/,
    );
  });

  it("フェンス await 明けにも session/世代ガードを通す (陳腐化 continuation 対策)", () => {
    const startBlock =
      RECORDER_SRC.match(
        /const start = useCallback\([\s\S]*?\]\s*,?\s*\);/,
      )?.[0] ?? "";
    // fence await の後、watch 開始までの間に generation 照合が 2 回以上ある
    // (fence 後 + fetchExistingTrackPoints 後)
    const guards = startBlock.match(
      /recorderGenerationRef\.current !== startGeneration/g,
    );
    expect((guards ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("trip-controls — 終了フローの ending 固着防止 (@codex R6 P2)", () => {
  it("既 ended 検知後の reconcile が unknown なら active へ戻して再試行可能にする", () => {
    // fetchOwnActiveGeneration が ended を返した後の全体 reconcile が timeout
    // (unknown・state 未変更) だと phase="ending" のまま固まる → active へ戻す。
    expect(TRIP_SRC).toMatch(
      /known\.kind === "ended"[\s\S]{0,900}?rec\.kind === "unknown"[\s\S]{0,300}?setPhase\("active"\)/,
    );
  });
});

describe("trip-controls — 終了検知時の巡回状態リフレッシュ登録", () => {
  it("registerSessionRefresh prop で fetchActiveSession を親に登録する", () => {
    expect(TRIP_SRC).toMatch(/registerSessionRefresh\?\s*:/);
    // 登録 effect (registerStartRequest と同型・cleanup で null 解除)
    expect(TRIP_SRC).toMatch(
      /registerSessionRefresh\?\.\(requestRefresh\)/,
    );
    expect(TRIP_SRC).toMatch(/registerSessionRefresh\?\.\(null\)/,
    );
  });
});

describe("field-survey-map — recorder とセッション UI の配線", () => {
  it("recorder の onSessionEnded は登録された巡回リフレッシュを呼ぶ", () => {
    expect(MAP_SRC).toMatch(/sessionRefreshRef/);
    expect(MAP_SRC).toMatch(/onSessionEnded/);
    expect(MAP_SRC).toMatch(/registerSessionRefresh=\{/);
  });
});
