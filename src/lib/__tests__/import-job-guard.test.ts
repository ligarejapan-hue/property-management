/**
 * 取込ジョブのスコープ（担当分だけ / 全員分）。
 *
 * 2026-08-02 監査: 取込ジョブの一覧・詳細・行データ（所有者の氏名/住所/電話を含む
 * rawData）・エラーCSV・ロールバックが `import:write` だけで通っており、他人が実行した
 * 取込を誰でも横断閲覧できた。ここでその是正をロックする。
 */
import { describe, it, expect, vi } from "vitest";

// api-helpers は next-auth を引き込むため、ApiError の忠実な replica で差し替える
// (他の route テストと同じ流儀)。
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import {
  canSeeAllImportJobs,
  importJobScopeWhere,
  assertImportJobVisible,
} from "@/lib/import-job-guard";

const WRITE_ONLY = [{ resource: "import", action: "write", granted: true }];
const WITH_READ_ALL = [
  ...WRITE_ONLY,
  { resource: "import", action: "read_all", granted: true },
];
// granted:false は「持っていない」と同じ（明示的な否認）。
const READ_ALL_DENIED = [
  ...WRITE_ONLY,
  { resource: "import", action: "read_all", granted: false },
];
const ME = "user-1";

describe("canSeeAllImportJobs", () => {
  it("import:read_all を持つときだけ true（既定は管理者テンプレのみ）", () => {
    expect(canSeeAllImportJobs(WITH_READ_ALL)).toBe(true);
    expect(canSeeAllImportJobs(WRITE_ONLY)).toBe(false);
    expect(canSeeAllImportJobs(READ_ALL_DENIED)).toBe(false);
    expect(canSeeAllImportJobs([])).toBe(false);
  });

  it("他リソースの read_all では true にならない（現地調査の権限で取込が見えない）", () => {
    expect(
      canSeeAllImportJobs([
        { resource: "field_survey", action: "read_all", granted: true },
      ]),
    ).toBe(false);
  });
});

describe("importJobScopeWhere（一覧の絞り込み）", () => {
  it("read_all なし → 自分の実行分に限定", () => {
    expect(importJobScopeWhere(ME, WRITE_ONLY)).toEqual({ executedBy: ME });
  });

  it("read_all あり → 制限なし（空の断片）", () => {
    expect(importJobScopeWhere(ME, WITH_READ_ALL)).toEqual({});
  });

  it("他人の executedBy を指定されても、後からマージすれば自分の分へ上書きされる", () => {
    // route 側の使い方: 任意フィルタを入れた後に Object.assign する。
    const where: { executedBy?: string } = { executedBy: "someone-else" };
    Object.assign(where, importJobScopeWhere(ME, WRITE_ONLY));
    expect(where.executedBy).toBe(ME);
  });
});

describe("assertImportJobVisible（単一ジョブ）", () => {
  it("自分が実行したジョブは通る", () => {
    expect(() =>
      assertImportJobVisible({ executedBy: ME }, ME, WRITE_ONLY),
    ).not.toThrow();
  });

  it("他人のジョブは 403（read_all なし）", () => {
    expect(() =>
      assertImportJobVisible({ executedBy: "other" }, ME, WRITE_ONLY),
    ).toThrowError(/他の担当者/);
    try {
      assertImportJobVisible({ executedBy: "other" }, ME, WRITE_ONLY);
    } catch (e) {
      expect((e as { status: number; code: string }).status).toBe(403);
      expect((e as { code: string }).code).toBe("FORBIDDEN");
    }
  });

  it("read_all があれば他人のジョブも通る", () => {
    expect(() =>
      assertImportJobVisible({ executedBy: "other" }, ME, WITH_READ_ALL),
    ).not.toThrow();
  });

  it("executedBy が null のジョブは fail-closed（read_all が無ければ 403）", () => {
    expect(() =>
      assertImportJobVisible({ executedBy: null }, ME, WRITE_ONLY),
    ).toThrow();
    expect(() =>
      assertImportJobVisible({ executedBy: null }, ME, WITH_READ_ALL),
    ).not.toThrow();
  });
});
