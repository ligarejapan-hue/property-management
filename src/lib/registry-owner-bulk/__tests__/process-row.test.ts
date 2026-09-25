/**
 * まとめて反映の「1行(=1物件)」の処理。
 *
 * ⚠1件ずつのボタンと**同じ共通処理**を呼ぶ(守りを二重に書かない)。
 *   ここの役目は、共通処理の結果・エラーを取込記録の行の状態に翻訳することだけ。
 * ⚠1件の失敗で残り全部を止めない(飛ばして次へ)。ただし何が起きたかは行に残す。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock("@/lib/registry-owner-apply/apply", () => ({
  applyRegistryOwnersToProperty: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { applyRegistryOwnersToProperty } from "@/lib/registry-owner-apply/apply";
import { buildRegistryOwnerApplyRawData } from "@/lib/registry-owner-bulk/marker";
import { processRegistryOwnerApplyRow } from "@/lib/registry-owner-bulk/process-row";

const PROP_ID = "11111111-1111-4111-8111-111111111111";
const db = prisma as unknown as {
  importJobRow: { findUnique: Mock; update: Mock };
};
const apply = applyRegistryOwnersToProperty as unknown as Mock;

const EXECUTOR = { id: "user-1", role: "admin" };
const PERMS = [{ resource: "owner", action: "write", granted: true }];

const run = () =>
  processRegistryOwnerApplyRow({
    jobId: "job-1",
    rowId: "row-1",
    executor: EXECUTOR,
    perms: PERMS,
  });

/** 更新に渡された内容。 */
const updated = () => db.importJobRow.update.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  db.importJobRow.findUnique.mockResolvedValue({
    id: "row-1",
    jobId: "job-1",
    status: "pending",
    rawData: buildRegistryOwnerApplyRawData({
      propertyId: PROP_ID,
      address: "東京都渋谷区神宮前三丁目12-3",
    }),
    job: { jobType: "registry_pdf_bulk" },
  });
  db.importJobRow.update.mockResolvedValue({});
  apply.mockResolvedValue({
    attachmentId: "att-1",
    parsedOwners: 2,
    result: { ownersMatched: 0, ownersCreated: 2, ownersLinked: 2 },
  });
});

describe("成功したとき", () => {
  it("行を成功にして、登録した人数を残す", async () => {
    await expect(run()).resolves.toBe("success");
    expect(updated().status).toBe("success");
    expect(updated().errorMessage).toBeNull();
    const raw = updated().rawData as Record<string, string>;
    expect(raw.ownersLinked).toBe("2");
    // ⚠物件IDと物件の住所は残すが、所有者の氏名・住所は残さない
    expect(raw.propertyId).toBe(PROP_ID);
    expect(Object.keys(raw)).not.toContain("owners");
  });

  it("⚠1件ずつのボタンと同じ共通処理を、その物件について呼ぶ", async () => {
    await run();
    expect(apply).toHaveBeenCalledTimes(1);
    const args = apply.mock.calls[0][0];
    expect(args.propertyId).toBe(PROP_ID);
    expect(args.session).toEqual(EXECUTOR);
    expect(args.perms).toEqual(PERMS);
    // ⚠まとめて反映は人が中身を見ないので、添付は実行時点の最新を使う
    //   (共通処理が書き込みのロックの中でも最新かを確かめる)
    expect(args.expectedAttachmentId).toBeUndefined();
  });
});

describe("処理しない行", () => {
  it("未処理でない行は何もしない", async () => {
    db.importJobRow.findUnique.mockResolvedValue({
      id: "row-1",
      jobId: "job-1",
      status: "success",
      rawData: buildRegistryOwnerApplyRawData({ propertyId: PROP_ID, address: null }),
      job: { jobType: "registry_pdf_bulk" },
    });
    await expect(run()).resolves.toBe("noop");
    expect(apply).not.toHaveBeenCalled();
    expect(db.importJobRow.update).not.toHaveBeenCalled();
  });

  it("⚠別のジョブの行は何もしない", async () => {
    db.importJobRow.findUnique.mockResolvedValue({
      id: "row-1",
      jobId: "other-job",
      status: "pending",
      rawData: buildRegistryOwnerApplyRawData({ propertyId: PROP_ID, address: null }),
      job: { jobType: "registry_pdf_bulk" },
    });
    await expect(run()).resolves.toBe("noop");
    expect(apply).not.toHaveBeenCalled();
  });

  it("⚠PDFを上げた一括取込の行は何もしない（印で見分ける）", async () => {
    db.importJobRow.findUnique.mockResolvedValue({
      id: "row-1",
      jobId: "job-1",
      status: "pending",
      rawData: { fileName: "x.PDF", stagedKey: "staging/x.pdf" },
      job: { jobType: "registry_pdf_bulk" },
    });
    await expect(run()).resolves.toBe("noop");
    expect(apply).not.toHaveBeenCalled();
    expect(db.importJobRow.update).not.toHaveBeenCalled();
  });
});

describe("うまくいかなかったとき", () => {
  it("すでに所有者がいた物件は「飛ばした」にする（失敗にしない）", async () => {
    apply.mockRejectedValue(
      new ApiError(409, "この物件にはすでに所有者が登録されています", "OWNERS_ALREADY_EXIST"),
    );
    await expect(run()).resolves.toBe("skipped");
    expect(updated().status).toBe("skipped");
    expect(updated().errorMessage).toContain("すでに所有者");
  });

  it("読み取れなかった物件は「要確認」にする（後から手入力で拾える）", async () => {
    apply.mockRejectedValue(
      new ApiError(422, "謄本から所有者を読み取れませんでした。手入力で登録してください", "REGISTRY_OWNERS_NOT_FOUND"),
    );
    await expect(run()).resolves.toBe("needs_review");
    expect(updated().status).toBe("needs_review");
  });

  it("謄本が見つからない物件も「要確認」にする", async () => {
    apply.mockRejectedValue(
      new ApiError(404, "この物件には所有者事項の謄本が添付されていません", "REGISTRY_NOT_FOUND"),
    );
    await expect(run()).resolves.toBe("needs_review");
  });

  it("⚠処理中に別の謄本が添付された物件は「要確認」にする（勝手に入れ直さない）", async () => {
    apply.mockRejectedValue(
      new ApiError(409, "確認した謄本とは別の謄本が追加されています。開き直してもう一度確認してください", "REGISTRY_ATTACHMENT_CHANGED"),
    );
    await expect(run()).resolves.toBe("needs_review");
  });

  it("権限・担当範囲で弾かれた物件は失敗にする", async () => {
    apply.mockRejectedValue(new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN"));
    await expect(run()).resolves.toBe("error");
    expect(updated().status).toBe("error");
  });

  it("⚠思いがけない失敗は、生のエラー文を行に残さない（住所などを含みうる）", async () => {
    const leaky = Object.assign(
      new Error("Invalid invocation: rawData: { address: '東京都渋谷区神宮前三丁目12-3' }"),
      { code: "P2009", name: "PrismaClientValidationError" },
    );
    apply.mockRejectedValue(leaky);
    await expect(run()).resolves.toBe("error");
    const message = String(updated().errorMessage);
    expect(message).not.toContain("神宮前");
    expect(message).not.toContain("rawData");
    // 追いかけられる情報(種類・コード)は残す
    expect(message).toContain("PrismaClientValidationError");
    expect(message).toContain("P2009");
  });
});
