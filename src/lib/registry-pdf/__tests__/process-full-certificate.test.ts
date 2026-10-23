/**
 * 全部事項の所有者反映（下線＝抹消事項を読んだ判定結果を使う）。
 *
 * - 全部事項は、判定できた「今の所有者」だけを反映する（有料取得 all・手動取込とも）
 * - 判定できなければ反映せず警告（安全側）
 * - 確認画面で人が直した所有者はそのまま使う
 * - 所有者事項は従来どおり
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
    propertyOwner: { findFirst: vi.fn(), create: vi.fn() },
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    attachment: { create: vi.fn() },
  };
  // link の親行ロック(#364 R10): $transaction は callback に同じ db を渡す。
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
vi.mock("@/lib/pdf-registry-parser", () => ({
  parseRegistryText: vi.fn(),
}));
vi.mock("@/lib/storage", () => {
  const upload = vi.fn();
  const del = vi.fn();
  return {
    getStorage: () => ({ upload, delete: del }),
    validateFile: vi.fn(() => null),
    ALLOWED_ATTACHMENT_MIMES: ["application/pdf"],
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000") };
});

import prisma from "@/lib/prisma";
import { parseRegistryText } from "@/lib/pdf-registry-parser";
import { getStorage } from "@/lib/storage";
import { processRegistryPdf } from "@/lib/registry-pdf/process";
import { writeAuditLog } from "@/lib/audit";
import type { RegistryRightsSummary } from "@/lib/registry-strike";

const SESSION_ID = "user-1";
const PROP_ID = "11111111-1111-4111-8111-111111111111";
const PDF = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const pm = prisma as unknown as {
  property: { findUnique: Mock; update: Mock };
  owner: { findMany: Mock; create: Mock; updateMany: Mock };
  propertyOwner: { findFirst: Mock; create: Mock };
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  attachment: { create: Mock };
  $transaction: Mock;
};

const session = { id: SESSION_ID, role: "admin", email: "u@test", name: "U" };

beforeEach(() => {
  vi.clearAllMocks();
  // Mode A: 対象物件は既存でアクセス可。
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
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyOwner.create.mockResolvedValue({});
  pm.attachment.create.mockResolvedValue({ id: "att-1" });
  pm.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) =>
    cb(prisma),
  );
  (getStorage().upload as Mock).mockResolvedValue({ url: "/uploads/x.pdf", key: "x.pdf" });
  // 解析結果に所有者を1人含める。
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
});


/** 全部事項の文章（権利部の甲区がある）。pdf-parse の文字と同じく空白入り。中身は架空。 */
const FULL_TEXT = "表 題 部\n権 利 部 （ 甲 区 ） （所 有 権 に 関 す る 事 項）\n…";

const rights = (owners: RegistryRightsSummary["currentOwners"]): RegistryRightsSummary => ({
  underlineDetected: true,
  hasKouku: true,
  hasOtsuku: false,
  currentOwners: owners,
  activeRights: [],
  cautions: [],
  cancelled: { kouku: 0, otsuku: 0 },
  titleHasStruck: false,
  notes: [],
});

const CURRENT = { name: "乙川二郎", address: "東京都品川区架空五丁目5番2号", share: null };

async function run(opts: {
  text?: string;
  certificateType?: "owner" | "all";
  rights?: RegistryRightsSummary | null;
  editedOwners?: { name: string; address?: string; share?: string }[];
}) {
  return processRegistryPdf({
    session,
    text: opts.text ?? FULL_TEXT,
    propertyId: PROP_ID,
    fileName: "謄本.pdf",
    edited: opts.editedOwners ? { owners: opts.editedOwners } : undefined,
    pdfBuffer: PDF,
    certificateType: opts.certificateType,
    ...(opts.rights !== undefined ? { rights: opts.rights } : {}),
  } as Parameters<typeof processRegistryPdf>[0]);
}

const createdNames = () => pm.owner.create.mock.calls.map((c) => c[0].data.name);

describe("全部事項: 下線（抹消事項）を読んだ判定結果の所有者だけを反映する", () => {
  it("有料取得の全部事項(all)でも、判定できた今の所有者を反映する（旧読み取りの所有者は使わない）", async () => {
    await run({ certificateType: "all", rights: rights([CURRENT]) });
    expect(createdNames()).toEqual(["乙川二郎"]);
    expect(pm.propertyOwner.create).toHaveBeenCalledTimes(1);
  });

  it("手で取り込んだ全部事項（種別なし）でも、旧読み取りではなく判定結果を使う", async () => {
    await run({ certificateType: undefined, rights: rights([CURRENT]) });
    expect(createdNames()).toEqual(["乙川二郎"]);
  });

  it("判定できなければ所有者を反映せず、警告を返す（物件の取込と添付は続ける）", async () => {
    const r = await run({ certificateType: undefined, rights: null });
    expect(pm.owner.create).not.toHaveBeenCalled();
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(String(r.warning)).toContain("判定できなかった");
    expect(pm.attachment.create).toHaveBeenCalledTimes(1);
  });

  it("all で判定できなければ、従来どおり反映しない", async () => {
    await run({ certificateType: "all", rights: rights([]) });
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("判定を渡されなければPDFから判定する。読めないPDFなら反映しない（安全側）", async () => {
    const r = await run({ certificateType: "all" });
    expect(pm.propertyOwner.create).not.toHaveBeenCalled();
    expect(String(r.warning)).toContain("判定できなかった");
  });

  it("確認画面で人が直した所有者は、そのまま使う（判定結果で上書きしない）", async () => {
    await run({ rights: rights([CURRENT]), editedOwners: [{ name: "丙山三郎", address: "東京都港区1-1" }] });
    expect(createdNames()).toEqual(["丙山三郎"]);
  });

  it("監査記録には判定結果から反映したかの真偽だけを残す（氏名・住所は残さない）", async () => {
    await run({ rights: rights([CURRENT]) });
    const detail = (writeAuditLog as Mock).mock.calls.at(-1)![0].detail;
    expect(detail.ownersFromFullCertificate).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("乙川二郎");
    expect(JSON.stringify(detail)).not.toContain("品川区");
  });
});

describe("所有者事項（全部事項でない）は従来どおり", () => {
  it("判定結果を渡されても使わず、従来の読み取りの所有者を反映する", async () => {
    await run({ text: "所 有 者 事 項 証 明 書\n…", certificateType: "owner", rights: rights([CURRENT]) });
    expect(createdNames()).toEqual(["山田太郎"]);
    const detail = (writeAuditLog as Mock).mock.calls.at(-1)![0].detail;
    expect(detail.ownersFromFullCertificate).toBe(false);
  });
});
