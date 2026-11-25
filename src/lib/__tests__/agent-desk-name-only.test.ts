import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EMPTY_DESK_FORM,
  buildCreateBody,
  deskFormReducer,
  newAgentPrefill,
  nextDeskGuideStep,
  validateDeskForm,
} from "@/lib/agent-inquiry/desk-form";
import { inquiryAgentName } from "@/lib/agent-inquiry/agent-name";
import { buildPropertyTimeline } from "@/lib/agent-inquiry/timeline";
import type { AgentHit, DeskProperty } from "@/lib/api-client";

const hit: AgentHit = { id: "a1", companyName: "中野不動産", branchName: null, phone: "03-1111-2222", lastContact: null, matchedBy: "text" };
const prop = { id: "p1", name: "物件", roomNo: null, town: "中野", propertyType: "land", adPermissions: {} } as unknown as DeskProperty;

describe("新しい業者の小窓へ、業者の欄に打った語を写す", () => {
  it("会社名は商号へ", () => {
    expect(newAgentPrefill(" 中野不動産 ")).toEqual({ companyName: "中野不動産", agentPhone: "", callerMobile: null });
  });
  it("固定電話は代表電話へ・携帯は問い合わせ者へ(商号は空)", () => {
    expect(newAgentPrefill("03-1234-5678")).toEqual({ companyName: "", agentPhone: "03-1234-5678", callerMobile: null });
    expect(newAgentPrefill("090-1234-5678")).toEqual({ companyName: "", agentPhone: "", callerMobile: "090-1234-5678" });
  });
  it("空なら何も入れない", () => {
    expect(newAgentPrefill("")).toEqual({ companyName: "", agentPhone: "", callerMobile: null });
  });
  it("受付の窓・業者名簿の画面の両方で商号を渡す", () => {
    const root = path.resolve(__dirname, "../../..");
    const form = readFileSync(path.join(root, "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    const page = readFileSync(path.join(root, "src/app/(desk)/agents/page.tsx"), "utf8");
    expect(form).toContain("initialCompanyName={newAgentPhone.companyName}");
    expect(page).toContain("initialCompanyName={newAgentPrefill(query).companyName}");
  });
});

describe("名簿に入れずに受け付ける(フォーム)", () => {
  const typed = deskFormReducer(EMPTY_DESK_FORM, { type: "agentQuery", value: " 山田工務店 " });
  const nameOnly = deskFormReducer(typed, { type: "agentNameOnly" });

  it("押すと名前だけで受け付ける状態になる", () => {
    expect(nameOnly.agentNameOnly).toBe(true);
    expect(nameOnly.agent).toBeNull();
    expect(nameOnly.agentQuery).toBe("山田工務店");
    expect(validateDeskForm(nameOnly).agent).toBeUndefined();
    expect(nextDeskGuideStep(nameOnly)).toBe("property");
  });
  it("打ち直すと外れる(打ち直した名前で黙って受け付けない)", () => {
    const retyped = deskFormReducer(nameOnly, { type: "agentQuery", value: "山田工務" });
    expect(retyped.agentNameOnly).toBe(false);
    expect(validateDeskForm(retyped).agent).toBeDefined();
  });
  it("名簿の業者を選ぶと外れる", () => {
    const picked = deskFormReducer(nameOnly, { type: "agentSelected", agent: hit });
    expect(picked.agentNameOnly).toBe(false);
    expect(picked.agent?.id).toBe("a1");
  });
  it("空の欄では受け付けない", () => {
    expect(deskFormReducer(EMPTY_DESK_FORM, { type: "agentNameOnly" })).toBe(EMPTY_DESK_FORM);
  });
  it("送る形=名前だけ(agentId は送らない)/名簿の業者=agentId だけ", () => {
    const body = buildCreateBody({ ...nameOnly, property: prop, kind: "ad_permission" });
    expect(body.agentNameText).toBe("山田工務店");
    expect(body.agentId).toBeUndefined();
    const picked = deskFormReducer(nameOnly, { type: "agentSelected", agent: hit });
    const body2 = buildCreateBody({ ...picked, property: prop, kind: "ad_permission" });
    expect(body2.agentId).toBe("a1");
    expect(body2.agentNameText).toBeUndefined();
  });
  it("受付の窓の業者の欄に「名簿に入れずに受け付ける」をつなぐ", () => {
    const root = path.resolve(__dirname, "../../..");
    const form = readFileSync(path.join(root, "src/components/agent-inquiry/inquiry-form.tsx"), "utf8");
    const picker = readFileSync(path.join(root, "src/components/agent-inquiry/agent-picker.tsx"), "utf8");
    expect(form).toContain('onUseNameOnly={() => dispatch({ type: "agentNameOnly" })}');
    expect(picker).toContain("名簿に入れずに「${query.trim()}」で受け付ける");
    // 電話番号だけの語では出さない・探し終えてから
    expect(picker).toMatch(/onUseNameOnly && createAction !== "none" && !isPhoneCharsOnly\(query\)/);
  });
});

describe("業者の呼び名", () => {
  it("名簿の業者=会社名(支店まで)・名簿なし=受付で打った名前", () => {
    expect(inquiryAgentName({ agent: { companyName: "中野不動産", branchName: "駅前店" } })).toBe("中野不動産 駅前店");
    expect(inquiryAgentName({ agent: null, agentNameText: "山田工務店" })).toBe("山田工務店");
    expect(inquiryAgentName({ agent: null, agentNameText: null })).toBe("業者不明");
  });
  it("物件の時系列でも名前を出す", () => {
    const rows = buildPropertyTimeline([
      { id: "i1", kind: "ad_permission", receivedAt: new Date(), status: "open", agent: null, agentNameText: "山田工務店", contactName: null, viewings: [] },
    ]);
    expect(rows[0].agentName).toBe("山田工務店");
  });
});
