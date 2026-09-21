/**
 * 住所のある所有者を**新規作成する**経路が、親の物件行をロックしてから作ること。
 *
 * ⚠なぜ必要か(提出前レビューで発見):
 * 同じ物件に対する「謄本から所有者を反映」が2つのタブ/端末からほぼ同時に走ると、
 * どちらも「候補なし」と判定したまま進み、**同姓同住所の所有者が2件でき、両方が
 * 同じ物件に紐づく**。PropertyOwner の一意制約は (物件, 所有者) なので別idの2件は
 * 止められず、owners には氏名+住所の一意制約も無い。
 *
 * 住所**なし**の所有者は以前からロック済み(process-owner-dedupe.test.ts)。
 * ここで固定するのは**住所あり**の経路。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(), update: vi.fn() },
    owner: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    propertyOwner: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
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
vi.mock("@/lib/corporate-number", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    detectCorporateNumberInOwnerLike: vi.fn(() => ({ candidates: [] })),
  };
});
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({ upload: vi.fn(), delete: vi.fn() }),
  validateFile: vi.fn(() => null),
  ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
}));

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { detectCorporateNumberInOwnerLike } from "@/lib/corporate-number";
import { processRegistryPdf } from "@/lib/registry-pdf/process";
import fs from "node:fs";
import path from "node:path";

/** 手元(CRLF)とCI(LF)で判定が変わらないよう改行を揃える。 */
const readProcessSource = () =>
  fs
    .readFileSync(
      path.join(process.cwd(), "src/lib/registry-pdf/process.ts"),
      "utf-8",
    )
    .replace(/\r\n/g, "\n");

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";

const pm = prisma as unknown as {
  $queryRaw: Mock;
  $transaction: Mock;
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock; findUnique: Mock };
  propertyOwner: { findFirst: Mock; findMany: Mock; create: Mock; count: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
};

const OWNER = {
  name: "山田太郎",
  address: "東京都渋谷区神宮前三丁目12番3号",
  share: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: SESSION_ID,
    assignedTo: null,
    address: "東京都渋谷区神宮前三丁目12-3",
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
  pm.propertyOwner.count.mockResolvedValue(0);
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (parseRegistryText as Mock).mockReturnValue({
    realEstateNumber: null,
    address: "東京都渋谷区神宮前三丁目12-3",
    lotNumber: null,
    buildingNumber: null,
    landCategory: null,
    area: null,
    owners: [OWNER],
    warnings: [],
    confidence: 0.9,
  });
});

const run = (extra: Record<string, unknown> = {}) =>
  processRegistryPdf({
    session: { id: SESSION_ID, role: "admin" },
    text: "dummy",
    propertyId: PROP_ID,
    fileName: "謄本(所有者事項).pdf",
    edited: undefined,
    pdfBuffer: null,
    certificateType: "owner",
    ...extra,
  });

describe("住所ありの所有者を新規作成するとき", () => {
  it("⚠物件行をロックしてから作る（素の create にしない）", async () => {
    await run();

    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    const lockOrder = pm.$queryRaw.mock.invocationCallOrder[0];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(createOrder);
  });

  it("⚠ロックを取ったあとに、もう一度同じ人がいないか確かめる", async () => {
    await run();
    // 1回目 = ロック前の候補検索 / 2回目 = ロック後の再確認
    expect(pm.owner.findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondSearch = pm.owner.findMany.mock.invocationCallOrder[1];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(secondSearch).toBeLessThan(createOrder);
  });

  it("⚠同時に走ったもう一方が先に作っていたら、新しく作らずそれを使う", async () => {
    // ロック前は「候補なし」、ロック後の再確認では相手が作った所有者が見える
    pm.owner.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "owner-raced", name: OWNER.name, address: OWNER.address },
      ]);

    await run();

    expect(pm.owner.create).not.toHaveBeenCalled();
    const link = pm.propertyOwner.create.mock.calls[0]?.[0] as
      | { data: { ownerId: string } }
      | undefined;
    expect(link?.data.ownerId).toBe("owner-raced");
  });
});

describe("所有者が空の物件だけに入れる指定（requireNoExistingOwners）", () => {
  it("⚠書き込みと同じロックの中で 0 件かを見直す（事前確認は古くなりうる）", async () => {
    await run({ requireNoExistingOwners: true });
    expect(pm.propertyOwner.count).toHaveBeenCalled();
    const lockOrder = pm.$queryRaw.mock.invocationCallOrder[0];
    const countOrder = pm.propertyOwner.count.mock.invocationCallOrder[0];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
    expect(countOrder).toBeLessThan(createOrder);
  });

  it("⚠見直しで所有者が増えていたら中断する（書き込まない）", async () => {
    pm.propertyOwner.count.mockResolvedValue(1);
    await expect(run({ requireNoExistingOwners: true })).rejects.toMatchObject({
      status: 409,
    });
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("⚠作成と紐付けを1つのトランザクションで行う（孤児の所有者を残さない）", async () => {
    // 分けると、作成がコミットしたあとに紐付け側の再確認が409になったとき
    // 「どこにも紐付かない所有者」だけが残る(@codex 第4R)。
    await run({ requireNoExistingOwners: true });

    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
    // 所有者1人につきトランザクションは1つ
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    // 作成も紐付けも、そのトランザクションが始まったあとに起きている
    const txOrder = pm.$transaction.mock.invocationCallOrder[0];
    expect(pm.owner.create.mock.invocationCallOrder[0]).toBeGreaterThan(txOrder);
    expect(pm.propertyOwner.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      txOrder,
    );
  });

  it("⚠共有名義が途中で止まらない（1人目だけ入ってエラー、にしない）", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: OWNER.address, share: "2分の1" },
        { name: "山田花子", address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    // 1人目を入れたあとに、別タブが所有者を足した状況(2回目以降は1件返る)
    let call = 0;
    pm.propertyOwner.count.mockImplementation(async () => {
      call += 1;
      return call === 1 ? 0 : 1;
    });

    await run({ requireNoExistingOwners: true });

    // 承認された2人は両方入る(途中で止めない)
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(2);
    // 数え直すのは最初の書き込みの前だけ
    expect(pm.propertyOwner.count).toHaveBeenCalledTimes(1);
  });

  it("最初の書き込みの前に空であれば、承認された全員が入る（共有名義）", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: OWNER.address, share: "2分の1" },
        { name: "山田花子", address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    pm.propertyOwner.count.mockResolvedValue(0);

    await run({ requireNoExistingOwners: true });

    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(2);
  });

  it("⚠全員ぶんを1つのトランザクションで入れる（途中で失敗しても半端に残さない）", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: OWNER.address, share: "2分の1" },
        { name: "山田花子", address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });

    await run({ requireNoExistingOwners: true });

    // 2人いても、開くトランザクションは1つだけ
    // (所有者ごとに分けると、2人目の失敗で1人目だけ残り、やり直しもできなくなる)
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(2);
  });

  it("⚠まとめる場合、2人目の失敗は握りつぶさず中断する", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "山田太郎", address: OWNER.address, share: "2分の1" },
        { name: "山田花子", address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    // 2人目の紐付けで失敗させる
    pm.propertyOwner.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("connection lost"));

    await expect(run({ requireNoExistingOwners: true })).rejects.toThrow();
  });

  // ⚠この検査はソースを見る形にしている。モックの $transaction は本物の
  //   ロックを取らないため、「自分で自分を待って固まる」不具合を**動かしても再現できない**
  //   (実際、振る舞いのテストを書いたら旧コードでも通ってしまった)。
  it("⚠まとめる場合、法人番号の穴埋めで新しいトランザクションを開かない", () => {
    const src = readProcessSource();
    // ヘルパは渡されたトランザクションがあればそれを使う(無条件に開かない)
    expect(src).toMatch(
      /return outerTx\s*\?\s*run\(outerTx\)\s*:\s*prisma\.\$transaction/,
    );
    // 呼び出し2か所とも、まとめる場合は開いているトランザクションを渡す
    const calls = src.match(
      /fillOwnerCorporateNumberIfUnlocked\([\s\S]{0,200}?\);/g,
    );
    expect(calls).toHaveLength(2);
    for (const call of calls ?? []) {
      expect(call).toContain("asOneBatch ? db : undefined");
    }
  });

  it("指定しない呼び出し元（手動取込など）では見直さない＝共有名義の追加を妨げない", async () => {
    pm.propertyOwner.count.mockResolvedValue(1);
    await run();
    expect(pm.propertyOwner.count).not.toHaveBeenCalled();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });
});
