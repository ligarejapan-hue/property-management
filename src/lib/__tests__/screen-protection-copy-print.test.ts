/**
 * S1b-3: copy/cut/contextmenu/print 抑止＋client 監査。
 * 純ロジックは unit、route / guard 配線は source-assertion で検証する
 * （repo に jsdom / RTL が無いため）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  eventTypeToAuditAction,
  eventTypeToTrigger,
  buildScreenProtectionAuditDetail,
  isScreenProtectionEventType,
  isScreenProtectionSurface,
  SCREEN_PROTECTION_EVENT_TYPES,
} from "@/lib/screen-protection";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("S1b-3 helper: eventType → action / trigger", () => {
  it("action mapping（print と print_shortcut は pii_print_attempt に統合）", () => {
    expect(eventTypeToAuditAction("copy")).toBe("pii_copy_attempt");
    expect(eventTypeToAuditAction("cut")).toBe("pii_cut_attempt");
    expect(eventTypeToAuditAction("contextmenu")).toBe("pii_contextmenu_attempt");
    expect(eventTypeToAuditAction("print")).toBe("pii_print_attempt");
    expect(eventTypeToAuditAction("print_shortcut")).toBe("pii_print_attempt");
  });

  it("trigger mapping（print と print_shortcut を区別）", () => {
    expect(eventTypeToTrigger("copy")).toBe("clipboard");
    expect(eventTypeToTrigger("cut")).toBe("clipboard");
    expect(eventTypeToTrigger("contextmenu")).toBe("menu");
    expect(eventTypeToTrigger("print")).toBe("print_dialog");
    expect(eventTypeToTrigger("print_shortcut")).toBe("keyboard");
  });

  it("detail は { surface, trigger } の非PII enum のみ", () => {
    const detail = buildScreenProtectionAuditDetail("copy", "owner");
    expect(detail).toEqual({ surface: "owner", trigger: "clipboard" });
    // PII を入れる余地がない（キーは surface / trigger だけ）
    expect(Object.keys(detail).sort()).toEqual(["surface", "trigger"]);
  });

  it("enum 判定（厳格）", () => {
    expect(isScreenProtectionEventType("copy")).toBe(true);
    expect(isScreenProtectionEventType("evil")).toBe(false);
    expect(isScreenProtectionSurface("owner")).toBe(true);
    expect(isScreenProtectionSurface("/properties/abc-123")).toBe(false);
    expect(SCREEN_PROTECTION_EVENT_TYPES).toContain("print_shortcut");
  });
});

describe("S1b-3: /api/me/audit-events route 配線", () => {
  const routeSrc = read("src/app/api/me/audit-events/route.ts");

  it("POST のみ・getApiSession 必須", () => {
    expect(routeSrc).toMatch(/export async function POST/);
    expect(routeSrc).toMatch(/getApiSession\(\)/);
    expect(routeSrc).not.toMatch(/export async function GET/);
  });

  it("zod enum で eventType / surface を厳格化", () => {
    expect(routeSrc).toMatch(/z\.enum\(SCREEN_PROTECTION_EVENT_TYPES\)/);
    expect(routeSrc).toMatch(/z\.enum\(SCREEN_PROTECTION_SURFACES\)/);
  });

  it("action / trigger はサーバ側で eventType から決定（client 非信用）", () => {
    expect(routeSrc).toMatch(/eventTypeToAuditAction\(eventType\)/);
    expect(routeSrc).toMatch(/eventTypeToTrigger\(eventType\)/);
  });

  it("targetTable=screen_protection・detail は surface/trigger のみ", () => {
    expect(routeSrc).toMatch(/targetTable:\s*"screen_protection"/);
    expect(routeSrc).toMatch(/detail:\s*\{\s*surface,\s*trigger:/);
  });

  it("rate-limit 超過は 429、不正 enum は 400、成功は 204", () => {
    expect(routeSrc).toMatch(/status:\s*429/);
    expect(routeSrc).toMatch(/ApiError\(400/);
    expect(routeSrc).toMatch(/status:\s*204/);
    expect(routeSrc).toMatch(/createTokenBucketLimiter/);
  });

  it("userAgent / ipAddress / 選択テキスト / URL を記録しない（header 未取得・writeAuditLog 未渡し）", () => {
    expect(routeSrc).not.toMatch(/headers\.get\(/);
    expect(routeSrc).not.toMatch(/userAgent:/);
    expect(routeSrc).not.toMatch(/ipAddress:/);
    expect(routeSrc).not.toMatch(/selectedText/);
    expect(routeSrc).not.toMatch(/request\.url/);
  });
});

describe("S1b-3: ScreenProtectionGuard 配線", () => {
  const guardSrc = read(
    "src/components/screen-protection/screen-protection-guard.tsx",
  );

  it("copy / cut / contextmenu / beforeprint / keydown リスナを張る", () => {
    expect(guardSrc).toMatch(/addEventListener\("copy"/);
    expect(guardSrc).toMatch(/addEventListener\("cut"/);
    expect(guardSrc).toMatch(/addEventListener\("contextmenu"/);
    expect(guardSrc).toMatch(/addEventListener\("beforeprint"/);
    expect(guardSrc).toMatch(/addEventListener\("keydown"/);
  });

  it("Ctrl/Cmd+P を判定する", () => {
    expect(guardSrc).toMatch(/ctrlKey \|\| e\.metaKey/);
    expect(guardSrc).toMatch(/=== "p" \|\| e\.key === "P"/);
  });

  it("bypass=true なら抑止・監査なし（fail-safe は内部で false 開始）", () => {
    expect(guardSrc).toMatch(/if \(bypass\) return/);
    expect(guardSrc).toMatch(/useScreenProtection\(\)/);
  });

  it("[data-pii-protected] 限定・入力/ボタン/リンク等を除外", () => {
    expect(guardSrc).toMatch(/\[data-pii-protected\]/);
    expect(guardSrc).toMatch(/input, textarea, select, button, a/);
    expect(guardSrc).toMatch(/closest\(/);
  });

  it("直接 fetch を使い、api-client を import しない", () => {
    expect(guardSrc).toMatch(/fetch\(\s*["']\/api\/me\/audit-events["']/);
    expect(guardSrc).not.toMatch(/@\/lib\/api-client/);
    expect(guardSrc).not.toMatch(/from\s+["'][^"']*api-client/);
  });

  it("client throttle を入れる", () => {
    expect(guardSrc).toMatch(/SEND_THROTTLE_MS/);
  });
});

describe("S1b-3: PII マーカ付与（初期面）", () => {
  it("4 つの PII 面に data-pii-protected / data-pii-surface を付与", () => {
    expect(read("src/components/owners/owner-detail-panel.tsx")).toMatch(
      /data-pii-protected[\s\S]*data-pii-surface="owner"/,
    );
    expect(read("src/components/properties/history-tab.tsx")).toMatch(
      /data-pii-protected data-pii-surface="history"/,
    );
    expect(read("src/app/(dashboard)/import/page.tsx")).toMatch(
      /data-pii-protected data-pii-surface="import"/,
    );
    expect(read("src/app/(dashboard)/properties/[id]/page.tsx")).toMatch(
      /data-pii-protected data-pii-surface="property"/,
    );
  });

  it("16-B B3 の import/jobs/[jobId]/page には付与しない（非衝突）", () => {
    const b3 = read("src/app/(dashboard)/import/jobs/[jobId]/page.tsx");
    expect(b3).not.toMatch(/data-pii-protected/);
  });
});
