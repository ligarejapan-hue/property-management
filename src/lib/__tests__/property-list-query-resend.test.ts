import { describe, it, expect } from "vitest";
import type { ResendCandidateWhereFragment } from "@/lib/dm-resend/candidacy";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。
const adminSession = { id: "u1", role: "admin" } as never;

describe("buildPropertyListWhere resendOnly filter", () => {
  it("resendOnly=1 で §4 の5条件を where.AND に足す", async () => {
    const query = propertyListQuerySchema.parse({ resendOnly: "1" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as ResendCandidateWhereFragment[];
    expect(and).toContainEqual({ dmStatus: "send" });
    expect(and).toContainEqual({ dmLogs: { some: {} } });
    expect(and.some((f) => f.dmLogs?.none?.sentAt?.gt instanceof Date)).toBe(true);
    expect(and.some((f) => f.dmLogs?.none?.reactionStatus?.in)).toBe(true);
    expect(and.some((f) => f.propertyOwners?.none?.owner?.OR)).toBe(true);
  });

  it("resendOnly 未指定なら候補条件を足さない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as ResendCandidateWhereFragment[];
    expect(and.some((f) => f.dmLogs?.some !== undefined)).toBe(false);
    expect(and.some((f) => f.propertyOwners?.none !== undefined)).toBe(false);
  });

  it("dmStatus=hold を併用しても dmStatus=send の強制は残る(候補に入る側へは倒さない)", async () => {
    const query = propertyListQuerySchema.parse({
      resendOnly: "1",
      dmStatus: "hold",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmStatus).toBe("hold");
    expect((where.AND ?? []) as unknown[]).toContainEqual({ dmStatus: "send" });
  });

  it("既存の絞り込み(未送信0回)と併用しても両方残る", async () => {
    const query = propertyListQuerySchema.parse({
      resendOnly: "1",
      dmSentMax: "0",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    const and = (where.AND ?? []) as ResendCandidateWhereFragment[];
    expect(and).toContainEqual({ dmLogs: { none: {} } });
    expect(and).toContainEqual({ dmLogs: { some: {} } });
  });
});
