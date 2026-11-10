import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, storage, extract, audit } = vi.hoisted(() => ({
  db: {
    attachment: { findFirst: vi.fn() },
    appraisalDeck: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
  storage: { keyFromUrl: vi.fn((u: string) => u.replace("/uploads/", "")), read: vi.fn() },
  extract: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ default: db }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: extract,
  isPdfBuffer: (b: Buffer) => b.subarray(0, 5).toString() === "%PDF-",
}));
vi.mock("@/lib/pdf-compress/run", () => ({ runExclusive: (fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: audit }));

import { buildAppraisalDraft } from "../create-draft";

const SRE = [
  "山田 太郎 様",
  "不動産価格査定報告書",
  "物件詳細",
  "所有地 \t東京都架空区見本町4丁目26-8",
  "土地面積 \t45.59m2 (約13.79坪) \t土地権利 \t所有権",
  "延床面積 \t64.32m2 (約19.46坪)",
  "査定結果 \t査定日:2026年8月24日",
  "スタンダードプラン",
  "1,280 万円",
  "成約想定価格 \t1,304 万円 土地 1,214 万円 ( 88万円/坪 )",
  "建物 90 万円 ( 4.6万円/坪 )",
  "AI査定価格 \t4,137 万円 土地 4,047 万円 ( 293.5万円/坪 )",
  "建物 90 万円 ( 4.6万円/坪 )",
].join("\n");

const IN = { attachmentId: "a1", propertyId: "p1", userId: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.attachment.findFirst.mockResolvedValue({ id: "a1", fileUrl: "/uploads/report-inbox/x.pdf" });
  db.appraisalDeck.findUnique.mockResolvedValue(null);
  db.appraisalDeck.create.mockResolvedValue({ id: "d1" });
  db.appraisalDeck.updateMany.mockResolvedValue({ count: 1 });
  storage.read.mockResolvedValue({ body: Buffer.from("%PDF-1.7 ...") });
  extract.mockResolvedValue(SRE);
});

describe("buildAppraisalDraft(査定報告書から下書きを作る)", () => {
  it("査定報告書(report か、直接付けた種類「査定書・査定報告書」・削除されていない・この物件)だけを探す", async () => {
    await buildAppraisalDraft(IN);
    expect(db.attachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "a1",
          targetType: "property",
          targetId: "p1",
          isDeleted: false,
          OR: [{ type: "report" }, { type: "general", docKind: "appraisal_report" }],
        },
      }),
    );
  });

  it("読み取った数字で下書きを作り、AuditLog には件数と id だけを残す", async () => {
    const r = await buildAppraisalDraft(IN);
    expect(r).toEqual({ ok: true, deckId: "d1", created: true });
    const data = db.appraisalDeck.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ propertyId: "p1", sourceAttachmentId: "a1", status: "draft", createdBy: "u1" });
    expect(data.extracted.expected.total).toBe(1304);
    // 依頼者の氏名・番地・PDF本文は保存しない
    const saved = JSON.stringify(data);
    expect(saved).not.toContain("山田");
    expect(saved).not.toContain("26-8");
    expect(saved).not.toContain("不動産価格査定報告書");
    const detail = audit.mock.calls[0][0].detail;
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "create", targetTable: "appraisal_decks", targetId: "d1" });
    expect(JSON.stringify(detail)).not.toMatch(/1304|1,304|見本町|x\.pdf/);
  });

  it("既に下書きがあり作り直しでなければ、読まずにそれを返す", async () => {
    db.appraisalDeck.findUnique.mockResolvedValue({ id: "d0", status: "draft", propertyId: "p1" });
    const r = await buildAppraisalDraft(IN);
    expect(r).toEqual({ ok: true, deckId: "d0", created: false });
    expect(extract).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("作り直しは下書きのときだけ(確認済みは上書きしない)", async () => {
    db.appraisalDeck.findUnique.mockResolvedValue({ id: "d0", status: "confirmed", propertyId: "p1" });
    expect(await buildAppraisalDraft({ ...IN, replace: true })).toEqual({ ok: false, reason: "already_confirmed" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("読んでいる間に確認済みになったら上書きしない(状態を条件に更新)", async () => {
    db.appraisalDeck.findUnique.mockResolvedValue({ id: "d0", status: "draft", propertyId: "p1" });
    db.appraisalDeck.updateMany.mockResolvedValue({ count: 0 });
    expect(await buildAppraisalDraft({ ...IN, replace: true })).toEqual({ ok: false, reason: "already_confirmed" });
    expect(db.appraisalDeck.updateMany.mock.calls[0][0].where).toEqual({ id: "d0", status: "draft" });
  });

  it("別の物件の下書き・見つからない添付・PDF でないファイルは作らない", async () => {
    db.appraisalDeck.findUnique.mockResolvedValueOnce({ id: "d0", status: "draft", propertyId: "p2" });
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "attachment_not_found" });
    db.attachment.findFirst.mockResolvedValueOnce(null);
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "attachment_not_found" });
    storage.read.mockResolvedValueOnce(null);
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "file_not_found" });
    storage.read.mockResolvedValueOnce({ body: Buffer.from("not a pdf") });
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "not_pdf" });
    expect(db.appraisalDeck.create).not.toHaveBeenCalled();
  });

  it("読み取りの失敗・時間切れ・SRE でない書式は作らない", async () => {
    extract.mockRejectedValueOnce(Object.assign(new Error("t"), { code: "PDF_READ_TIMEOUT" }));
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "read_failed" });
    extract.mockResolvedValueOnce("見積書\n合計 100万円");
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "not_sre" });
    expect(db.appraisalDeck.create).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledWith(expect.any(Buffer), { timeoutMs: 60_000 });
  });

  it("順番待ちの間はファイルを読まず、待ちが上限を超えたら busy(@codex #692)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    extract.mockImplementation(async () => {
      await gate;
      return SRE;
    });
    const running = Array.from({ length: 4 }, () => buildAppraisalDraft(IN));
    await new Promise((r) => setTimeout(r, 0));
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: false, reason: "busy" });
    // runExclusive は作り物(すぐ実行)なので読んだのは走っている4本だけ。5本目は読まない
    expect(storage.read).toHaveBeenCalledTimes(4);
    release();
    await Promise.all(running);
    // 終われば数が戻る
    extract.mockResolvedValue(SRE);
    expect((await buildAppraisalDraft(IN)).ok).toBe(true);
  });

  it("同じ報告書から同時に作ったら、先にできた方を返す", async () => {
    db.appraisalDeck.create.mockRejectedValueOnce(new Error("unique"));
    db.appraisalDeck.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "d9" });
    expect(await buildAppraisalDraft(IN)).toEqual({ ok: true, deckId: "d9", created: false });
  });
});
