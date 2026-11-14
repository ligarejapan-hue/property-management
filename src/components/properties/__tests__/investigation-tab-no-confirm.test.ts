import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUALITY_RULES } from "@/lib/quality-check-rules";

const tab = readFileSync(join(process.cwd(), "src/components/properties/investigation-tab.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("調査情報の確認済みボタンを無くす(2026-11-14 発注者「自動取得をするので確認済みボタンは不要」)", () => {
  it("調査情報タブに「確認済みにする」を出さない", () => {
    expect(tab).not.toContain("確認済みにする");
    expect(tab).not.toContain("handleConfirm");
    expect(tab).not.toContain("confirmPropertyInvestigation");
  });

  it("取得できた状態は「要確認」でなく「取得済み」と出す", () => {
    expect(tab).toMatch(/needs_review:\s*\{\s*label:\s*"取得済み"/);
  });

  it("編集は確認済みの行でもできる(確認済みで編集を隠さない)", () => {
    expect(tab).not.toContain("!isConfirmed && !editMode && investigation");
  });

  it("品質チェックに「調査情報が未確認」の決まりを持たない", () => {
    expect(QUALITY_RULES.map((r) => r.code)).not.toContain("INVESTIGATION_NOT_CONFIRMED");
  });
});

describe("取得のあと物件の画面を読み直す(@codex #725・物件の欄に写すと版が上がるため)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"), "utf8");
  it("調査情報タブは取得に成功したら onFetched を呼ぶ", () => {
    expect(tab).toMatch(/onFetched\?: \(\) => unknown/);
    expect(tab).toMatch(/setInvestigation\(data\);\s*\n\s*void onFetched\?\.\(\);/);
  });
  it("物件の画面は onFetched に静かな読み直しを渡す", () => {
    expect(page).toContain("<InvestigationTab propertyId={property.id} onFetched={refreshPropertyQuietly} />");
  });
});
