/**
 * 名前に「査定書」が入った「その他」の添付を、種類「査定書・査定報告書」にまとめて直す(2026-11-11)。
 */
import { describe, it, expect, vi } from "vitest";
import { backfillAppraisalKind, isAppraisalFileName, type KindBackfillDeps } from "../appraisal-kind-backfill";

const deps = (over: Partial<KindBackfillDeps> = {}): KindBackfillDeps => ({
  listUnclassified: vi.fn(async () => [
    { id: "a1", targetId: "p1", fileName: "査定書_池尻.pdf" },
    { id: "a2", targetId: "p1", fileName: "不動産価格 査定 報告書.pdf" },
    { id: "a3", targetId: "p2", fileName: "ｻﾃｲ.pdf" },
    { id: "a4", targetId: "p2", fileName: "売買契約書.pdf" },
    { id: "a5", targetId: "p3", fileName: "査定書（ＳＲＥ）.xlsx" },
  ]),
  setKind: vi.fn(async () => true),
  audit: vi.fn(async () => {}),
  ...over,
});

describe("isAppraisalFileName(判別と同じ比べ方)", () => {
  it("査定書・査定報告(空白・全角を無視)だけ", () => {
    expect(isAppraisalFileName("査定書.pdf")).toBe(true);
    expect(isAppraisalFileName("価格 査定 報告書.pdf")).toBe(true);
    expect(isAppraisalFileName("査定書（ＳＲＥ）.xlsx")).toBe(true);
    expect(isAppraisalFileName("簡易査定.pdf")).toBe(false);
    expect(isAppraisalFileName("売買契約書.pdf")).toBe(false);
  });
});

describe("backfillAppraisalKind", () => {
  it("dry-run は数えるだけ(書かない・記録しない)", async () => {
    const d = deps();
    expect(await backfillAppraisalKind(d, { apply: false })).toEqual({ targets: 3, changed: 0, skipped: 0, failed: [] });
    expect(d.setKind).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
  it("apply は名前の合うものだけ直し、直したものだけ記録する", async () => {
    const d = deps({ setKind: vi.fn(async (a) => a.id !== "a2") });
    expect(await backfillAppraisalKind(d, { apply: true })).toEqual({ targets: 3, changed: 2, skipped: 1, failed: [] });
    expect(vi.mocked(d.setKind).mock.calls.map(([a]) => a.id)).toEqual(["a1", "a2", "a5"]);
    expect(vi.mocked(d.audit).mock.calls.map(([a]) => a.id)).toEqual(["a1", "a5"]);
  });
  it("1件失敗しても残りは続ける(失敗は id だけ返す)", async () => {
    const d = deps({ setKind: vi.fn(async (a) => { if (a.id === "a1") throw new Error("db"); return true; }) });
    const r = await backfillAppraisalKind(d, { apply: true });
    expect(r).toEqual({ targets: 3, changed: 2, skipped: 0, failed: ["a1"] });
  });
});
