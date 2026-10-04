import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, tx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    mlitAgent: { findUnique: vi.fn() },
    agent: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { db, tx };
});
vi.mock("@/lib/prisma", () => ({ default: db }));

import { registryQueryVariants, searchRegistry, REGISTRY_LIMIT } from "@/lib/agent-registry/search";
import { adoptRegistryAgent } from "@/lib/agent-registry/adopt";

const sqlText = (call: unknown[]) => {
  const q = call[0] as { strings?: readonly string[]; sql?: string; values?: unknown[] };
  return { text: q.sql ?? (q.strings ?? []).join("?"), values: q.values ?? [] };
};

beforeEach(() => vi.clearAllMocks());

describe("国交省の一覧から探す", () => {
  it("ひらがなで打ってもカタカナのふりがなに当たる・全角/半角の両方", () => {
    const v = registryQueryVariants("みほん");
    expect(v).toContain("みほん");
    expect(v).toContain("ミホン");
    expect(registryQueryVariants("ABC")).toEqual(expect.arrayContaining(["ABC", "ＡＢＣ"]));
  });

  it("探す語が短すぎる(会社名1文字・電話6桁以下)ときは探さない", async () => {
    expect(await searchRegistry("あ")).toEqual([]);
    expect(await searchRegistry("031234")).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("★一覧に載っている・電話がある会社だけ/名簿に写し済み・名簿に同じ代表電話がある会社は出さない/10件まで", async () => {
    await searchRegistry("見本不動産");
    const { text, values } = sqlText(db.$queryRaw.mock.calls[0]);
    expect(text).toContain("m.listed = true");
    expect(text).toContain("m.phone_digits IS NOT NULL");
    expect(text).toMatch(/NOT EXISTS[\s\S]*a\.is_archived = false[\s\S]*a\.mlit_agent_id = m\.id[\s\S]*regexp_replace\(a\.phone, '\[\^0-9\]', '', 'g'\) = m\.phone_digits/);
    expect(text).toMatch(/LIMIT/);
    expect(values).toContain(REGISTRY_LIMIT);
  });

  it("電話(7桁以上)は数字で照合・ハイフンの有無を問わない", async () => {
    await searchRegistry("03-0000-12");
    const { text, values } = sqlText(db.$queryRaw.mock.calls[0]);
    expect(text).toContain("m.phone_digits LIKE");
    expect(values).toContain("%03000012%");
  });

  it("結果は会社名・電話・免許の表示だけ(所在地や個人名は返さない)", async () => {
    db.$queryRaw.mockResolvedValueOnce([
      { id: "m1", company_name: "株式会社 見本不動産", phone: "03-0000-1212", license_label: "東京都知事(17)第000001号" },
    ] as never);
    expect(await searchRegistry("見本不動産")).toEqual([
      { id: "m1", companyName: "株式会社 見本不動産", phone: "03-0000-1212", licenseLabel: "東京都知事(17)第000001号" },
    ]);
  });
});

describe("一覧の会社を名簿へ写す", () => {
  const MID = "33333333-3333-4333-8333-333333333333";
  const reg = {
    id: MID,
    listed: true,
    companyName: "株式会社 見本不動産",
    companyKana: "カブシキガイシヤ ミホンフドウサン",
    licenseLabel: "東京都知事(17)第000001号",
    address: "東京都世田谷区見本町４－１１－２４",
    phone: "03-0000-1212",
    phoneDigits: "0300001212",
  };
  beforeEach(() => {
    tx.$queryRaw.mockResolvedValue([{ id: MID }]);
    tx.mlitAgent.findUnique.mockResolvedValue(reg);
    tx.agent.findFirst.mockResolvedValue(null);
  });

  it("★一覧の行を先にロックしてから名簿を見る(同時2回で1件になる前提=実DBの確認は計画の Task 7)", async () => {
    tx.agent.create.mockResolvedValue({ id: "a-new", companyName: reg.companyName, branchName: null, phone: reg.phone });
    await adoptRegistryAgent(MID, "u1");
    const { text } = sqlText(tx.$queryRaw.mock.calls[0]);
    expect(text).toMatch(/FROM "mlit_agents"[\s\S]*FOR UPDATE/);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.agent.findFirst.mock.invocationCallOrder[0]);
  });

  it("★同じ代表電話の会社どうしの写しも1本ずつ(電話の数字で鍵をかけてから名簿を見る・@codex #477)", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]).mockResolvedValueOnce([]);
    tx.agent.create.mockResolvedValue({ id: "a-new", companyName: reg.companyName, branchName: null, phone: reg.phone });
    await adoptRegistryAgent(MID, "u1");
    const { text, values } = sqlText(tx.$executeRaw.mock.calls[0]);
    expect(text).toContain("pg_advisory_xact_lock");
    expect(values.join(" ")).toContain("0300001212");
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.agent.findFirst.mock.invocationCallOrder[0]);
  });

  it("名簿に写し済み(しまっていない)→ それを返す・作らない", async () => {
    tx.agent.findFirst.mockResolvedValueOnce({ id: "a1", companyName: "見本", branchName: "本店", phone: "03-0000-1212" });
    const r = await adoptRegistryAgent(MID, "u1");
    expect(r).toEqual({
      ok: true,
      created: false,
      agent: { id: "a1", companyName: "見本", branchName: "本店", phone: "03-0000-1212", lastContact: null, matchedBy: "text" },
    });
    expect(tx.agent.create).not.toHaveBeenCalled();
  });

  it("名簿に同じ代表電話の業者 → それに一覧の印を付けて返す・作らない", async () => {
    tx.agent.findFirst.mockResolvedValueOnce(null);
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]).mockResolvedValueOnce([{ id: "a2" }]);
    tx.agent.update.mockResolvedValue({ id: "a2", companyName: "見本(手入力)", branchName: null, phone: "0300001212" });
    const r = await adoptRegistryAgent(MID, "u1");
    expect(r.ok && r.created).toBe(false);
    expect(tx.agent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a2" }, data: { mlitAgentId: MID } }));
    expect(tx.agent.create).not.toHaveBeenCalled();
  });

  it("★同じ代表電話の名簿の業者が、すでに別の一覧の会社と結び付いていたら書き換えない(それを返すだけ)", async () => {
    tx.agent.findFirst.mockResolvedValueOnce(null);
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]).mockResolvedValueOnce([{ id: "a3", mlit_agent_id: "other-registry-row" }]);
    tx.agent.findUnique.mockResolvedValueOnce({ id: "a3", companyName: "グループ会社", branchName: null, phone: "03-0000-1212" });
    const r = await adoptRegistryAgent(MID, "u1");
    expect(r).toMatchObject({ ok: true, created: false, agent: { id: "a3" } });
    expect(tx.agent.update).not.toHaveBeenCalled();
    expect(tx.agent.create).not.toHaveBeenCalled();
  });

  it("どちらも無い → 商号・ふりがな・免許・所在地・電話で作る(登録者=押した人・元の行を覚える)", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]).mockResolvedValueOnce([]);
    tx.agent.create.mockResolvedValue({ id: "a-new", companyName: reg.companyName, branchName: null, phone: reg.phone });
    const r = await adoptRegistryAgent(MID, "u1");
    expect(r.ok && r.created).toBe(true);
    expect(tx.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          companyName: reg.companyName,
          companyKana: reg.companyKana,
          licenseNo: reg.licenseLabel,
          address: reg.address,
          phone: reg.phone,
          createdById: "u1",
          mlitAgentId: MID,
        },
      }),
    );
  });

  it("無い行は not_found・一覧から外れた/電話が無い行は unavailable(作らない)", async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await adoptRegistryAgent(MID, "u1")).toEqual({ ok: false, reason: "not_found" });
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]);
    tx.mlitAgent.findUnique.mockResolvedValueOnce({ ...reg, listed: false });
    expect(await adoptRegistryAgent(MID, "u1")).toEqual({ ok: false, reason: "unavailable" });
    tx.$queryRaw.mockResolvedValueOnce([{ id: MID }]);
    tx.mlitAgent.findUnique.mockResolvedValueOnce({ ...reg, phone: null, phoneDigits: null });
    expect(await adoptRegistryAgent(MID, "u1")).toEqual({ ok: false, reason: "unavailable" });
    expect(tx.agent.create).not.toHaveBeenCalled();
  });
});
