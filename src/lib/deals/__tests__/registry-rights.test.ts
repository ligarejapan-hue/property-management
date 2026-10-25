import { describe, expect, it } from "vitest";
import type { RegistryRightsSummary } from "@/lib/registry-strike";
import { registryDocInfo, registryRightsView, type DealRegistryState } from "../registry-rights";

const summary = (p: Partial<RegistryRightsSummary> = {}): RegistryRightsSummary => ({
  underlineDetected: true, hasKouku: true, hasOtsuku: true, currentOwners: [{ name: "架空 一郎", address: "架空県架空市1-1", share: null }],
  ownersConfirmed: true,
  activeRights: [{ rank: "2", purpose: "抵当権設定", amount: "金3,000万円", holder: "架空銀行", debtor: "架空 一郎", activeAnnotations: 0 }],
  cautions: [{ section: "甲区", rank: "3", purpose: "差押" }],
  cancelled: { kouku: 1, otsuku: 1 }, titleHasStruck: false, notes: ["4番の付記は目で確かめてください"], ...p,
});
const ok = (s: RegistryRightsSummary): DealRegistryState => ({ status: "ok", attachmentCreatedAt: "2026-10-01T00:00:00.000Z", summary: s });

describe("謄本の登記の現況(段5c-2)", () => {
  it("画面用: 残っている権利・注意・注記。権利者名は見られる人だけ・債務者や所有者は出さない", () => {
    const v = registryRightsView(ok(summary()), { showNames: true });
    expect(v).toEqual({
      status: "ok", attachmentCreatedAt: "2026-10-01T00:00:00.000Z",
      activeRights: [{ rank: "2", purpose: "抵当権設定", amount: "金3,000万円", holder: "架空銀行" }],
      cautions: [{ section: "甲区", rank: "3", purpose: "差押" }], notes: ["4番の付記は目で確かめてください"],
    });
    const hidden = registryRightsView(ok(summary()), { showNames: false });
    expect(hidden.status === "ok" && hidden.activeRights[0].holder).toBeNull();
    expect(JSON.stringify(registryRightsView(ok(summary()), { showNames: true }))).not.toContain("架空 一郎");
  });

  it("物件が無い・全部事項が無い / 判定できない", () => {
    expect(registryRightsView({ status: "none" }, { showNames: true })).toEqual({ status: "none" });
    expect(registryRightsView({ status: "unreadable" }, { showNames: true })).toEqual({ status: "unreadable" });
    // 甲区を読めない謄本は判定できない扱い
    expect(registryRightsView(ok(summary({ hasKouku: false })), { showNames: true })).toEqual({ status: "unreadable" });
  });

  it("書類確認書用: 権利の件数・注意の行(名前なし)・判定できないときの一言", () => {
    expect(registryDocInfo(ok(summary()))).toEqual({
      activeRights: 1, caution: "甲区 3番 差押が残っています。/ 4番の付記は目で確かめてください",
    });
    expect(registryDocInfo(ok(summary({ activeRights: [], cautions: [], notes: [] })))).toEqual({ activeRights: 0, caution: null });
    expect(registryDocInfo({ status: "unreadable" })).toEqual({ activeRights: 0, caution: "謄本を確認してください(登記の現況を判定できませんでした)" });
    expect(registryDocInfo({ status: "none" })).toEqual({ activeRights: 0, caution: null });
  });
});
