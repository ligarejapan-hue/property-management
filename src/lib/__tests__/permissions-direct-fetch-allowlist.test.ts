/**
 * 19-A: `/api/me/permissions` 直接 fetch call site の許可リスト固定（source assertion / test-only）。
 *
 * 目的（F12 他ページ展開の前準備・本実装ではない）:
 *   F12-2(PR#145) で properties 一覧は ScreenProtectionProvider 経由の
 *   permissions 配布へ移行し、ページ独自 fetch を撤去した
 *   （permissions-provider-distribution.test.ts が移行済みの「形」をロック）。
 *   19-A の F12 展開で field-survey map も provider 経由へ移行した
 *   （field-survey-pin-ui-source.test.ts が新形をロック）。一方で
 *   properties 詳細 / admin owner 詳細 は依然 `fetch("/api/me/permissions")`
 *   を直接持つ（= 次に provider へ寄せる候補）。
 *
 *   本テストは distribution test を補完し、src ツリー全体を走査して
 *   **直接 fetch の call site 全体集合を許可リストとして固定**する。distribution
 *   test が個別ファイルの「形」を見るのに対し、本テストは「新しいページが
 *   無断で許可リスト外の直接 fetch を増やしていないか」「移行が進んで
 *   許可リストから減ったか」を repo 横断で検出する回帰防止網。
 *
 * 固定する事実（field-survey-map を provider へ移行後）:
 *   - canonical provider（1 箇所）……… ここだけが本来あるべき唯一の取得点
 *   - 移行待ち（2 箇所）……………… F12 展開の残候補（移行で許可リストから外す）
 *
 * このテストが落ちたら:
 *   - 想定外ファイルが増えた → 新規ページが直接 fetch を足した（provider 経由へ）
 *   - 既知ファイルが消えた   → F12 移行が進んだ（許可リスト/台帳を更新する合図）
 *
 * production code・権限仕様・route 契約・UI 挙動は一切変更しない（test-only）。
 * route 契約は me-permissions-route.test.ts、provider 配布の形は
 * permissions-provider-distribution.test.ts が別途ロック済み。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(process.cwd(), "src");

/** 直接 fetch の検出パターン（URL 文字列の閉じ引用符まで・options 有無を問わない）。
 *  distribution test (line 60) と同一パターンで取りこぼしを揃える。 */
const DIRECT_FETCH_RE = /fetch\(\s*["']\/api\/me\/permissions["']/g;

/** src 配下の .ts/.tsx を再帰収集（__tests__ は除外）。relative posix path を返す。 */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      collectSourceFiles(abs, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(path.relative(process.cwd(), abs).split(path.sep).join("/"));
    }
  }
  return acc;
}

/** ファイル内の直接 fetch call site 数。 */
function countDirectFetch(relPath: string): number {
  const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
  return (src.match(DIRECT_FETCH_RE) ?? []).length;
}

// ── 許可リスト（field-survey-map を provider へ移行後の唯一の真実）─────────────
// canonical = provider（唯一あるべき取得点）。
// migration-pending = F12 で provider へ寄せる残候補（移行したらここから外す）。
// field-survey-map.tsx は 19-A で provider 経由へ移行済み（許可リストから除外）。
const CANONICAL = "src/components/screen-protection/screen-protection-provider.tsx";
const MIGRATION_PENDING = [
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/app/(dashboard)/admin/owners/[id]/page.tsx",
] as const;

const ALLOWLIST = [CANONICAL, ...MIGRATION_PENDING];

describe("19-A: /api/me/permissions 直接 fetch 許可リスト（source assertion）", () => {
  const allFiles = collectSourceFiles(SRC_ROOT);
  const filesWithDirectFetch = allFiles.filter((f) => countDirectFetch(f) > 0);

  it("直接 fetch を持つファイルは許可リストと完全一致（想定外の新規 call site なし）", () => {
    const unexpected = filesWithDirectFetch.filter((f) => !ALLOWLIST.includes(f));
    const missing = ALLOWLIST.filter((f) => !filesWithDirectFetch.includes(f));
    // unexpected != [] → 新規ページが直接 fetch を足した（provider 経由へ寄せる）
    expect(unexpected).toEqual([]);
    // missing != [] → 既知 call site が消えた（F12 移行進展。許可リスト/台帳を更新）
    expect(missing).toEqual([]);
    // 集合一致（順不同）
    expect([...filesWithDirectFetch].sort()).toEqual([...ALLOWLIST].sort());
  });

  it("直接 fetch の総 call site 数は 3（各許可ファイル 1 箇所ずつ）", () => {
    const total = ALLOWLIST.reduce((n, f) => n + countDirectFetch(f), 0);
    expect(total).toBe(3);
    for (const f of ALLOWLIST) {
      expect(countDirectFetch(f)).toBe(1);
    }
  });

  it("canonical な取得点は provider 1 箇所のみ（distribution test と整合）", () => {
    expect(countDirectFetch(CANONICAL)).toBe(1);
  });

  it("移行待ち 2 ページは現状なお直接 fetch を保持（次の F12 展開候補）", () => {
    // distribution test (line 304-313) はパス文字列の存在のみを見るため
    // コメント言及でもマッチする。ここでは実 fetch literal の存在を強く固定する。
    for (const f of MIGRATION_PENDING) {
      expect(countDirectFetch(f)).toBe(1);
    }
  });

  it("properties 一覧は直接 fetch を持たない（F12-2 で provider 経由へ移行済み・回帰防止）", () => {
    expect(countDirectFetch("src/app/(dashboard)/properties/page.tsx")).toBe(0);
  });

  it("server route handler は client fetch ではない（許可リストに含めない）", () => {
    // route.ts は GET ハンドラ定義であり fetch しない（許可リストに現れない）。
    expect(countDirectFetch("src/app/api/me/permissions/route.ts")).toBe(0);
    expect(ALLOWLIST).not.toContain("src/app/api/me/permissions/route.ts");
  });

  it("走査健全性: src 配下の .ts/.tsx を実際に収集できている（空走査での偽 green を防ぐ）", () => {
    // 走査が 0 件なら上の集合一致は空 vs 空で誤 green になりうるため、
    // 走査が実体を拾っていること・許可リストが全て実在ファイルであることを担保。
    expect(allFiles.length).toBeGreaterThan(100);
    for (const f of ALLOWLIST) {
      expect(fs.existsSync(path.resolve(process.cwd(), f))).toBe(true);
    }
  });
});
