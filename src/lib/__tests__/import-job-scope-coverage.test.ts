/**
 * 取込ジョブ配下の API が**もれなく**スコープ制限を通していることの網羅テスト。
 *
 * 2026-08-02 監査の是正を、将来 route が増えたときにも守れる形で固定する
 * （物件側の property-record-scope-align.test.ts と同じ姿勢）。
 * 新しい route を足したのにガードを忘れると、このテストが落ちる。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const JOBS_DIR = join(process.cwd(), "src", "app", "api", "import", "jobs");

/** jobs 配下の route.ts を再帰列挙（__tests__ は除く）。 */
function collectRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...collectRoutes(p));
    } else if (name === "route.ts") {
      out.push(p);
    }
  }
  return out;
}

const routes = collectRoutes(JOBS_DIR).map((p) => ({
  path: p,
  rel: p.slice(p.indexOf("api")).replace(/\\/g, "/"),
  src: readFileSync(p, "utf-8"),
}));

describe("取込ジョブ配下の route はすべてスコープ制限を通す", () => {
  it("route を検出できている（列挙の壊れ検知）", () => {
    expect(routes.length).toBeGreaterThanOrEqual(13);
  });

  it.each(routes.map((r) => [r.rel, r] as const))(
    "%s がガードを呼ぶ",
    (_rel, r) => {
      // 一覧系は where 断片、単一ジョブ系は assert。どちらかが必須。
      const usesScope =
        r.src.includes("importJobScopeWhere") ||
        r.src.includes("assertImportJobVisible") ||
        r.src.includes("assertImportJobMutable");
      expect(usesScope).toBe(true);
    },
  );

  it.each(
    routes
      .filter(
        (r) =>
          r.src.includes("assertImportJobVisible") ||
          r.src.includes("assertImportJobMutable"),
      )
      .map((r) => [r.rel, r] as const),
  )("%s は executedBy を取得している（判定材料の欠落防止）", (_rel, r) => {
    // include: { job: true } / include: { executor... } のように全列を取る形か、
    // select に executedBy を明記しているか。
    const hasExecutedBy =
      r.src.includes("executedBy: true") ||
      r.src.includes("include: { job: true }") ||
      r.src.includes("include: { rows:") ||
      r.src.includes("include: { executor:");
    expect(hasExecutedBy).toBe(true);
  });

  // 変更系(POST/PATCH)は read_all では通らない Mutable を使うこと(Codex #349 R8 P1:
  // 画面上「全員分の閲覧」と表示される権限でロールバック等を許さない)。
  it.each([
    "mark-failed",
    "resume-registry-pdf",
    "rollback",
    "bulk-resolve",
    "retry",
    "manual-attach-registry-pdf",
    "manual-link-reception-owner",
  ])("変更系 %s は Mutable ガードを使う", (name) => {
    const r = routes.find((x) => x.rel.includes(name + "/route.ts"));
    expect(r).toBeDefined();
    expect(r!.src).toContain("assertImportJobMutable");
    expect(r!.src).not.toContain("assertImportJobVisible");
  });

  it("行のPATCH(rows/[rowId]) も変更系", () => {
    const r = routes.find((x) => x.rel.endsWith("rows/[rowId]/route.ts"));
    expect(r).toBeDefined();
    expect(r!.src).toContain("assertImportJobMutable");
  });

  it.each(["jobs/[jobId]/route.ts", "affected-properties", "export-errors"])(
    "読み取り系 %s は Visible ガード",
    (name) => {
      const r = routes.find((x) => x.rel.includes(name));
      expect(r).toBeDefined();
      expect(r!.src).toContain("assertImportJobVisible");
    },
  );

  it("一覧系はスコープを任意フィルタの後にマージしている（他人IDの指定で漏れない）", () => {
    const list = routes.find((r) => r.rel.endsWith("api/import/jobs/route.ts"));
    expect(list).toBeDefined();
    const src = list!.src;
    // executedBy クエリの代入より後に Object.assign(where, importJobScopeWhere(...))。
    // ⚠import 文にも同名が出るため、**呼び出し箇所**(Object.assign)の位置で比較する。
    const assignIdx = src.indexOf("Object.assign(where, importJobScopeWhere");
    expect(assignIdx).toBeGreaterThan(0);
    expect(src.indexOf("where.executedBy = executedByParam")).toBeLessThan(
      assignIdx,
    );
  });
});

describe("権限カタログ（管理画面）に import:read_all が出ている", () => {
  it.each([
    "src/app/(dashboard)/admin/templates/[id]/page.tsx",
    "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
  ])("%s の RESOURCES に read_all がある（付与できないと 403 のまま）", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    expect(src).toMatch(
      /key:\s*"import",[\s\S]{0,80}actions:\s*\[[^\]]*"read_all"/,
    );
  });
});
