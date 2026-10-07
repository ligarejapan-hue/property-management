import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("next/server", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("@/lib/__tests__/agent-inquiry-route-mocks")).apiHelpersMock());
const { writeAuditLog, adoptRegistryAgent } = vi.hoisted(() => ({ writeAuditLog: vi.fn(), adoptRegistryAgent: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
vi.mock("@/lib/agent-registry/adopt", () => ({ adoptRegistryAgent }));
vi.mock("@/lib/prisma", () => ({ default: {} }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../route";

type Fn = ReturnType<typeof vi.fn>;
const MID = "33333333-3333-4333-8333-333333333333";
const ctx = (id = MID) => ({ params: Promise.resolve({ id }) });
const req = () => new Request(`http://x/api/agent-registry/${MID}/adopt`, { method: "POST" });
const grant = (...actions: string[]) =>
  (getUserPermissions as Fn).mockResolvedValue(actions.map((a) => ({ resource: "agent_inquiry", action: a, granted: true })));
const hit = { id: "a-new", companyName: "株式会社 見本不動産", branchName: null, phone: "03-0000-1212", lastContact: null, matchedBy: "text" };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u1", role: "office_staff" });
  grant("read", "write");
});

describe("POST /api/agent-registry/{id}/adopt", () => {
  it("登録の権限が無ければ 403(写さない)", async () => {
    grant("read");
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(adoptRegistryAgent).not.toHaveBeenCalled();
  });

  it("id が UUID でなければ 422", async () => {
    expect((await POST(req(), ctx("x"))).status).toBe(422);
  });

  it("作ったら 201・監査1件(会社の値は書かない)", async () => {
    adoptRegistryAgent.mockResolvedValue({ ok: true, created: true, agent: hit });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ agent: hit, created: true });
    expect(adoptRegistryAgent).toHaveBeenCalledWith(MID, "u1");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = JSON.stringify(writeAuditLog.mock.calls);
    expect(audit).toContain("agent_create");
    expect(audit).not.toContain("03-0000-1212");
    expect(audit).not.toContain("見本不動産");
  });

  it("名簿にあった(作っていない)→ 200・監査は書かない", async () => {
    adoptRegistryAgent.mockResolvedValue({ ok: true, created: false, agent: hit });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("無い行 404・使えない行 409", async () => {
    adoptRegistryAgent.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await POST(req(), ctx())).status).toBe(404);
    adoptRegistryAgent.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect((await POST(req(), ctx())).status).toBe(409);
  });
});
