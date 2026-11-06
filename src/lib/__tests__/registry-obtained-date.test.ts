import { describe, it, expect } from "vitest";
import { latestRegistryObtainedAt, registryObtainedDateLabel } from "@/lib/registry-obtained-date";

describe("latestRegistryObtainedAt", () => {
  it("★添付と取得の成功のうち、いちばん新しい日時", () => {
    const attach = new Date("2026-10-01T03:00:00Z");
    const fetched = new Date("2026-11-05T01:00:00Z");
    expect(latestRegistryObtainedAt([attach, fetched])).toEqual(fetched);
    expect(latestRegistryObtainedAt([fetched, attach])).toEqual(fetched);
  });

  it("片方だけでも、その日時", () => {
    const attach = new Date("2026-10-01T03:00:00Z");
    expect(latestRegistryObtainedAt([attach, null])).toEqual(attach);
    expect(latestRegistryObtainedAt([undefined, attach])).toEqual(attach);
  });

  it("★どちらも無ければ null", () => {
    expect(latestRegistryObtainedAt([null, undefined])).toBeNull();
    expect(latestRegistryObtainedAt([])).toBeNull();
  });
});

describe("registryObtainedDateLabel", () => {
  it("★日本時間の日付で出す(UTC では前の日でも)", () => {
    expect(registryObtainedDateLabel("obtained", "2026-11-05T15:30:00.000Z")).toBe("取得日 2026/11/06");
    expect(registryObtainedDateLabel("obtained", "2026-01-02T00:00:00.000Z")).toBe("取得日 2026/01/02");
  });

  it("★日時が無い(手で取得済にしただけ)なら出さない", () => {
    expect(registryObtainedDateLabel("obtained", null)).toBeNull();
    expect(registryObtainedDateLabel("obtained", undefined)).toBeNull();
    expect(registryObtainedDateLabel("obtained", "not-a-date")).toBeNull();
  });

  it("取得済でなければ出さない", () => {
    expect(registryObtainedDateLabel("unconfirmed", "2026-11-05T15:30:00.000Z")).toBeNull();
    expect(registryObtainedDateLabel("scheduled", "2026-11-05T15:30:00.000Z")).toBeNull();
  });
});
