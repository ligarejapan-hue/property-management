import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const create = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { importJob: { create: (...a: unknown[]) => create(...a), updateMany: (...a: unknown[]) => updateMany(...a) } } }));

import { failUnfinishedImportJob, startImportJob } from "../import-job-start";

beforeEach(() => {
  create.mockReset();
  updateMany.mockReset();
});

describe("取り込みを受け取った直後の記録(@codex P1: 通信が切れた画面が履歴ですぐ確かめられる)", () => {
  it("処理中で作る(件数は後で書く)", async () => {
    create.mockResolvedValue({ id: "job-1" });
    await expect(startImportJob({ jobType: "owner_csv", fileName: "a + b", executedBy: "u1" })).resolves.toEqual({ id: "job-1" });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ jobType: "owner_csv", fileName: "a + b", status: "processing", executedBy: "u1" });
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("totalRows");
  });
  it("失敗にするのは処理中のままの記録だけ(済んだ記録は書き換えない)", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await failUnfinishedImportJob("job-1");
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "job-1", status: "processing" });
    expect(arg.data.status).toBe("failed");
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });
  it("後始末が失敗しても投げない(元のエラーの返事を変えない)", async () => {
    updateMany.mockRejectedValue(new Error("db down"));
    await expect(failUnfinishedImportJob("job-1")).resolves.toBeUndefined();
  });
});

describe("3つの取り込みの窓口の配線", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  it.each([
    ["src/app/api/import/csv/route.ts", "rows.length"],
    ["src/app/api/import/reception-owner/route.ts", "receptionRows.length"],
    ["src/app/api/import/reception-property/route.ts", "activeRows.length"],
  ])("%s: 表を読む前に記録を作り、失敗したら処理中の記録を失敗にする", (path, total) => {
    const src = read(path);
    const start = src.indexOf("await startImportJob(");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(src.indexOf("parseSheet("));
    expect(src).toMatch(/await startImportJob\([\s\S]{0,200}\);\s*startedJobId = job\.id;/);
    expect(src).not.toContain("prisma.importJob.create(");
    expect(src).toMatch(/\} catch \(error\) \{\s*if \(startedJobId\) await failUnfinishedImportJob\(startedJobId\);\s*return handleApiError\(error\);/);
    expect(src).toContain(`totalRows: ${total},`);
  });
});
