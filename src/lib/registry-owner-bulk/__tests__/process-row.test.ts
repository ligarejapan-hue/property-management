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
    importJobRow: { findUnique: vi.fn(), updateMany: vi.fn() },
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
  importJobRow: { findUnique: Mock; updateMany: Mock };
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
const updated = () => db.importJobRow.updateMany.mock.calls[0][0].data as Record<string, unknown>;

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
  db.importJobRow.updateMany.mockResolvedValue({ count: 1 });
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

  /**
   * ⚠なぜ必要か(@codex 第4R P2): 所有者の書き込みが確定したあと、行を「成功」にする前に
   *   止まると、再開時に「すでに所有者あり=飛ばした」と誤って記録され件数がずれる。
   *   行の「成功」は所有者と同じトランザクションの中で書く。
   */
  type Hook = (t: unknown, s: { linked: number }) => Promise<void>;

  it("⚠行の「成功」は、共通処理の確定前の入口(同じトランザクション)で書く", async () => {
    const tx = { importJobRow: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    apply.mockImplementation(async (args: { beforeCommit?: Hook }) => {
      await args.beforeCommit?.(tx, { linked: 3 });
      return { attachmentId: "att-1", parsedOwners: 3, result: { ownersLinked: 3 } };
    });
    await expect(run()).resolves.toBe("success");
    expect(tx.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    const call = tx.importJobRow.updateMany.mock.calls[0][0];
    // ⚠未処理の行だけを書き換える(二重に走っても上書きしない)
    expect(call.where).toEqual({ id: "row-1", jobId: "job-1", status: "pending" });
    expect(call.data.status).toBe("success");
    expect(call.data.errorMessage).toBeNull();
    const raw = call.data.rawData as Record<string, string>;
    expect(raw.ownersLinked).toBe("3");
    expect(raw.propertyId).toBe(PROP_ID);
    // 確定済みなので、外側では書き直さない
    expect(db.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("⚠行がもう未処理でなければ、入口で投げて所有者の書き込みも巻き戻す", async () => {
    const tx = { importJobRow: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    let thrown: unknown;
    apply.mockImplementation(async (args: { beforeCommit?: Hook }) => {
      try {
        await args.beforeCommit?.(tx, { linked: 1 });
      } catch (e) {
        thrown = e;
        throw e;
      }
      return { attachmentId: "att-1", parsedOwners: 1, result: { ownersLinked: 1 } };
    });
    await expect(run()).resolves.toBe("noop");
    expect(thrown).toBeTruthy();
    expect(db.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("⚠確定のあとに共通処理が失敗しても、「成功」を失敗で上書きしない", async () => {
    // 確定済み = 読み直すと行は「成功」になっている
    db.importJobRow.findUnique
      .mockResolvedValueOnce({
        id: "row-1",
        jobId: "job-1",
        status: "pending",
        rawData: buildRegistryOwnerApplyRawData({ propertyId: PROP_ID, address: null }),
      })
      .mockResolvedValueOnce({ id: "row-1", jobId: "job-1", status: "success" });
    const tx = { importJobRow: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    apply.mockImplementation(async (args: { beforeCommit?: Hook }) => {
      await args.beforeCommit?.(tx, { linked: 1 });
      // 例: 所有者は確定したが、取込ジョブの後始末の書き込みで失敗した
      throw new Error("job finalize failed");
    });
    await expect(run()).resolves.toBe("success");
    expect(db.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  /**
   * ⚠なぜ必要か(@codex 第5R P2): 入口が呼ばれても、確定(COMMIT)そのものが失敗すれば
   *   所有者も行も巻き戻る。入口が呼ばれたことだけで「成功」とみなすと、行は未処理の
   *   まま残り、失敗の記録も再試行もされない。確定したかは行を読み直して確かめる。
   */
  it("⚠入口のあと確定そのものが失敗したら、「成功」とみなさず失敗として残す", async () => {
    const tx = { importJobRow: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    apply.mockImplementation(async (args: { beforeCommit?: Hook }) => {
      await args.beforeCommit?.(tx, { linked: 1 });
      // 例: COMMIT が失敗 → 所有者も行の更新も巻き戻った(読み直すと未処理のまま)
      throw new Error("commit failed");
    });
    await expect(run()).resolves.toBe("error");
    expect(updated().status).toBe("error");
  });

  it("⚠外側で行を書くときも、未処理の行だけを書き換える", async () => {
    apply.mockRejectedValue(new ApiError(403, "この物件を扱う権限がありません", "FORBIDDEN"));
    await run();
    expect(db.importJobRow.updateMany.mock.calls[0][0].where).toEqual({
      id: "row-1",
      jobId: "job-1",
      status: "pending",
    });
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
    // ⚠まとめて反映の1件分であることを伝える(取込の履歴に1件ずつの記録を並べない)
    expect(args.partOfBulk).toBe(true);
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
    expect(db.importJobRow.updateMany).not.toHaveBeenCalled();
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
    expect(db.importJobRow.updateMany).not.toHaveBeenCalled();
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

  /**
   * ⚠なぜ必要か(@codex 第8R P2): 次回の対象選びは「要確認になった物件を後ろに回す」。
   *   ところが取込の記録の画面の「スキップ」「エラー確定」で行の状態が変わると、要確認
   *   だった印が消えて、また先頭に並ぶ。状態とは別に、消えない印を行に残す。
   */
  it("⚠要確認にした行には、状態が変わっても残る印を付ける", async () => {
    apply.mockRejectedValue(
      new ApiError(422, "謄本から所有者を読み取れませんでした。手入力で登録してください", "REGISTRY_OWNERS_NOT_FOUND"),
    );
    await run();
    const raw = updated().rawData as Record<string, string>;
    expect(raw.reviewed).toBe("1");
    // 印以外は元のまま(物件ID・物件の住所)
    expect(raw.propertyId).toBe(PROP_ID);
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
