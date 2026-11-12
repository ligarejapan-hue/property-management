/**
 * 同じ謄本PDFを取り直したときに、**住所の無い所有者が増えない**こと。
 *
 * 背景（@codex #394 R6 P2）: 謄本PDFの保存は処理の最後にあり、保存に失敗しても取込自体は
 * 成功扱い（警告のみ）。つまり「PDFだけ入らなかったのでやり直す」が現実に起きる。
 * 住所の無い所有者は「名前だけでの自動統合はしない」規則のため、やり直すたびに
 * 新しい所有者として作られ、物件に同じ人が並ぶ。
 * ⚠**グローバルな名前だけの統合は従来どおり禁止**（同姓同名の別人を混ぜない）。
 *   再利用するのは**その物件に既に紐づいている**所有者だけ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    propertyOwnerRegistryEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p1" }]);
  return { default: db };
});
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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChangeLog: vi.fn() }));
vi.mock("@/lib/pdf-registry-parser", () => ({ parseRegistryText: vi.fn() }));
// 法人番号の検出は差し替える（既定は候補なし）。ロック順序のテストだけ候補を1件返し、
// 「既存所有者の法人番号を埋める」更新を実際に走らせる＝空振りのピンにしない。
vi.mock("@/lib/corporate-number", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    detectCorporateNumberInOwnerLike: vi.fn(() => ({ candidates: [] })),
  };
});
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: () => ({ upload, delete: del }),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
  };
});

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import { getStorage } from "@/lib/storage";
import { processRegistryPdf } from "@/lib/registry-pdf/process";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from([1, 2, 3, 4, 5]);

const pm = prisma as unknown as {
  $queryRaw: Mock;
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock; findUnique: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
  propertyOwnerRegistryEntry: { deleteMany: Mock; createMany: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

const session = { id: SESSION_ID, role: "admin", email: "u@test", name: "U" };

/** その物件に既に紐づいている所有者（取り直し前の状態）を仕込む。 */
const linkedOwners = (
  owners: Array<{
    id: string;
    name: string;
    address?: string | null;
    isArchived?: boolean;
  }>,
) => {
  pm.propertyOwner.findMany.mockResolvedValue(
    owners.map((o) => ({
      owner: {
        id: o.id,
        name: o.name,
        address: o.address ?? null,
        isArchived: o.isArchived ?? false,
        corporateNumber: null,
      },
    })),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: SESSION_ID,
    assignedTo: null,
    address: "東京都千代田区一番町1",
    realEstateNumber: null,
  });
  pm.property.update.mockResolvedValue({ id: PROP_ID });
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({});
  pm.importJobRow.create.mockResolvedValue({});
  pm.owner.findMany.mockResolvedValue([]);
  pm.owner.create.mockResolvedValue({ id: "owner-new" });
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.owner.findUnique.mockResolvedValue({ corporateNumber: null });
  pm.propertyOwner.findMany.mockResolvedValue([]);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (getStorage().upload as Mock).mockResolvedValue({
    url: "/uploads/x.pdf",
    key: "x.pdf",
  });
  // ⚠所有者に**住所が無い**のが今回の主題（住所ありは従来どおり全体照合される）。
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都千代田区一番町1",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [{ name: "山田太郎", address: null, share: null }],
    warnings: [],
    confidence: 0.9,
  });
});

const run = () =>
  processRegistryPdf({
    session,
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本.pdf",
    edited: undefined,
    pdfBuffer: PDF,
    certificateType: "owner",
  });

describe("同じ謄本を取り直しても住所なしの所有者が増えない", () => {
  it("既に同名・住所なしの所有者が紐づいていれば、新しく作らない", async () => {
    linkedOwners([{ id: "owner-existing", name: "山田太郎" }]);
    // 既にリンク済み＝リンクも作らない。
    pm.propertyOwner.findFirst.mockResolvedValue({ propertyId: PROP_ID });
    await run();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("初回（紐づきなし）は従来どおり新規作成する", async () => {
    linkedOwners([]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("紐づいているのが別名なら新規作成する（別人を混ぜない）", async () => {
    linkedOwners([{ id: "owner-other", name: "鈴木一郎" }]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("アーカイブ済みの紐づきは再利用しない", async () => {
    linkedOwners([{ id: "owner-arch", name: "山田太郎", isArchived: true }]);
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("照会は『物件行をロックしたトランザクションの中』で行う（同時取込の直列化）", async () => {
    // @codex #396: ロックの**外**で照会すると、同じ物件への取込が同時に走ったとき
    //   両方が「既存なし」と判定し、それぞれ別の所有者を作ってしまう。
    //   PropertyOwner の一意制約は (propertyId, ownerId) なので、**別idの2本は
    //   制約でも止められない**＝このPRが消そうとしている重複がそのまま残る。
    // ⇒ 物件行をロック → 照会 → 作成/リンク までを1つのトランザクションに閉じる。
    const order: string[] = [];
    let inTx = false;
    pm.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => {
      inTx = true;
      try {
        return await cb(prisma);
      } finally {
        inTx = false;
      }
    });
    pm.$queryRaw.mockImplementation(async () => {
      order.push(`lock:${inTx}`);
      return [{ id: PROP_ID }];
    });
    pm.propertyOwner.findMany.mockImplementation(async () => {
      order.push(`lookup:${inTx}`);
      return [];
    });
    pm.owner.create.mockImplementation(async () => {
      order.push(`create:${inTx}`);
      return { id: "owner-new" };
    });
    await run();
    // ロックが先・照会と作成はトランザクションの中。
    // ⚠末尾の lock:true は #402 で増えた**添付作成の親行ロック**(所有者処理の後に
    //   添付を作る tx が走る)。所有者側の約束(ロック→照会→作成が同一tx)は不変。
    // ⚠その次の lock:true は、謄本を付けたあとに登記状況を取得済に上げる tx の親行ロック(2026-11-06)。
    // ⚠create の次の lock:true・lookup:true は、登記上の記載(所有者事項の行)を記録する tx
    //   (物件行を押さえてから、つながりを読んで行を入れ替える・2026-11-12)。
    expect(order).toEqual([
      "lock:true",
      "lookup:true",
      "create:true",
      "lock:true",
      "lookup:true",
      "lock:true",
      "lock:true",
    ]);
  });

  it("物件行を握ったまま既存の所有者行を掴まない（ロック順序の食い違い＝デッドロック回避）", async () => {
    // @codex #396 R2: 住所ありの経路は「所有者 → 物件」の順でロックする。こちらが
    //   物件を握ったまま既存の所有者を掴むと**逆順**になり、同時実行で互いに待ち合って
    //   PostgreSQL がどちらかを中断する（正常な取込が失敗する）。
    // ⇒ 既存の所有者行に触る更新（法人番号の穴埋め）は、物件行をロックしている
    //   トランザクションの**外**で行う。
    // ⚠D10(編集中の鍵)で、この更新自体は「所有者の行をロックした**別の**トランザクション」
    //   に包まれるようになった(鍵の確認を書き込みと同じtxで行うため)。よって
    //   「トランザクションの中かどうか」では判定できなくなった＝**ネストしていないか**
    //   (物件ロックのtxがまだ開いたままの状態で所有者のtxが重なっていないか)を見る。
    // ⚠レビュー指摘(round1・Important): depth だけでは「ネストしていない」ことしか
    //   証明できず、「どのtxか」は証明しない。fillOwnerCorporateNumberIfUnlocked の
    //   呼び出しを誤って reuse-lookup tx(:219、lockPropertyRow を呼ぶ側)の中へ
    //   移してしまう回帰(=物件→所有者の逆順そのもの)でも depth は 1 のままになり、
    //   このテストは緑のまま通ってしまう。**同一性で証明する**: 所有者の updateMany が
    //   実行された tx を特定し、(a) その tx で lockOwnerRow(所有者の行ロック)が
    //   呼ばれていること、(b) その tx で lockPropertyRow(物件の行ロック)が
    //   一度も呼ばれていないこと、の両方を見る。
    //   ⚠lockPropertyRow/lockOwnerRow は本ファイルではモックせず実物を使う
    //   (他のテスト(照会順序テスト等)が実物の $queryRaw 呼び出しに依存しているため)。
    //   実物はどちらも `tx.$queryRaw` で SQL を発行するので、テーブル名
    //   (`FROM properties` / `FROM owners`)で呼び出し元を判別する。
    linkedOwners([{ id: "owner-existing", name: "山田太郎" }]);
    pm.propertyOwner.findFirst.mockResolvedValue({ propertyId: PROP_ID });
    // ⚠法人番号の候補を1件返させて、既存所有者への更新を**実際に走らせる**。
    //   （走らない条件で「呼ばれない」を確かめても、何も守れない空振りのピンになる）
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["4011001059442"],
    });

    type FakeTx = {
      $queryRaw: Mock;
      propertyOwner: { findMany: Mock };
      propertyOwnerRegistryEntry: { deleteMany: Mock; createMany: Mock };
      owner: { findUnique: Mock; updateMany: Mock };
    };
    const propertyLockTxs: FakeTx[] = [];
    const ownerLockTxs: FakeTx[] = [];
    // ⚠**全ての呼び出しを集める**(1回だけを見る変数にすると、後から正しい
    //   tx でもう一度呼ばれて上書きされたときに最初の違反を見逃す)。
    const ownerUpdateManyTxs: FakeTx[] = [];

    // $transaction が呼ばれるたびに、識別用の**別オブジェクト**を tx として渡す
    // (edit-lock-skip.test.ts の同一性テストと同じ考え方)。
    pm.$transaction.mockImplementation((cb: (tx: FakeTx) => unknown) => {
      const tx: FakeTx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join("");
          if (sql.includes("FROM properties")) propertyLockTxs.push(tx);
          if (sql.includes("FROM owners")) ownerLockTxs.push(tx);
          return [{ id: "locked-row" }];
        }),
        propertyOwner: { findMany: pm.propertyOwner.findMany },
        propertyOwnerRegistryEntry: pm.propertyOwnerRegistryEntry,
        owner: {
          // ⚠レビュー round1 #3: ロック後に corporateNumber を読み直す。まだ
          // 空(null)を返し、実際の updateMany を空振りさせない。
          findUnique: vi.fn(async () => ({ corporateNumber: null })),
          updateMany: vi.fn(async () => {
            ownerUpdateManyTxs.push(tx);
            return { count: 1 };
          }),
        },
      };
      return cb(tx);
    });

    await run();

    // 実際に呼ばれていること（空振りのピンにしない）。
    expect(ownerUpdateManyTxs.length).toBeGreaterThan(0);
    // (a) 所有者の updateMany が走った tx は**全て**、所有者の行ロックが
    //     呼ばれた tx と同一。
    for (const tx of ownerUpdateManyTxs) {
      expect(ownerLockTxs).toContain(tx);
    }
    // (b) その tx では物件の行ロックが一度も呼ばれていない
    //     (=物件ロックを握ったトランザクションのままここへ来ていない＝禁止された順序ではない)。
    //     ⚠1回でも違反した呼び出しがあれば検出する(最後だけを見ない)。
    for (const tx of ownerUpdateManyTxs) {
      expect(propertyLockTxs).not.toContain(tx);
    }
  });

  const withAddress = (owners: Array<{ name: string; address: string }>) =>
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都千代田区一番町1",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: owners.map((o) => ({ ...o, share: null })),
      warnings: [],
      confidence: 0.9,
    });

  it("登記上の記載: 同じ人が住所違い・持分ごとに3行載っていたら、1人にして3行とも記録する(2026-11-12)", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都千代田区一番町1",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: "住所A", share: "10分の2" },
        { name: "山田太郎", address: "住所B", share: "10分の3" },
        { name: "山田太郎", address: "住所C", share: "10分の2" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    // 1人目を作ったあとは、その人が物件に紐づいている(行の記録の照会にも同じ形で答える)
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "po-1",
          ownerId: "owner-new",
          owner: { id: "owner-new", name: "山田太郎", address: "住所A", isArchived: false, corporateNumber: null },
        },
      ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: "住所A", zip: null, isArchived: false });
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwnerRegistryEntry.deleteMany).toHaveBeenCalledWith({
      where: { propertyOwnerId: { in: ["po-1"] } },
    });
    expect(pm.propertyOwnerRegistryEntry.createMany).toHaveBeenCalledWith({
      data: [
        { propertyOwnerId: "po-1", position: 1, address: "住所A", shareNum: 2, shareDen: 10, sourceAttachmentId: null },
        { propertyOwnerId: "po-1", position: 2, address: "住所B", shareNum: 3, shareDen: 10, sourceAttachmentId: null },
        { propertyOwnerId: "po-1", position: 3, address: "住所C", shareNum: 2, shareDen: 10, sourceAttachmentId: null },
      ],
    });
  });

  it("登記上の記載: 全部事項の取り込みでは記録しない(対象は所有者事項)", async () => {
    withAddress([{ name: "山田太郎", address: "住所A" }]);
    pm.propertyOwner.findMany.mockResolvedValue([
      { id: "po-1", ownerId: "owner-new", owner: { id: "owner-x", name: "鈴木一郎", address: "x", isArchived: false, corporateNumber: null } },
    ]);
    await processRegistryPdf({
      session,
      text: "dummy",
      propertyId: PROP_ID,
      fileName: "謄本.pdf",
      edited: undefined,
      pdfBuffer: PDF,
      certificateType: "all",
    });
    expect(pm.propertyOwnerRegistryEntry.createMany).not.toHaveBeenCalled();
  });

  it("⚠登記上の記載: 手で取り込んだ全部事項(種別なし)でも記録しない=先に入っている行ごとの内訳を消さない(@codex #714 P2)", async () => {
    pm.propertyOwner.findMany.mockResolvedValue([
      { id: "po-1", ownerId: "owner-new", owner: { id: "owner-x", name: "鈴木一郎", address: "x", isArchived: false, corporateNumber: null } },
    ]);
    await processRegistryPdf({
      session,
      // 全部事項の本文(権利部・甲区がある)。種別の指定は無い=手で取り込んだもの
      text: "表題部 権利部（甲区）（所有権に関する事項）",
      propertyId: PROP_ID,
      fileName: "謄本.pdf",
      // 確認画面で人が直した所有者は全部事項でも反映される
      edited: { owners: [{ name: "山田太郎", address: "住所A", share: "10分の7" }] } as never,
      pdfBuffer: PDF,
    });
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwnerRegistryEntry.deleteMany).not.toHaveBeenCalled();
    expect(pm.propertyOwnerRegistryEntry.createMany).not.toHaveBeenCalled();
  });

  it("⚠登記上の記載: 書類の所有者の一部だけを渡す呼び出し(partialOwners)では記録しない(@codex #714 P2)", async () => {
    // 自動の登録・謄本の名義に直すは、足す人だけ(同じ名前の行を1つにまとめた後)を渡す。
    // そのまま記録すると 2/10+3/10+2/10 の人が 2/10 と出る。
    pm.propertyOwner.findMany.mockResolvedValue([
      { id: "po-1", ownerId: "owner-new", owner: { id: "owner-x", name: "鈴木一郎", address: "x", isArchived: false, corporateNumber: null } },
    ]);
    await processRegistryPdf({
      session,
      text: "dummy",
      propertyId: PROP_ID,
      fileName: "謄本.pdf",
      edited: { owners: [{ name: "山田太郎", address: "住所A", share: "10分の2" }] } as never,
      pdfBuffer: null,
      certificateType: "owner",
      partialOwners: true,
    });
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwnerRegistryEntry.deleteMany).not.toHaveBeenCalled();
    expect(pm.propertyOwnerRegistryEntry.createMany).not.toHaveBeenCalled();
  });

  it("⚠足す人だけを渡す2つの呼び出し元は partialOwners を付けている(ソース)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const rel of [
      "src/lib/registry-owner-check/service.ts", // 謄本にだけいる人を自動で登録
      "src/lib/registry-owner-apply/apply.ts", // 謄本の名義に直す
    ]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      // edited.owners に「一部の人」を渡している呼び出しの直後に partialOwners: true がある
      expect(src, rel).toMatch(/edited: \{ owners: (targets|plan\.add)\.map\([\s\S]{0,160}?partialOwners: true,/);
    }
  });

  it("登記上の記載: 行の記録に失敗しても、取り込みは失敗にしない(所有者は確定済み・氏名や住所をログに出さない)", async () => {
    withAddress([{ name: "山田太郎", address: "住所A" }]);
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: "po-1", ownerId: "owner-new", owner: { id: "owner-new", name: "山田太郎", address: "住所A", isArchived: false, corporateNumber: null } },
      ]);
    pm.propertyOwnerRegistryEntry.createMany.mockRejectedValueOnce(new Error("山田太郎 住所A で失敗"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeDefined();
      expect(pm.owner.create).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("Failed to record registry entries");
      expect(logged).not.toContain("山田太郎");
      expect(logged).not.toContain("住所A");
    } finally {
      spy.mockRestore();
    }
  });

  it("住所ありでも、同じ物件に同じ名前の人がいれば住所が違っても使い回す(2026-11-12 発注者決定)", async () => {
    withAddress([{ name: "山田 太郎", address: "大阪市北区1-1" }]);
    linkedOwners([{ id: "owner-existing", name: "山田太郎", address: "東京都港区1-1" }]);
    await run();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    // 前からいる人の住所は替えない(人が直した住所かもしれない)
    expect(pm.owner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ address: expect.anything() }) }),
    );
  });

  it("異体字だけ違う名前も、同じ物件なら同じ人として使い回す", async () => {
    withAddress([{ name: "高橋一郎", address: "大阪市北区1-1" }]);
    linkedOwners([{ id: "owner-existing", name: "髙橋一郎", address: "東京都港区1-1" }]);
    await run();
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("⚠同じ物件に同じ名前の人がいなければ、従来どおり**全体**から名前+住所で照合する", async () => {
    withAddress([{ name: "山田太郎", address: "東京都港区1-1" }]);
    linkedOwners([{ id: "owner-other", name: "鈴木一郎", address: "東京都港区1-1" }]);
    await run();
    expect(pm.owner.findMany).toHaveBeenCalled();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("同じ謄本に同じ人が住所なし→住所ありの順で載ったら、1人にして住所を埋める(@codex #710 P2)", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都千代田区一番町1",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: null, share: null },
        { name: "山田太郎", address: "大阪市北区1-1", share: null },
      ],
      warnings: [],
      confidence: 0.9,
    });
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { owner: { id: "owner-new", name: "山田太郎", address: null, isArchived: false, corporateNumber: null } },
      ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: null, zip: null, isArchived: false });
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "owner-new", isArchived: false }),
        data: expect.objectContaining({ address: "大阪市北区1-1", version: { increment: 1 } }),
      }),
    );
  });

  it("使い回す人に郵便番号だけ入っているときは住所を埋めない(別の場所の郵便番号と組ませない)", async () => {
    withAddress([{ name: "山田太郎", address: "大阪市北区1-1" }]);
    linkedOwners([{ id: "owner-existing", name: "山田太郎", address: null }]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: null, zip: "100-0001", isArchived: false });
    await run();
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.owner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ address: expect.anything() }) }),
    );
  });

  it("同じ謄本に同じ人が住所違いで2回載っても1人にし、住所は後の行(新しい住所)にする", async () => {
    withAddress([
      { name: "山田太郎", address: "東京都港区1-1" },
      { name: "山田太郎", address: "大阪市北区1-1" },
    ]);
    // 1人目を作ったあとは、その人が物件に紐づいている状態を返す
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { owner: { id: "owner-new", name: "山田太郎", address: "東京都港区1-1", isArchived: false, corporateNumber: null } },
      ]);
    // 所有者の行を押さえて読み直すと、この実行が書いた住所のまま
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: "東京都港区1-1", zip: null, isArchived: false });
    await run();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.owner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "owner-new",
          // この実行が書いた住所のまま・郵便番号は空のまま、のときだけ書く
          AND: expect.arrayContaining([{ address: "東京都港区1-1" }, { OR: [{ zip: null }, { zip: "" }] }]),
        }),
        data: expect.objectContaining({ address: "大阪市北区1-1" }),
      }),
    );
  });

  it("⚠途中で人が住所を直していたら、後の行の住所で上書きしない(@codex #710 P2)", async () => {
    withAddress([
      { name: "山田太郎", address: "東京都港区1-1" },
      { name: "山田太郎", address: "大阪市北区1-1" },
    ]);
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { owner: { id: "owner-new", name: "山田太郎", address: "人が直した住所", isArchived: false, corporateNumber: null } },
      ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: "人が直した住所", zip: null, isArchived: false });
    await run();
    expect(pm.owner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ address: "大阪市北区1-1" }) }),
    );
  });

  it("⚠途中で人が郵便番号を入れていたら、住所だけ替えない(組がずれる・@codex #710 P2)", async () => {
    withAddress([
      { name: "山田太郎", address: "東京都港区1-1" },
      { name: "山田太郎", address: "大阪市北区1-1" },
    ]);
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { owner: { id: "owner-new", name: "山田太郎", address: "東京都港区1-1", isArchived: false, corporateNumber: null } },
      ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: "東京都港区1-1", zip: "105-0001", isArchived: false });
    await run();
    expect(pm.owner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ address: "大阪市北区1-1" }) }),
    );
  });

  it("⚠編集中の人の住所は替えない(@codex #710 P2)", async () => {
    withAddress([
      { name: "山田太郎", address: "東京都港区1-1" },
      { name: "山田太郎", address: "大阪市北区1-1" },
    ]);
    pm.propertyOwner.findMany.mockReset();
    pm.propertyOwner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { owner: { id: "owner-new", name: "山田太郎", address: "東京都港区1-1", isArchived: false, corporateNumber: null } },
      ]);
    pm.owner.findUnique.mockResolvedValue({ corporateNumber: null, address: "東京都港区1-1", zip: null, isArchived: false });
    // 編集中の鍵の確認(SELECT EXISTS ... AS locked)だけ true を返す
    pm.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("edit_locks") ? [{ locked: true }] : [{ id: PROP_ID }],
    );
    await run();
    expect(pm.owner.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ address: "大阪市北区1-1" }) }),
    );
  });
});
