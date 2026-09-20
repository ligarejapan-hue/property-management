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
    owner: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    propertyOwner: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
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
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock };
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
    expect(order).toEqual(["lock:true", "lookup:true", "create:true", "lock:true"]);
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

  it("⚠住所ありの所有者は従来どおり**全体**から照合する（この変更で経路を変えない）", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都千代田区一番町1",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [{ name: "山田太郎", address: "東京都港区1-1", share: null }],
      warnings: [],
      confidence: 0.9,
    });
    linkedOwners([{ id: "owner-existing", name: "山田太郎" }]);
    await run();
    // 住所ありは owner.findMany（全体照合）を使う。物件内の再利用に流さない。
    expect(pm.owner.findMany).toHaveBeenCalled();
  });
});
