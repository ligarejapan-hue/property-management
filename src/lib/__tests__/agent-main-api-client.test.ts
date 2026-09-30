import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchPropertyAgentInquiries, putPropertyAdPermission, fetchAgentDirectory, fetchAgentDetail, updateAgent,
} from "@/lib/api-client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
const call = (n = 0) => ({ url: fetchMock.mock.calls[n][0] as string, init: (fetchMock.mock.calls[n][1] ?? {}) as RequestInit });
const PID = "11111111-1111-4111-8111-111111111111";
const AID = "22222222-2222-4222-8222-222222222222";

describe("メイン画面側の API 呼び出し(反響)", () => {
  it("物件の反響欄を読む", async () => {
    await fetchPropertyAgentInquiries(PID);
    expect(call().url).toBe(`/api/properties/${PID}/agent-inquiries`);
  });
  it("広告の可否は1媒体ずつ PUT し、画面に出ていた値(from)を必ず添える", async () => {
    await putPropertyAdPermission(PID, { medium: "suumo", value: "ng", from: "ok" });
    expect(call().url).toBe(`/api/properties/${PID}/ad-permissions`);
    expect(call().init.method).toBe("PUT");
    expect(JSON.parse(String(call().init.body))).toEqual({ items: [{ medium: "suumo", value: "ng", from: "ok" }] });
    await putPropertyAdPermission(PID, { medium: "flyer", value: null, from: "ask" });
    expect(JSON.parse(String(call(1).init.body))).toEqual({ items: [{ medium: "flyer", value: null, from: "ask" }] });
  });
  it("名簿の一覧は list=1。しまった業者・続きは条件があるときだけ載せる", async () => {
    await fetchAgentDirectory({});
    expect(call().url).toBe("/api/agents?list=1");
    await fetchAgentDirectory({ archived: true, cursor: AID });
    expect(call(1).url).toBe(`/api/agents?list=1&archived=1&cursor=${AID}`);
  });
  it("名簿の詳細と履歴の続き", async () => {
    await fetchAgentDetail(AID);
    expect(call().url).toBe(`/api/agents/${AID}`);
    await fetchAgentDetail(AID, PID);
    expect(call(1).url).toBe(`/api/agents/${AID}?cursor=${PID}`);
  });
  it("業者の更新は PATCH で、渡した欄だけ送る", async () => {
    await updateAgent(AID, { version: 3, fax: null });
    expect(call().url).toBe(`/api/agents/${AID}`);
    expect(call().init.method).toBe("PATCH");
    expect(JSON.parse(String(call().init.body))).toEqual({ version: 3, fax: null });
  });
});
