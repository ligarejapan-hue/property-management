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

describe("route — 終了 commit の活動フェンス (トークン等値 + 到着時刻フォールバック)", () => {
  it("終了/キャンセルの updateMany はフェンストークン等値、無ければ到着時刻上限を条件に含む", () => {
    // 終了/キャンセル分岐の updateMany を掴む
    const block =
      ROUTE_SRC.match(
        /if \(patch\.status === "ended" \|\| patch\.status === "cancelled"\) \{[\s\S]*?INVALID_STATE/,
      )?.[0] ?? "";
    expect(block).not.toBe("");
    // @codex R3: server 側で観測する時刻 (読取値・到着時刻) はどこで捕捉しても
    // 「遅延後」になり得る。client が送信時にピン留めした値 (touch 応答の
    // updatedAt echo) の等値を第一条件にし、トークン無しのみ到着時刻に落とす。
    expect(block).toMatch(
      /const fenceToken = patch\.expectedUpdatedAt\s*\?\s*new Date\(patch\.expectedUpdatedAt\)\s*:\s*null/,
    );
    expect(block).toMatch(
      /updatedAt:\s*fenceToken\s*\?\?\s*\{\s*lte:\s*requestArrivedAt\s*\}/,
    );
    expect(block).not.toMatch(/updatedAt:\s*existing\.updatedAt/);
    expect(block).not.toMatch(/isStaleEnd && \{ updatedAt/);
  });

  it("到着時刻は認証・パースより前 (ハンドラ先頭) で捕捉する", () => {
    const patchBlock =
      ROUTE_SRC.match(/export async function PATCH[\s\S]*?getApiSession/)?.[0] ??
      "";
    // requestArrivedAt の捕捉が getApiSession (認証) より前にある
    expect(patchBlock).toMatch(/const requestArrivedAt = new Date\(\);/);
  });

  it("stale 直接終了は touch せず client 既知の updatedAt をトークンにする", () => {
    // touch すると stale 判定が解除され endedAt=now の過大記録に戻る (B-7 R3)。
    // 復元 GET の updatedAt を echo すれば、touch 無しでゾンビ排除条件を満たせる。
    const TRIP = readSrc("src/components/field-survey/trip-controls.tsx");
    expect(TRIP).toMatch(
      /opts\?\.staleDirect && target\.updatedAt !== undefined/,
    );
    expect(TRIP).toMatch(/staleDirect: true/);
  });

  it("トークンはスキーマで ISO datetime に検証される (validators)", () => {
    const VALIDATORS_SRC = readSrc("src/lib/validators.ts");
    const schema =
      VALIDATORS_SRC.match(
        /patchFieldSurveySessionSchema[\s\S]*?\.refine/,
      )?.[0] ?? "";
    expect(schema).toMatch(
      /expectedUpdatedAt:\s*z\.string\(\)\.datetime\(\)\.optional\(\)/,
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

  it("フェンスは touch PATCH (touch: true) で timeout 付き・成立確認 (2xx) のみ開始", () => {
    expect(RECORDER_SRC).toMatch(/START_FENCE_TIMEOUT_MS/);
    expect(RECORDER_SRC).toMatch(/touch:\s*true/);
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
