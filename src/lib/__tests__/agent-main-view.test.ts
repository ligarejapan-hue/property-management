import { describe, it, expect } from "vitest";
import type { AgentDetail } from "@/lib/api-client";
import {
  nextAdValue, formatJstFull, formatJstDate, timelineKindLabel, timelineWhen, agentFieldValue, agentEditError,
  agentEditPatch, homeInquiryChips, windowNameFor, MAIN_WINDOW_NAME, DESK_WINDOW_NAME, AGENT_EDIT_FIELDS,
} from "@/lib/agent-inquiry/main-view";

const agent: AgentDetail = {
  id: "a1", companyName: "○○不動産", companyKana: null, branchName: "新宿支店", licenseNo: null,
  phone: "03-1234-5678", fax: null, email: "info@example.jp", address: null, note: null, isArchived: false, version: 4,
};

describe("広告の可否の次の値", () => {
  it("○→×→△→未設定→○ と一巡する(設計 §2.3)", () => {
    expect(nextAdValue("ok")).toBe("ng");
    expect(nextAdValue("ng")).toBe("ask");
    expect(nextAdValue("ask")).toBeNull();
    expect(nextAdValue(null)).toBe("ok");
  });
});

describe("日時の表示(JST・年つき)", () => {
  it("UTC の 15:00 は翌日の 0:00(JST)", () => {
    expect(formatJstFull("2026-12-31T15:00:00.000Z")).toBe("2027/1/1(金) 0:00");
    expect(formatJstDate("2026-12-31T15:00:00.000Z")).toBe("2027/1/1");
  });
  it("分は2桁", () => {
    expect(formatJstFull("2026-10-02T05:05:00.000Z")).toBe("2026/10/2(金) 14:05");
  });
});

describe("時系列の1行", () => {
  it("内見は案内/下見、それ以外は用件の名前", () => {
    expect(timelineKindLabel({ kind: "viewing", viewingType: "guided" })).toBe("案内");
    expect(timelineKindLabel({ kind: "viewing", viewingType: "preview" })).toBe("下見");
    expect(timelineKindLabel({ kind: "viewing", viewingType: null })).toBe("内見");
    expect(timelineKindLabel({ kind: "material_request", viewingType: null })).toBe("資料請求");
    expect(timelineKindLabel({ kind: "ad_permission", viewingType: null })).toBe("広告の許可");
  });
  it("日程が決まっていない内見は、受けた日時を添えて日程調整中と出す", () => {
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: true })).toBe("日程調整中(受付 2026/10/2(金) 14:00)");
    expect(timelineWhen({ at: "2026-10-02T05:00:00.000Z", unscheduled: false })).toBe("2026/10/2(金) 14:00");
  });
});

describe("名簿の編集=触った欄だけ送る", () => {
  it("触っていなければ最新の値を出し、送るものは無い", () => {
    expect(agentFieldValue(agent, {}, "branchName")).toBe("新宿支店");
    expect(agentFieldValue(agent, {}, "fax")).toBe("");
    expect(agentEditPatch(agent, {})).toBeNull();
  });
  it("触った欄だけを送る。空にした任意の欄は null", () => {
    expect(agentEditPatch(agent, { branchName: " 渋谷支店 ", email: "" })).toEqual({ branchName: "渋谷支店", email: null });
  });
  it("触ったが元と同じ(前後の空白だけ違う)なら送らない", () => {
    expect(agentEditPatch(agent, { branchName: "新宿支店 ", fax: "  " })).toBeNull();
  });
  it("★他の人が別の欄を直した後でも、触っていない欄は送らない(古い値で上書きしない)", () => {
    const newer: AgentDetail = { ...agent, address: "東京都新宿区1-1", version: 5 };
    expect(agentEditPatch(newer, { note: "要注意" })).toEqual({ note: "要注意" });
  });
  it("商号・代表電話を空にしたら保存させない", () => {
    expect(agentEditError(agent, { companyName: "  " })).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, { phone: "" })).toBe("商号と代表電話を入れてください");
    expect(agentEditError(agent, { note: "x" })).toBeNull();
  });
  it("欄の並びに API の入力項目が全部ある", () => {
    expect(AGENT_EDIT_FIELDS.map((f) => f.key)).toEqual([
      "companyName", "companyKana", "branchName", "phone", "fax", "email", "licenseNo", "address", "note",
    ]);
  });
});

describe("ホームの件数", () => {
  it("未対応があれば目立たせ、0件は静かに出す(消さない=受付の窓の入口でもある)", () => {
    expect(homeInquiryChips({ open: 3, upcomingViewings: 0 })).toEqual([
      { key: "open", label: "未対応の反響", count: 3, tone: "alert" },
      { key: "viewings", label: "今日・明日の内見", count: 0, tone: "quiet" },
    ]);
    expect(homeInquiryChips({ open: 0, upcomingViewings: 2 })[1].tone).toBe("info");
  });
});

describe("窓の名前", () => {
  it("名前が空の窓だけ名乗る(受付の窓として開いた窓をメイン画面と呼ばない)", () => {
    expect(windowNameFor("", MAIN_WINDOW_NAME)).toBe("pm-main");
    expect(windowNameFor("pm-inquiry-desk", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("pm-main", MAIN_WINDOW_NAME)).toBeNull();
    expect(windowNameFor("", DESK_WINDOW_NAME)).toBe("pm-inquiry-desk");
  });
});
