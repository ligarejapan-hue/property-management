import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  searchDeskAgents, createDeskAgent, searchDeskProperties, createAgentInquiry, fetchAgentInquiries,
  fetchAgentInquiry, updateAgentInquiry, addAgentViewing, updateAgentViewing, fetchAgentInquiryCounts,
  fetchUpcomingViewings, apiErrorCode,
} from "@/lib/api-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
const call = (n = 0) => ({ url: fetchMock.mock.calls[n][0] as string, init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });

describe("受付の窓の API 呼び出し", () => {
  it("検索語は URL に符号化して載せる", async () => {
    await searchDeskAgents("○○ 不動産");
    expect(call().url).toBe("/api/agents?q=" + encodeURIComponent("○○ 不動産"));
    await searchDeskProperties("サンライズ 305");
    expect(call(1).url).toBe("/api/agent-inquiries/property-search?q=" + encodeURIComponent("サンライズ 305"));
  });
  it("登録系は POST+JSON", async () => {
    await createDeskAgent({ companyName: "x", phone: "03" });
    expect(call().url).toBe("/api/agents");
    expect(call().init.method).toBe("POST");
    await createAgentInquiry({ propertyId: "p", agentId: "a", kind: "ad_permission", channel: "phone" });
    expect(call(1).url).toBe("/api/agent-inquiries");
    expect(JSON.parse(String(call(1).init.body))).toMatchObject({ kind: "ad_permission" });
  });
  it("一覧は空の条件を URL に載せない", async () => {
    await fetchAgentInquiries({ status: "open" });
    expect(call().url).toBe("/api/agent-inquiries?status=open");
    await fetchAgentInquiries({ status: "done", assignee: "me", cursor: "c1" });
    expect(call(1).url).toBe("/api/agent-inquiries?status=done&assignee=me&cursor=c1");
  });
  it("詳細・変更・内見・件数・今日明日", async () => {
    await fetchAgentInquiry("i1");
    expect(call().url).toBe("/api/agent-inquiries/i1");
    await updateAgentInquiry("i1", { version: 2, status: "done" });
    expect(call(1).init.method).toBe("PATCH");
    await addAgentViewing("i1", { viewingType: "guided" });
    expect(call(2).url).toBe("/api/agent-inquiries/i1/viewings");
    await updateAgentViewing("i1", "v1", { version: 1, canceled: true });
    expect(call(3).url).toBe("/api/agent-inquiries/i1/viewings/v1");
    await fetchAgentInquiryCounts();
    expect(call(4).url).toBe("/api/agent-inquiries/counts");
    await fetchUpcomingViewings();
    expect(call(5).url).toBe("/api/agent-inquiries/upcoming");
  });
  it("409 は code=VERSION_CONFLICT として読める", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "x" } }), { status: 409 }));
    const e = await updateAgentInquiry("i1", { version: 1, status: "done" }).catch((err) => err);
    expect(apiErrorCode(e)).toBe("VERSION_CONFLICT");
  });
});
