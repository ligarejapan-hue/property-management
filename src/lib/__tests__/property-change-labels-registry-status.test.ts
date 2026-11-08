/**
 * 変更履歴・経緯の登記状況を画面と同じ言葉で出す(2026-11-06)。
 * 謄本の添付で自動で取得済になると「登記状況を変更」の行が増えるので、英字の値(unconfirmed → obtained)を出さない。
 */
import { describe, it, expect } from "vitest";
import { propertyHistoryValue } from "@/lib/property-change-labels";

describe("propertyHistoryValue(登記状況)", () => {
  it("★未取得・取得中・取得済で出す", () => {
    expect(propertyHistoryValue("registryStatus", "unconfirmed")).toBe("未取得");
    expect(propertyHistoryValue("registryStatus", "scheduled")).toBe("取得中");
    expect(propertyHistoryValue("registryStatus", "obtained")).toBe("取得済");
  });

  it("知らない値・空は手を付けない(null=呼び出し側の既定の出し方)", () => {
    expect(propertyHistoryValue("registryStatus", "something")).toBeNull();
    expect(propertyHistoryValue("registryStatus", null)).toBeNull();
  });
});

describe("propertyHistoryValue(DM判断・2026-11-08)", () => {
  it("★送付可・未判断・送付不可で出す(send → hold と英字で出さない)", () => {
    expect(propertyHistoryValue("dmStatus", "send")).toBe("送付可");
    expect(propertyHistoryValue("dmStatus", "hold")).toBe("未判断");
    expect(propertyHistoryValue("dmStatus", "no_send")).toBe("送付不可");
  });

  it("知らない値・空は手を付けない", () => {
    expect(propertyHistoryValue("dmStatus", "toString")).toBeNull();
    expect(propertyHistoryValue("dmStatus", null)).toBeNull();
  });
});
