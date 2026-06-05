/**
 * F10-subset: import job detail の mutation 後、affected を変えない skip / mark_error 系で
 * 冗長な fetchAffected を省略する配線の source-assertion テスト
 * （repo に jsdom / RTL が無いためソース文字列で検証する）。
 *
 * 前提不変条件: affected-properties は「status='success' かつ createdId 有り」の行のみ由来。
 * skip / mark_error はこの条件を満たさないため affected は不変＝fetchAffected が冗長。
 * この不変条件もテストで固定し、route 側が変わったら検知できるようにする。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const PAGE = "src/app/(dashboard)/import/jobs/[jobId]/page.tsx";
const AFFECTED_ROUTE =
  "src/app/api/import/jobs/[jobId]/affected-properties/route.ts";

describe("F10-subset: affected-properties の前提不変条件", () => {
  const route = read(AFFECTED_ROUTE);

  it("affected は status='success' かつ createdId 有りの行のみ由来（skip/mark_error は対象外）", () => {
    expect(route).toMatch(/status:\s*"success"/);
    expect(route).toMatch(/createdId:\s*\{\s*not:\s*null\s*\}/);
  });
});

describe("F10-subset: import job detail の冗長 fetchAffected 省略", () => {
  const src = read(PAGE);

  it("handleResolve: create_new / link_existing のみ fetchAffected、skip / mark_error は fetchJob のみ", () => {
    expect(src).toMatch(
      /const mutatesAffected =\s*action === "create_new" \|\| action === "link_existing";/,
    );
    expect(src).toMatch(
      /await \(mutatesAffected\s*\?\s*Promise\.all\(\[fetchJob\(\), fetchAffected\(\)\]\)\s*:\s*fetchJob\(\)\);/,
    );
  });

  it("handleBatchResolve(skip/mark_error 一括): fetchAffected を省略し fetchJob のみ", () => {
    expect(src).toMatch(
      /bulkResolveImportRows\(jobId, \{ action, scope \}\);[\s\S]{0,220}?await fetchJob\(\);/,
    );
    // 旧パターン（bulk 直後に Promise.all で fetchAffected）が残っていない。
    expect(src).not.toMatch(
      /bulkResolveImportRows\(jobId, \{ action, scope \}\);\s*await Promise\.all\(\[fetchJob\(\), fetchAffected\(\)\]\)/,
    );
  });

  it("handleBulkResolveDuplicates(重複一括 skip): fetchAffected を省略し fetchJob のみ", () => {
    expect(src).toMatch(
      /scope: "duplicate",\s*\}\);[\s\S]{0,220}?await fetchJob\(\);/,
    );
    expect(src).not.toMatch(
      /scope: "duplicate",\s*\}\);\s*await Promise\.all\(\[fetchJob\(\), fetchAffected\(\)\]\)/,
    );
  });

  it("handleRetry は affected を変え得るため Promise.all([fetchJob, fetchAffected]) を維持", () => {
    expect(src).toMatch(
      /retryImportRow\([\s\S]{0,160}?\);\s*await Promise\.all\(\[fetchJob\(\), fetchAffected\(\)\]\)/,
    );
  });

  it("executeRollback は affected を変えるため fetchAffected を維持", () => {
    expect(src).toMatch(/await fetchJob\(\);\s*await fetchAffected\(\);/);
  });
});
