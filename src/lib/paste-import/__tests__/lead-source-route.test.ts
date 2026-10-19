import { describe, it, expect } from "vitest";
import { introductionRouteForLeadSource } from "../lead-source-route";
import { INTRODUCTION_ROUTE_LABELS, INTRODUCTION_ROUTE_VALUES, normalizeIntroductionRouteInput } from "@/lib/property-types";

// 導入ルート「一括査定」(発注者依頼 2026-10-19)。査定サイト(HOME4U・タカウル等)から来た反響を
// 「Web問い合わせ」と分けて絞り込めるようにする。
describe("導入ルート「一括査定」", () => {
  it("選択肢にあり、表示は「一括査定」・Web問い合わせの次", () => {
    expect(INTRODUCTION_ROUTE_LABELS.bulk_assessment).toBe("一括査定");
    const i = INTRODUCTION_ROUTE_VALUES.indexOf("bulk_assessment");
    expect(INTRODUCTION_ROUTE_VALUES[i - 1]).toBe("web_inquiry");
  });
  it("CSV で「一括査定」と書けば読み取る", () => {
    expect(normalizeIntroductionRouteInput("一括査定")).toBe("bulk_assessment");
  });
});

describe("取り込みの入口ごとの導入ルート", () => {
  it.each(["excel_lead", "home4u_assessment", "home4u_vacant_house", "takauru_assessment"])(
    "%s → 一括査定", (src) => {
      expect(introductionRouteForLeadSource(src)).toBe("bulk_assessment");
    },
  );
  it.each([undefined, null, "generic", "unknown_xyz", 1, {}])(
    "%s(どこから来たか分からない)→ 今までどおり Web問い合わせ", (src) => {
      expect(introductionRouteForLeadSource(src)).toBe("web_inquiry");
    },
  );
});
