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

  it("⚠まとめる場合、候補の所有者を物件行より先に押さえる（ロック順を他の窓口とそろえる）", async () => {
    // ⚠1人だけだと再利用の経路がもともと Owner→物件 の順なので差が出ない。
    //   「1人目=新規(物件行を先に押さえる) / 2人目=既存を使い回す(所有者の行を押さえる)」
    //   の2人構成で、先押さえが無いと 物件→Owner の順になることを捕まえる。
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "新規太郎", address: OWNER.address, share: "2分の1" },
        { name: OWNER.name, address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    // 既存の所有者は2人目とだけ一致する
    pm.owner.findMany.mockResolvedValue([
      { id: "owner-existing", name: OWNER.name, address: OWNER.address, corporateNumber: null },
    ]);
    pm.owner.updateMany.mockResolvedValue({ count: 1 });

    await run({ requireNoExistingOwners: true });

    // 所有者の行を押さえる(updateMany)のが、最初の物件行ロック($queryRaw)より先
    const firstOwnerLock = pm.owner.updateMany.mock.invocationCallOrder[0];
    const firstPropertyLock = pm.$queryRaw.mock.invocationCallOrder[0];
    expect(firstOwnerLock).toBeLessThan(firstPropertyLock);
  });

  it("⚠まとめる場合、先押さえの後に現れた所有者は使い回さない（物件ロックの後に所有者の行を待たない）", async () => {
    // ⚠先押さえ(prescan)の後に別の処理が同じ氏名・住所の所有者を作って確定すると、
    //   2人目の探索で見えるようになる。それを押さえに行くと順序が「物件→Owner」になり、
    //   その所有者を押さえて物件を待っている /owners と互いに待ち合う。
    //   まとめる場合は**先に押さえた所有者だけ**を使い回す(見つけても押さえない)。
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "新規太郎", address: OWNER.address, share: "2分の1" },
        { name: OWNER.name, address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    const late = {
      id: "owner-late",
      name: OWNER.name,
      address: OWNER.address,
      corporateNumber: null,
      isArchived: false,
    };
    // 1回目(先押さえ)= まだ居ない / それ以降 = 現れている
    pm.owner.findMany.mockResolvedValueOnce([]).mockResolvedValue([late]);

    await run({ requireNoExistingOwners: true });

    const lockedIds = pm.owner.updateMany.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { id?: string } }).where.id,
    );
    expect(lockedIds).not.toContain("owner-late");
    // 使い回さないので2人とも新規作成
    expect(pm.owner.create).toHaveBeenCalledTimes(2);
  });

  it("⚠まとめない場合、後から現れた所有者を使うときも物件行より先に押さえる（ロック順）", async () => {
    // 手動取込・自動取得(まとめない経路)では、最初の候補探索の後に別の処理が
    // 同じ氏名・住所の所有者を作って確定することがある。それを**物件行を押さえた後**に
    // 押さえると順序が「物件 → Owner」になり、その所有者を先に押さえて物件を待っている
    // /owners と互いに待ち合って、正しい操作の片方が中断される。
    const late = {
      id: "owner-late",
      name: OWNER.name,
      address: OWNER.address,
      corporateNumber: null,
      isArchived: false,
    };
    // 1回目(候補探索)= まだ居ない / それ以降(再探索)= 現れている
    pm.owner.findMany.mockResolvedValueOnce([]).mockResolvedValue([late]);

    await run();

    const lateLock = pm.owner.updateMany.mock.calls.findIndex(
      (c: unknown[]) => (c[0] as { where: { id?: string } }).where.id === "owner-late",
    );
    expect(lateLock).toBeGreaterThanOrEqual(0);
    expect(pm.owner.updateMany.mock.invocationCallOrder[lateLock]).toBeLessThan(
      pm.$queryRaw.mock.invocationCallOrder[0],
    );
    // 押さえられたので使い回す(二重作成しない)
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("⚠まとめる場合でも、この処理の中で作った所有者は使い回す（同じ人が2回載っていても1人にする）", async () => {
    // 同じ氏名・住所が謄本に2回載っていて、既存の所有者が居ないとき:
    // 1人目で作った所有者は先押さえの集合に無いが、**自分が作った行**なので押さえても
    // 順序の問題は起きない。使い回さないと同じ人が2人でき、両方が物件に紐づく。
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: OWNER.name, address: OWNER.address, share: "2分の1" },
        { name: OWNER.name, address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    // 作った所有者は、以後の探索で見える(同じトランザクションの中)
    const createdRows: Array<Record<string, unknown>> = [];
    pm.owner.findMany.mockImplementation(async () => createdRows);
    pm.owner.create.mockImplementation(async () => {
      createdRows.push({
        id: "owner-new",
        name: OWNER.name,
        address: OWNER.address,
        corporateNumber: null,
        isArchived: false,
      });
      return { id: "owner-new" };
    });

    await run({ requireNoExistingOwners: true });

    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("まとめない場合（手動取込など）は、見つけた所有者を押さえて使い回す＝従来どおり", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [
        { name: "新規太郎", address: OWNER.address, share: "2分の1" },
        { name: OWNER.name, address: OWNER.address, share: "2分の1" },
      ],
      warnings: [],
      confidence: 0.9,
    });
    const late = {
      id: "owner-late",
      name: OWNER.name,
      address: OWNER.address,
      corporateNumber: null,
      isArchived: false,
    };
    pm.owner.findMany.mockResolvedValueOnce([]).mockResolvedValue([late]);

    await run();

    const lockedIds = pm.owner.updateMany.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { id?: string } }).where.id,
    );
    expect(lockedIds).toContain("owner-late");
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });

  it("⚠再探索で拾った所有者が、その瞬間にアーカイブされていたら新規作成に回す", async () => {
    // ロック前は候補なし、ロック後の再探索では同姓同住所が見つかる(同時に作られた)
    pm.owner.findMany
      .mockResolvedValueOnce([]) // まとめる経路の先押さえ(候補なし)
      .mockResolvedValueOnce([]) // ループ内の候補検索(なし)
      .mockResolvedValueOnce([
        { id: "owner-raced", name: OWNER.name, address: OWNER.address },
      ]);
    // 押さえようとしたら 0 件 = アーカイブされた直後
    pm.owner.updateMany.mockResolvedValue({ count: 0 });

    await run({ requireNoExistingOwners: true });

    // アーカイブ済みには紐づけず、新しく作る
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    const link = pm.propertyOwner.create.mock.calls[0]?.[0] as
      | { data: { ownerId: string } }
      | undefined;
    expect(link?.data.ownerId).not.toBe("owner-raced");
  });

  it("⚠所有者の登録が確定したあとの記録書きが失敗しても、成功として返す", async () => {
    // 1回目=開始の記録(成功) / 2回目=完了の記録(失敗)
    pm.importJob.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("connection lost"));

    await expect(run({ requireNoExistingOwners: true })).resolves.toBeDefined();
    // 所有者は入っている
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
  });

  it("⚠記録書きの失敗ログに、生のエラー文(住所などを含みうる)を出さない", async () => {
    // Prisma の検証エラーは、拒否した呼び出しのデータ(rawData の住所など)を message に
    // 埋め込む。ログに出してよいのは「エラーの種類」と「コード」だけ(許可リスト方式)。
    const leaky = Object.assign(
      new Error("Invalid invocation: rawData: { address: '東京都渋谷区神宮前三丁目12-3' }"),
      { code: "P2009", name: "PrismaClientValidationError" },
    );
    pm.importJobRow.create.mockRejectedValueOnce(leaky);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run({ requireNoExistingOwners: true })).resolves.toBeDefined();
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).not.toContain("神宮前");
      expect(logged).not.toContain("rawData");
      expect(logged).toContain("job-row");
      expect(logged).toContain("PrismaClientValidationError");
      expect(logged).toContain("P2009");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("⚠ownersOnly では法人番号を判定も書き込みもしない（下見に出していない項目）", async () => {
    // 氏名に13桁の数字が含まれると、通常は法人番号として保存される
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [{ name: "株式会社サンプル 1234567890123", address: OWNER.address, share: null }],
      warnings: [],
      confidence: 0.9,
    });

    // ⚠検出は差し替えているので、候補を1件返して「通常なら保存される」状況を作る
    //   (これが無いと skip の有無に関わらず保存されず、テストが空振りする)
    (detectCorporateNumberInOwnerLike as unknown as Mock).mockReturnValue({
      candidates: ["1234567890123"],
    });

    await run({ requireNoExistingOwners: true, ownersOnly: true });

    expect(pm.owner.create).toHaveBeenCalledTimes(1);
    const data = (pm.owner.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("corporateNumber");
  });

  it("⚠まとめる場合、物件行のロックの中・最初の書き込みの前に beforeFirstWrite を呼ぶ", async () => {
    // 呼び出し元が受付時点で確かめたこと(下見で見せた添付が今も最新か)を、
    // 書き込みと同じロックの中で見直すための入口。
    const hook = vi.fn(async () => {});
    await run({ requireNoExistingOwners: true, beforeFirstWrite: hook });

    expect(hook).toHaveBeenCalledTimes(1);
    const lockOrder = pm.$queryRaw.mock.invocationCallOrder[0];
    const hookOrder = hook.mock.invocationCallOrder[0];
    const createOrder = pm.owner.create.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(hookOrder);
    expect(hookOrder).toBeLessThan(createOrder);
  });

  it("⚠beforeFirstWrite が中断したら何も書かない", async () => {
    const hook = vi.fn(async () => {
      throw Object.assign(new Error("changed"), { status: 409 });
    });
    await expect(
      run({ requireNoExistingOwners: true, beforeFirstWrite: hook }),
    ).rejects.toMatchObject({ status: 409 });
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("指定しない呼び出し元（手動取込など）では見直さない＝共有名義の追加を妨げない", async () => {
    pm.propertyOwner.count.mockResolvedValue(1);
    await run();
    expect(pm.propertyOwner.count).not.toHaveBeenCalled();
    expect(pm.owner.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⚠なぜ必要か(@codex 第14R P1): 担当者だけの権限(field_staff)は「自分が作った/担当の
 * 物件」しか扱えない。route の事前確認を通ったあと、書き込みのロックを取るまでの間に
 * 担当を外されると、素のロック(lockPropertyRow)は担当を見直さないので、
 * もう扱えない物件に所有者が永久に残る。ロックと同じ1文で担当を確かめる
 * (lockPropertyRecordForWrite)= 付け替えはこの tx の commit まで待たされ、
 * ロック時点で担当外なら 0 件 → 403 で何も書かない。
 */
describe("書き込みのロックの中で担当者スコープを見直す（enforcePropertyScope）", () => {
  const FIELD_STAFF = { id: SESSION_ID, role: "field_staff" };
  const runScoped = (extra: Record<string, unknown> = {}) =>
    run({
      session: FIELD_STAFF,
      requireNoExistingOwners: true,
      ownersOnly: true,
      enforcePropertyScope: true,
      ...extra,
    });

  beforeEach(() => {
    // 事前確認は通る(担当者本人)
    pm.property.findUnique.mockResolvedValue({
      id: PROP_ID,
      createdBy: "someone-else",
      assignedTo: SESSION_ID,
      address: "東京都渋谷区神宮前三丁目12-3",
      realEstateNumber: null,
    });
  });

  it("⚠ロックの1文に担当者の id を渡す（素のロックにしない）", async () => {
    await runScoped();
    // lockPropertyRowInternal の引数順 = (物件id, スコープの利用者id)
    const scopeArgs = pm.$queryRaw.mock.calls.map((c: unknown[]) => c[2]);
    expect(scopeArgs.length).toBeGreaterThan(0);
    expect(scopeArgs.every((v: unknown) => v === SESSION_ID)).toBe(true);
  });

  it("⚠ロック時点で担当を外されていたら 403 で何も書かない", async () => {
    pm.$queryRaw.mockResolvedValue([]); // 担当外 = 0 件
    await expect(runScoped()).rejects.toMatchObject({ status: 403 });
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("⚠住所なしの所有者の経路も同じく 403 で止まる", async () => {
    (parseRegistryText as Mock).mockReturnValue({
      realEstateNumber: null,
      address: "東京都渋谷区神宮前三丁目12-3",
      lotNumber: null,
      buildingNumber: null,
      landCategory: null,
      area: null,
      owners: [{ name: OWNER.name, address: null, share: null }],
      warnings: [],
      confidence: 0.9,
    });
    pm.$queryRaw.mockResolvedValue([]);
    await expect(runScoped()).rejects.toMatchObject({ status: 403 });
    expect(pm.owner.create).not.toHaveBeenCalled();
  });

  it("⚠既存の所有者を使い回す経路も同じく 403 で止まる", async () => {
    pm.owner.findMany.mockResolvedValue([
      { id: "owner-existing", name: OWNER.name, address: OWNER.address, isArchived: false },
    ]);
    pm.$queryRaw.mockResolvedValue([]);
    await expect(runScoped()).rejects.toMatchObject({ status: 403 });
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("指定しない呼び出し元（有料取得など）は従来どおり素のロック＝担当を外されても保存を止めない", async () => {
    // 有料取得は「課金後は止めない」。取得を頼んだ担当者がその間に外されても、
    // 買った謄本の結果は保存される必要がある。
    await run({ session: FIELD_STAFF, requireNoExistingOwners: true, ownersOnly: true });
    const scopeArgs = pm.$queryRaw.mock.calls.map((c: unknown[]) => c[2]);
    expect(scopeArgs.length).toBeGreaterThan(0);
    expect(scopeArgs.every((v: unknown) => v === null)).toBe(true);
  });
});
