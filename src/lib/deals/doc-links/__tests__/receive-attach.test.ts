import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/server", async () => (await import("../../__tests__/route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("../../__tests__/route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({ default: {} }));
import {
  ATTACH_KIND_BY_ITEM, attachKindFor, attachNotice, attachReceivedDocFiles, backfillReceivedDocAttachments,
  receivedAttachmentFileName, receivedAttachmentKey, type AttachOutcome,
} from "../receive-attach";
import { DOC_LINK_CATALOG } from "../catalog";
import { docKindByCode } from "@/lib/doc-classify/classify";
import { isOwnerPiiDocument } from "@/lib/uploads-authorization";

const DEAL = "d1";
const PROP = "p1";
const REQ = "r1";

type Att = { id: string; propertyId: string; fileUrl: string; isDeleted: boolean; docTitle: string | null; data?: Record<string, unknown> };

function makeWorld(opts: {
  propertyId?: string | null;
  archived?: boolean;
  checklistItemId?: string;
  label?: string;
  files?: { id: string; storageKey: string; mimeType: string; fileSize: number }[];
  status?: string;
} = {}) {
  const atts: Att[] = [];
  const files = opts.files ?? [{ id: "f1", storageKey: "deal-docs/x/f1.jpg", mimeType: "image/jpeg", fileSize: 100 }];
  const stored = new Map<string, Uint8Array>(files.map((f) => [f.storageKey, new Uint8Array([1, 2, 3])]));
  const storage = {
    read: vi.fn(async (k: string) => (stored.has(k) ? { body: stored.get(k)!, contentType: "x" } : null)),
    upload: vi.fn(async (_b: Buffer, o: { key: string }) => { stored.set(o.key, new Uint8Array([9])); return { url: `/uploads/${o.key}`, key: o.key }; }),
    delete: vi.fn(async (k: string) => { stored.delete(k); }),
    getUrl: vi.fn(),
    keyFromUrl: vi.fn(),
  };
  const contains = (where: { propertyId: string; fileUrl: { contains: string } }) =>
    atts.find((a) => a.propertyId === where.propertyId && a.fileUrl.includes(where.fileUrl.contains)) ?? null;
  const db = {
    dealDocRequest: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; status: string; link: { dealId: string } } }) => {
        if (where.id !== REQ || where.link.dealId !== DEAL || (opts.status ?? "received") !== where.status) return null;
        return {
          checklistItemId: opts.checklistItemId ?? "s_bring_id",
          label: opts.label ?? "写真付き身分証明書",
          link: { deal: { propertyId: opts.propertyId === undefined ? PROP : opts.propertyId } },
          files,
        };
      }),
      findMany: vi.fn(async () => [{ id: REQ, reviewedById: null, link: { dealId: DEAL, createdById: "u-issuer" } }]),
    },
    property: { findUnique: vi.fn(async () => ({ id: PROP, isArchived: !!opts.archived, buildingName: "見本マンション", roomNo: "101", address: "東京都見本区1-1" })) },
    attachment: {
      findFirst: vi.fn(async ({ where }: { where: { propertyId: string; fileUrl: { contains: string } } }) => {
        const a = contains(where);
        return a ? { id: a.id } : null;
      }),
      findMany: vi.fn(async () => atts.filter((a) => !a.isDeleted && a.docTitle).map((a) => ({ docTitle: a.docTitle }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const a: Att = { id: `a${atts.length + 1}`, propertyId: data.propertyId as string, fileUrl: data.fileUrl as string, isDeleted: false, docTitle: (data.docTitle as string | null) ?? null, data };
        atts.push(a);
        return { id: a.id };
      }),
    },
    $queryRaw: vi.fn(async () => [{ id: PROP }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, storage, atts, stored };
}

const run = (w: ReturnType<typeof makeWorld>, extra: Partial<Parameters<typeof attachReceivedDocFiles>[0]> = {}) =>
  attachReceivedDocFiles({ db: w.db as never, storage: w.storage as never, dealId: DEAL, requestId: REQ, userId: "u-office", ...extra });

describe("受領した書類を添付へ(2026-11-21 発注者)", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => { w = makeWorld(); });

  it("写しを物件の置き場所に作り、取引の書類として添付を1件作る(元のファイルは残す)", async () => {
    const o = await run(w);
    expect(o).toMatchObject({ attached: 1, existing: 0, failed: 0, skipped: null });
    expect(w.storage.upload).toHaveBeenCalledTimes(1);
    expect(w.storage.upload.mock.calls[0][1].key).toBe("properties/p1/attachments/deal-doc-f1.jpg");
    expect(w.storage.delete).not.toHaveBeenCalled();
    expect(w.stored.has("deal-docs/x/f1.jpg")).toBe(true);
    expect(w.atts[0].data).toMatchObject({
      targetType: "property", targetId: PROP, propertyId: PROP, type: "general", dealId: DEAL,
      fileName: "写真付き身分証明書.jpg", fileUrl: "/uploads/properties/p1/attachments/deal-doc-f1.jpg",
      fileSize: 100, mimeType: "image/jpeg", uploadedBy: "u-office", docKind: "identity_document", docStage: "identity",
    });
    // 物件の行を先にロック
    expect(w.db.$queryRaw).toHaveBeenCalled();
  });

  it("2回呼んでも1件だけ(受領と前の分のスクリプトが重なっても)", async () => {
    await run(w);
    const o = await run(w);
    expect(o).toMatchObject({ attached: 0, existing: 1 });
    expect(w.atts).toHaveLength(1);
    expect(w.storage.upload).toHaveBeenCalledTimes(1);
  });

  it("人が消した添付は入れ直さない", async () => {
    await run(w);
    w.atts[0].isDeleted = true;
    expect(await run(w)).toMatchObject({ attached: 0, existing: 1 });
  });

  it("写したあとロックの中で先を越されていたら作らず、置き場所のファイルも消さない", async () => {
    w.db.attachment.findFirst
      .mockResolvedValueOnce(null) // ロックの前
      .mockResolvedValueOnce({ id: "other" }); // ロックの中=もう入っている
    const o = await run(w);
    expect(o).toMatchObject({ attached: 0, existing: 1, failed: 0 });
    expect(w.db.attachment.create).not.toHaveBeenCalled();
    expect(w.storage.delete).not.toHaveBeenCalled();
  });

  it("添付を作れなかったら失敗と数え、写しは消さない(同時に動いた別の呼び出しの添付を壊さない)。やり直せば入る", async () => {
    w.db.attachment.create.mockRejectedValueOnce(new Error("db down"));
    const o = await run(w);
    expect(o).toMatchObject({ attached: 0, failed: 1 });
    expect(w.storage.delete).not.toHaveBeenCalled();
    expect(w.stored.has("deal-docs/x/f1.jpg")).toBe(true);
    expect(await run(w)).toMatchObject({ attached: 1 });
  });

  it("元のファイルが読めなければ数えて先へ(受領は戻さない)", async () => {
    w.storage.read.mockResolvedValueOnce(null);
    expect(await run(w)).toMatchObject({ attached: 0, failed: 1 });
  });

  it("複数枚は番号つきの名前で全部入れる", async () => {
    w = makeWorld({ files: [
      { id: "f1", storageKey: "k1", mimeType: "image/jpeg", fileSize: 1 },
      { id: "f2", storageKey: "k2", mimeType: "application/pdf", fileSize: 2 },
    ] });
    const o = await run(w);
    expect(o.attached).toBe(2);
    expect(w.atts.map((a) => a.data?.fileName)).toEqual(["写真付き身分証明書_1.jpg", "写真付き身分証明書_2.pdf"]);
  });

  it("取引が物件につながっていない・物件がしまってある → 入れない", async () => {
    expect((await run(makeWorld({ propertyId: null }))).skipped).toBe("no_property");
    const arch = makeWorld({ archived: true });
    expect((await run(arch)).skipped).toBe("archived");
    expect(arch.storage.upload).not.toHaveBeenCalled();
  });

  it("受領済みでない書類は何もしない", async () => {
    const x = makeWorld({ status: "submitted" });
    expect(await run(x)).toMatchObject({ attached: 0, skipped: null });
    expect(x.storage.upload).not.toHaveBeenCalled();
  });

  it("数えるだけ(dryRun)は写さない・書き込まない", async () => {
    const o = await run(w, { dryRun: true });
    expect(o.attached).toBe(1);
    expect(w.storage.upload).not.toHaveBeenCalled();
    expect(w.db.attachment.create).not.toHaveBeenCalled();
  });

  it("物件の書類は合う種類(課税明細書=評価証明・公課証明)", async () => {
    w = makeWorld({ checklistItemId: "doc_property_tax_notice", label: "固定資産税・都市計画税課税明細書" });
    await run(w);
    expect(w.atts[0].data).toMatchObject({ docKind: "tax_certificate" });
  });

  it("前の書類確認書の項目(一覧に無い id=登記識別情報など)は本人確認書類で守る", async () => {
    w = makeWorld({ checklistItemId: "s_bring_title", label: "登記識別情報（権利証）" });
    await run(w);
    expect(w.atts[0].data).toMatchObject({ docKind: "identity_document", fileName: "登記識別情報（権利証）.jpg" });
    expect(isOwnerPiiDocument({ type: "general", docKind: w.atts[0].data?.docKind as string })).toBe(true);
  });
});

describe("種類の対応", () => {
  it("身分証明書・印鑑証明書・住民票・納税証明書=本人確認書類(開ける人を絞る・発注者決定)", () => {
    for (const id of ["s_bring_id", "s_bring_seal", "s_bring_resident", "doc_tax_certificate"]) {
      const kind = attachKindFor(id);
      expect(kind).toBe("identity_document");
      expect(isOwnerPiiDocument({ type: "general", docKind: kind })).toBe(true);
    }
  });
  it("提出書類の一覧のどの書類にも、実在する種類が付く", () => {
    for (const item of DOC_LINK_CATALOG) {
      const kind = attachKindFor(item.id);
      expect(kind, item.id).not.toBeNull();
      expect(docKindByCode(kind!), item.id).toBeTruthy();
    }
    expect(Object.keys(ATTACH_KIND_BY_ITEM).sort()).toEqual(DOC_LINK_CATALOG.map((i) => i.id).sort());
  });
});

describe("名前と置き場所", () => {
  it("置き場所はファイルごとに決まる", () => {
    expect(receivedAttachmentKey("p", "f", "application/pdf")).toBe("properties/p/attachments/deal-doc-f.pdf");
    expect(receivedAttachmentKey("p", "f", "image/webp")).toBe("properties/p/attachments/deal-doc-f.webp");
  });
  it("名前に使えない文字を除く", () => {
    expect(receivedAttachmentFileName("a/b:c", "image/png", 0, 1)).toBe("abc.png");
    expect(receivedAttachmentFileName("  ", "image/png", 0, 1)).toBe("提出書類.png");
  });
});

describe("画面の一言", () => {
  const base: AttachOutcome = { attached: 0, existing: 0, failed: 0, skipped: null, attachmentIds: [] };
  it("入れた数・入れなかった理由・失敗", () => {
    expect(attachNotice({ ...base, attached: 2 }).notice).toBe("受領しました。物件の添付に2件入れました。");
    expect(attachNotice({ ...base, skipped: "no_property" }).notice).toContain("物件につながっていない");
    expect(attachNotice({ ...base, skipped: "archived" }).notice).toContain("しまってある");
    expect(attachNotice({ ...base, failed: 1 }).warning).toContain("1件のファイルを物件の添付に入れられませんでした");
  });
});

describe("前の分をまとめて入れる", () => {
  it("数えるだけ→入れる→もう一度流しても増えない。入れた人=受領した人が無ければ発行した人", async () => {
    const w = makeWorld();
    const dry = await backfillReceivedDocAttachments({ db: w.db as never, storage: w.storage as never, apply: false });
    expect(dry).toMatchObject({ requests: 1, attached: 1 });
    expect(w.atts).toHaveLength(0);
    const r1 = await backfillReceivedDocAttachments({ db: w.db as never, storage: w.storage as never, apply: true });
    expect(r1).toMatchObject({ attached: 1, existing: 0 });
    expect(w.atts[0].data?.uploadedBy).toBe("u-issuer");
    const r2 = await backfillReceivedDocAttachments({ db: w.db as never, storage: w.storage as never, apply: true });
    expect(r2).toMatchObject({ attached: 0, existing: 1 });
  });
});
