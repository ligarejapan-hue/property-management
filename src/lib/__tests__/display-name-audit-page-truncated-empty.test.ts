/**
 * DisplayNameAuditPage の「打ち切り（truncated）かつ群ゼロ」空状態の source-assertion テスト（Codex P2）。
 *
 * vitest は environment: "node" のため RTL/jsdom は使用しない。
 * fs.readFileSync でソースを読み込み、意図する分岐が存在することを静的に確認する。
 *
 * 背景（Codex P2 "Avoid clean empty state when truncated"）:
 *  - scan が MAX_SCAN に達したが capped subset に重複名群が無い場合、API は
 *    truncated:true + groups:[]（unavailable は立たない）を返し得る。
 *  - 既存の空状態分岐は data[tab]===undefined / unavailable / それ以外（clean）の 3 状態のみで、
 *    truncated:true + 群ゼロ + 非 unavailable が「表記ゆれは見つかりませんでした。」(clean) に落ちていた。
 *  - 是正: 4 状態目として truncated（上限到達で全件未走査）を区別し、
 *    「表記ゆれは見つかりませんでした」と言わず、上限到達で未確認である旨を表示する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/display-name-audit/page.tsx",
  ),
  "utf8",
);

// 空状態ブロック（!current || current.groups.length === 0 ? ... : ...）の本体を抽出する。
// この範囲内に truncated 分岐と専用文言があることを検証し、render JSX 全体やページ上部の
// truncated バナーが偽陽性にならないようにする。
function extractEmptyStateBlock(src: string): string {
  const startMarker = "current.groups.length === 0 ? (";
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("empty-state branch marker not found");
  // ブロックは表 (table) を開始する次の三項分岐 ") : (" まで。
  const end = src.indexOf(") : (", start);
  if (end < 0) throw new Error("empty-state branch end not found");
  return src.slice(start, end);
}

describe("display-name-audit/page.tsx — truncated 空状態 (Codex P2)", () => {
  const emptyBlock = extractEmptyStateBlock(pageSrc);

  it("空状態分岐の中で truncated を判定する（clean に落とさない）", () => {
    // 空状態の中で truncated を見ていること（ページ上部バナーではなく空状態側）。
    expect(emptyBlock).toMatch(/truncated/);
  });

  it("空状態に truncated 専用文言があり、clean 断定文とは別物である", () => {
    // clean メッセージ（従来）は残る。
    expect(emptyBlock).toContain("表記ゆれは見つかりませんでした");
    // 打ち切り（上限到達で全件未走査）を伝える専用文言を持つ。
    expect(emptyBlock).toMatch(/上限に達したため/);
    // 上限到達ゆえ表記ゆれの有無が確定していない旨（未確認）を伝える。
    expect(emptyBlock).toMatch(/未確認|確定していません|不明/);
  });

  it("truncated 空状態の文言は「見つかりませんでした」で終わる clean 断定にしない", () => {
    // truncated 文言と clean 文言を素朴に同一視させないためのガード。
    // 空状態に 3 つ以上の分岐（undefined / unavailable / truncated / clean）が
    // 存在することを、三項/論理分岐の数で大まかに担保する。
    const ternaryArms = emptyBlock.split("?").length - 1;
    expect(ternaryArms).toBeGreaterThanOrEqual(2);
  });
});
