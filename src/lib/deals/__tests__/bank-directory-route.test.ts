import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
vi.mock("@/lib/prisma", () => ({
  default: {
    bankInstitution: { findMany: vi.fn(async () => []) },
    bankBranch: { findMany: vi.fn(async () => []) },
  },
}));

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { DEAL_PERMS } from "./route-mocks";
import { toSearchKey } from "@/lib/bank-directory/names";
import { GET as BANKS } from "../../../app/api/deals/bank-directory/banks/route";
import { GET as BRANCHES } from "../../../app/api/deals/bank-directory/branches/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as { bankInstitution: { findMany: Fn }; bankBranch: { findMany: Fn } };
const row = (code: string, name: string, hira: string, roma: string) => ({ code, name, kana: toSearchKey(hira), roma });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.bankInstitution.findMany.mockResolvedValue([
    row("0009", "三井住友銀行", "みついすみとも", "mitsuisumitomo"),
    row("0001", "みずほ銀行", "みずほ", "mizuho"),
    row("0010", "りそな銀行", "りそな", "risona"),
  ]);
  pm.bankBranch.findMany.mockResolvedValue([
    row("108", "神田支店", "かんだ", "kanda"),
    row("100", "本店", "ほんてん", "honten"),
  ]);
});

describe("GET /api/deals/bank-directory/banks", () => {
  it("取引の権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await BANKS(new Request("http://x/api/deals/bank-directory/banks?q=み"))).status).toBe(403);
  });
  it("1文字目から候補を返す(コードと正式な名前だけ)", async () => {
    const res = await BANKS(new Request(`http://x/api/deals/bank-directory/banks?q=${encodeURIComponent("み")}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ code: "0001", name: "みずほ銀行" }, { code: "0009", name: "三井住友銀行" }] });
  });
  it("空なら表を読まずに空", async () => {
    const res = await BANKS(new Request("http://x/api/deals/bank-directory/banks?q=%20"));
    expect(await res.json()).toEqual({ data: [] });
    expect(pm.bankInstitution.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/deals/bank-directory/branches", () => {
  it("取引の権限が無ければ 403", async () => {
    (getUserPermissions as Fn).mockResolvedValue([]);
    expect((await BRANCHES(new Request("http://x/api/deals/bank-directory/branches?bank=0001&q=か"))).status).toBe(403);
  });
  it("選んだ銀行の支店だけから探す", async () => {
    const res = await BRANCHES(new Request(`http://x/api/deals/bank-directory/branches?bank=0001&q=${encodeURIComponent("か")}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ code: "108", name: "神田支店" }] });
    expect(pm.bankBranch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { bankCode: "0001" } }));
  });
  it("銀行コードの形が違えば 400(表は読まない)", async () => {
    for (const bank of ["", "1", "abcd", "00011"]) {
      const res = await BRANCHES(new Request(`http://x/api/deals/bank-directory/branches?bank=${bank}&q=a`));
      expect(res.status).toBe(400);
    }
    expect(pm.bankBranch.findMany).not.toHaveBeenCalled();
  });
});
