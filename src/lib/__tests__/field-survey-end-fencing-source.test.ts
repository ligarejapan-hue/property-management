/**
 * 巡回終了の確実化 (#317) — 終了 commit の活動フェンス化のソース検証。
 *
 * 設計 (issue #317 の目的「再読込・別タブ越えの記録喪失防止」を、DB 行ロックの
 * 直列化で構造的に閉じる。migration / ブラウザ保存なし):
 *  1. 終了/キャンセルの commit は常に「読取時点から updatedAt が変わっていない」
 *     ことを条件にする (従来は放置終了のみ)。位置記録 flush / touch は updatedAt
 *     を進めるため、client abort 後にサーバー側で遅延した終了 commit が、再開
 *     された記録の後から着地して以降の点を 409 で失わせることができなくなる。
 *  2. 「位置記録開始」は watch 開始前に活動 touch をフェンスとして打つ。
 *     touch が先に届けば遅延終了は条件不成立で失敗し session は active のまま。
 *     終了が先に commit していれば touch が 409 を返し開始を止める。
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
  it("409 (終了済み) / 404 (session 消失) は開始をブロックする", () => {
    expect(classifyStartFence(409)).toBe("blocked");
    expect(classifyStartFence(404)).toBe("blocked");
  });

  it("200 は開始を許可する", () => {
    expect(classifyStartFence(200)).toBe("proceed");
  });

  it("network/timeout (null) やその他エラーは fail-open (オフライン記録を妨げない)", () => {
    // 以降の既存ルート取得 GET が失敗すれば従来どおり開始しないため、
    // フェンス単独では安全側に倒しすぎない。
    expect(classifyStartFence(null)).toBe("proceed");
    expect(classifyStartFence(500)).toBe("proceed");
    expect(classifyStartFence(401)).toBe("proceed");
    expect(classifyStartFence(403)).toBe("proceed");
  });
});

describe("route — 終了 commit の活動フェンス (常時 updatedAt 条件)", () => {
  it("終了/キャンセルの updateMany は isStaleEnd に関係なく updatedAt を条件に含む", () => {
    // 終了/キャンセル分岐の updateMany を掴む
    const block =
      ROUTE_SRC.match(
        /if \(patch\.status === "ended" \|\| patch\.status === "cancelled"\) \{[\s\S]*?INVALID_STATE/,
      )?.[0] ?? "";
    expect(block).not.toBe("");
    // 無条件の updatedAt 条件 (isStaleEnd ゲートの conditional spread ではない)
    expect(block).toMatch(/updatedAt:\s*existing\.updatedAt/);
    expect(block).not.toMatch(/isStaleEnd && \{ updatedAt/);
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

  it("フェンスは touch PATCH (touch: true) で timeout 付き・失敗は fail-open", () => {
    expect(RECORDER_SRC).toMatch(/START_FENCE_TIMEOUT_MS/);
    expect(RECORDER_SRC).toMatch(/touch:\s*true/);
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
