import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";
import { dmExclusionCountsText } from "@/lib/dm-batch/exclusion-notice";

/**
 * 業者(名簿・国交省の一覧)と同じ名前の所有者には DM を送らない(2026-11-09 発注者指示)。
 * DM を出す道は3つ(宛名CSV・売却DM・物件住所宛CSV)あり、1本でも呼び忘れると業者へ手紙が出る。
 * 拒否・宛先不明の除外(dm-terminal-exclusion-wiring.test.ts)と同じく、書き方で全経路を守る。
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

// 業者名の判定を通る道。terminal-exclusion.ts(findTerminalExclusions)経由か、直接 findOwnerNameExclusions。
// 2026-11-11: 名前に謄本の外字(私用領域の字)がある所有者も同じ SQL・同じ道で外す。
const VIA_TERMINAL = [
  "src/app/api/properties/dm-batches/route.ts",
  "src/app/api/properties/sale-dm/campaigns/route.ts",
  "src/app/api/properties/sale-dm/campaigns/[id]/route.ts",
  "src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts",
  "src/app/api/properties/sale-dm/campaigns/[id]/export/route.ts",
  "src/app/api/properties/sale-dm/drafts/confirm/route.ts",
  "src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts",
];
const DIRECT = [
  "src/app/api/properties/dm-batches/[id]/csv/route.ts",
  "src/app/api/properties/property-dm-export/route.ts",
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("業者と同じ名前の除外の配線", () => {
  it("terminal-exclusion.ts が業者名の照会を必ず含める", () => {
    const src = read("src/lib/dm-batch/terminal-exclusion.ts");
    expect(src).toContain("const byName = await findOwnerNameExclusions(tx, owners);");
    expect(src).toContain("sets.agentOwnerIds = byName.agentOwnerIds;");
    expect(src).toContain("sets.gaijiOwnerIds = byName.gaijiOwnerIds;");
    expect(src).toMatch(/if \(item\.ownerIds\.some\(\(id\) => sets\.agentOwnerIds\.has\(id\)\)\) return "agent_name";/);
    expect(src).toMatch(/if \(item\.ownerIds\.some\(\(id\) => sets\.gaijiOwnerIds\?\.has\(id\)\)\) return "gaiji_name";/);
  });
  it.each(VIA_TERMINAL)("%s は findTerminalExclusions を通る", (p) => {
    expect(read(p)).toContain("findTerminalExclusions(");
  });
  it.each(DIRECT)("%s は findOwnerNameExclusions を直接呼び、外字の名前も外す", (p) => {
    const src = read(p);
    expect(src).toContain("await findOwnerNameExclusions(");
    expect(src).toContain("gaijiOwnerIds");
  });
  it.each(["src/app/api/properties/dm-batches/route.ts", "src/app/api/properties/sale-dm/campaigns/route.ts", "src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts"])(
    "%s は外字の名前で外した件数を数える",
    (p) => {
      expect(read(p)).toContain('=== "gaiji_name"');
    },
  );
  it("DM の宛先を出す route は上の一覧で全部(新しい道を足したらここに足す)", () => {
    const apiDir = join(process.cwd(), "src/app/api");
    const routes = walk(apiDir)
      .map((p) => p.split("\\").join("/").replace(/^.*?src\/app\/api/, "src/app/api"))
      .filter((p) => /\/route\.ts$/.test(p))
      .filter((p) => {
        const s = read(p);
        return /dmExportBatchItem\.createMany|dmRecipientDraft\.create\(|PROPERTY_DM_EXPORT_HEADERS|renderLetterSheetHtml\(/.test(s);
      });
    for (const r of routes) expect([...VIA_TERMINAL, ...DIRECT]).toContain(r);
  });
});

describe("件数は理由ごとに残す", () => {
  it("監査の detail に業者名で外した件数が残る(件数のみ・[REDACTED] にしない)", () => {
    for (const action of ["dm_batch_create", "sale_dm_campaign_create", "sale_dm_campaign_print", "property_address_dm_csv_export"]) {
      // ⚠鍵に "Name" を含めると個人情報として伏せられる → excludedAgent
      expect(sanitizeAuditDetail(action, { excludedAgent: 2 })).toMatchObject({ excludedAgent: 2 });
      // 外字の名前で外した件数(2026-11-11)
      expect(sanitizeAuditDetail(action, { excludedGaiji: 3 })).toMatchObject({ excludedGaiji: 3 });
    }
  });
  it("お知らせの文は理由ごと・0件の理由は書かない", () => {
    expect(dmExclusionCountsText(0, 0)).toBeNull();
    expect(dmExclusionCountsText(2, 0)).toBe("拒否・宛先不明の反響が付いた 2 件");
    expect(dmExclusionCountsText(0, 1)).toBe("所有者が業者と同じ名前の 1 件");
    expect(dmExclusionCountsText(2, 1)).toBe("拒否・宛先不明の反響が付いた 2 件と、所有者が業者と同じ名前の 1 件");
    expect(dmExclusionCountsText(0, 0, 1)).toBe("所有者の名前に読めない字(外字)がある 1 件");
    expect(dmExclusionCountsText(1, 0, 2)).toBe("拒否・宛先不明の反響が付いた 1 件と、所有者の名前に読めない字(外字)がある 2 件");
    expect(dmExclusionCountsText(0, 0, 0)).toBeNull();
  });
});
