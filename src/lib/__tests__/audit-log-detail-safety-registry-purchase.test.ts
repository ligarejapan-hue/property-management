/**
 * 段階②(2026-07-31): 有料謄本取得の台帳 AuditLog(registry_location_purchase) の表示規則。
 *
 * ⚠この detail は**二重課金ガードの正**。purchaseKeyHash が sanitizer に伏せられても
 * DB には残る(ガード自体は壊れない)が、管理画面で「なぜ409になるのか」を追えなくなる。
 * 逆に、地番そのもの(秘匿情報)は detail に**最初から入れない**契約=混入しても伏せる。
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeAuditDetail,
  REDACTED,
} from "@/lib/audit-log-detail-safety";

const ACTION = "registry_location_purchase";

describe("有料謄本取得の台帳(registry_location_purchase)", () => {
  it("purchaseKeyHash と outcome は管理画面で読める", () => {
    const out = sanitizeAuditDetail(ACTION, {
      purchaseKeyHash: "ab12cd34ef56ab12cd34ef56ab12cd34",
      outcome: "succeeded",
    }) as Record<string, unknown>;
    expect(out.purchaseKeyHash).toBe("ab12cd34ef56ab12cd34ef56ab12cd34");
    expect(out.outcome).toBe("succeeded");
  });

  it("charged_but_failed の outcome も読める(課金済み失敗の追跡)", () => {
    const out = sanitizeAuditDetail(ACTION, {
      purchaseKeyHash: "x",
      outcome: "charged_but_failed",
    }) as Record<string, unknown>;
    expect(out.outcome).toBe("charged_but_failed");
  });

  it("⚠同じ action でも地番・所在らしきキーが混入したら伏せる", () => {
    const out = sanitizeAuditDetail(ACTION, {
      purchaseKeyHash: "x",
      lotNumber: "1-1",
      address: "千代田区丸の内一丁目",
      ownerName: "山田太郎",
    }) as Record<string, unknown>;
    expect(out.purchaseKeyHash).toBe("x");
    expect(out.lotNumber).toBe(REDACTED);
    expect(out.address).toBe(REDACTED);
    expect(out.ownerName).toBe(REDACTED);
  });

  it("他の action では purchaseKeyHash は保持されない(allowlist は action 限定)", () => {
    const out = sanitizeAuditDetail("some_other_action", {
      purchaseKeyHash: "x",
    }) as Record<string, unknown>;
    expect(out.purchaseKeyHash).toBe(REDACTED);
  });
});
