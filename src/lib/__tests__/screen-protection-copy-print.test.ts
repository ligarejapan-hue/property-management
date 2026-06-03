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
  resolveProtectedSurfaceForNode,
  resolveProtectedSurfaceForRanges,
  type DomNodeLike,
  type DomRangeLike,
  type DomElementLike,
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

  it("[data-pii-protected] 限定・入力/ボタン/リンク等を除外（helper に委譲）", () => {
    expect(guardSrc).toMatch(/\[data-pii-protected\]/);
    expect(guardSrc).toMatch(/input, textarea, select, button, a/);
    expect(guardSrc).toMatch(/resolveProtectedSurfaceForNode/);
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

describe("S1b-3: PII マーカ付与（実レンダリング面）", () => {
  // 17-A: source-assertion は「実際に描画される画面」を対象にする。
  // 未配線の dead code（owner-detail-panel.tsx）だけを見て安心しないこと。
  it("実画面で表示される所有者 PII 面に owner surface を付与（物件一覧 / 管理 Owner 詳細）", () => {
    // 物件一覧の所有者名セル（17-A 追加）
    expect(read("src/app/(dashboard)/properties/page.tsx")).toMatch(
      /data-pii-protected data-pii-surface="owner"/,
    );
    // 管理 Owner 詳細（masked 値でも owner surface として扱う・17-A 追加）
    expect(read("src/app/(dashboard)/admin/owners/[id]/page.tsx")).toMatch(
      /data-pii-protected[\s\S]*?data-pii-surface="owner"/,
    );
  });

  it("物件詳細 / 取得履歴 / インポートの PII 面に surface を付与", () => {
    expect(read("src/app/(dashboard)/properties/[id]/page.tsx")).toMatch(
      /data-pii-protected data-pii-surface="property"/,
    );
    expect(read("src/components/properties/history-tab.tsx")).toMatch(
      /data-pii-protected data-pii-surface="history"/,
    );
    expect(read("src/app/(dashboard)/import/page.tsx")).toMatch(
      /data-pii-protected data-pii-surface="import"/,
    );
  });

  // 17-A / Codex P1: registry PDF preview は iframe 内 PDF viewer の copy/contextmenu を
  // 親 document の listener で捕捉できないため、外側 wrapper に registry marker は付けない
  // （byte access は S1b-4 server-side gate で保護済み・viewer 化は別 PR で検討）。
  it("registry preview の外側 wrapper には registry marker を付けない（iframe 捕捉不可・別PR）", () => {
    const attach = read("src/components/properties/attachment-tab.tsx");
    expect(attach).not.toMatch(/data-pii-surface=\{isRegistry/);
    expect(attach).not.toMatch(/data-pii-surface="registry"/);
  });

  it("再利用候補 owner-detail-panel.tsx は marker を保持するが未配線（dead code）であることを明示", () => {
    // 削除はしない。ただし live 面の担保は上記テストで別途保証する。
    const panel = read("src/components/owners/owner-detail-panel.tsx");
    expect(panel).toMatch(/data-pii-protected[\s\S]*?data-pii-surface="owner"/);
    // 未配線である旨のコメントが残っていること（dead code を live と誤認させない）。
    expect(panel).toMatch(/未配線/);
  });

  it("16-B B3 の import/jobs/[jobId]/page には付与しない（非衝突）", () => {
    const b3 = read("src/app/(dashboard)/import/jobs/[jobId]/page.tsx");
    expect(b3).not.toMatch(/data-pii-protected/);
  });
});

// ============================================================
// Codex P1: copy/cut の selection-aware 判定（DOM をモックして node 環境で検証）
// ============================================================
describe("Codex P1: resolveProtectedSurface（selection-aware）", () => {
  const OPTS = {
    piiSelector: "[data-pii-protected]",
    exemptSelector:
      "input, textarea, select, button, a, [contenteditable], [contenteditable='true']",
    surfaceAttr: "data-pii-surface",
  };

  type Fake = {
    nodeType: number;
    parentElement: Fake | null;
    getAttribute(name: string): string | null;
    closest(selector: string): Fake | null;
  };
  const asNode = (f: Fake) => f as unknown as DomNodeLike;

  function region(surface: string): Fake {
    const r: Fake = {
      nodeType: 1,
      parentElement: null,
      getAttribute: (n) => (n === "data-pii-surface" ? surface : null),
      closest: (sel) => (sel.includes("data-pii-protected") ? r : null),
    };
    return r;
  }
  function child(r: Fake): Fake {
    return {
      nodeType: 1,
      parentElement: r,
      getAttribute: () => null,
      closest: (sel) => (sel.includes("data-pii-protected") ? r : null),
    };
  }
  // 保護領域内の操作系要素（例: <a>）。closest(exempt) は自身を返す。
  function exemptChild(r: Fake): Fake {
    const el: Fake = {
      nodeType: 1,
      parentElement: r,
      getAttribute: () => null,
      closest: (sel) => (sel.includes("data-pii-protected") ? r : el),
    };
    return el;
  }
  function text(parent: Fake | null): Fake {
    return {
      nodeType: 3,
      parentElement: parent,
      getAttribute: () => null,
      closest: () => null,
    };
  }
  function outside(): Fake {
    return {
      nodeType: 1,
      parentElement: null,
      getAttribute: () => null,
      closest: () => null,
    };
  }
  const asEl = (f: Fake) => f as unknown as DomElementLike;
  const range = (
    common: Fake,
    start: Fake,
    end: Fake,
    intersects: Fake[] = [],
  ): DomRangeLike =>
    ({
      commonAncestorContainer: common,
      startContainer: start,
      endContainer: end,
      intersectsNode: (node: unknown) => intersects.includes(node as Fake),
    }) as unknown as DomRangeLike;

  it("保護領域内の要素 → surface を返す", () => {
    expect(resolveProtectedSurfaceForNode(asNode(child(region("owner"))), OPTS)).toBe(
      "owner",
    );
  });

  it("text node でも parentElement から保護領域を検出（commonAncestor が text node）", () => {
    const t = text(child(region("property")));
    expect(resolveProtectedSurfaceForNode(asNode(t), OPTS)).toBe("property");
  });

  it("操作系要素(input/textarea/a/contenteditable)内は除外（null）", () => {
    expect(
      resolveProtectedSurfaceForNode(asNode(exemptChild(region("owner"))), OPTS),
    ).toBeNull();
  });

  it("保護領域外（body）は null", () => {
    expect(resolveProtectedSurfaceForNode(asNode(outside()), OPTS)).toBeNull();
  });

  it("target が body でも startContainer が保護領域内なら検出（Codex P1 抜け道）", () => {
    const r = region("owner");
    expect(
      resolveProtectedSurfaceForRanges(
        [range(outside(), text(child(r)), outside())],
        [],
        OPTS,
      ),
    ).toBe("owner");
  });

  it("endContainer が保護領域内でも検出", () => {
    const r = region("history");
    expect(
      resolveProtectedSurfaceForRanges(
        [range(outside(), outside(), text(child(r)))],
        [],
        OPTS,
      ),
    ).toBe("history");
  });

  it("commonAncestorContainer が保護領域内でも検出", () => {
    const r = region("import");
    expect(
      resolveProtectedSurfaceForRanges(
        [range(child(r), outside(), outside())],
        [],
        OPTS,
      ),
    ).toBe("import");
  });

  it("いずれも保護領域外なら null（非protected領域の copy は抑止しない）", () => {
    expect(
      resolveProtectedSurfaceForRanges(
        [range(outside(), outside(), outside())],
        [],
        OPTS,
      ),
    ).toBeNull();
  });

  it("選択が操作系要素(editable)内なら除外（null）", () => {
    const r = region("owner");
    const e = exemptChild(r);
    expect(
      resolveProtectedSurfaceForRanges([range(e, e, e)], [], OPTS),
    ).toBeNull();
  });

  // ---- Codex P2: panel をまたぐ mixed selection を intersectsNode で検知 ----

  it("Codex P2: start/end/commonAncestor が全て保護領域外でも range が panel と交差すれば surface を検出", () => {
    const panel = region("owner");
    // panel の前(outside)で選択開始・後(outside)で終了。各 container は保護領域外だが panel と交差。
    const r = range(outside(), outside(), outside(), [panel]);
    expect(resolveProtectedSurfaceForRanges([r], [asEl(panel)], OPTS)).toBe(
      "owner",
    );
  });

  it("Codex P2: どの panel とも交差しない選択は null（非protected は抑止しない）", () => {
    const panel = region("property");
    const r = range(outside(), outside(), outside(), []);
    expect(
      resolveProtectedSurfaceForRanges([r], [asEl(panel)], OPTS),
    ).toBeNull();
  });

  it("Codex P2: 選択全体が editable 内なら intersect しても除外（editable 除外維持）", () => {
    const panel = region("owner");
    const e = exemptChild(panel);
    // commonAncestor が editable(<a>)配下 → intersect しても抑止しない。
    const r = range(e, e, e, [panel]);
    expect(
      resolveProtectedSurfaceForRanges([r], [asEl(panel)], OPTS),
    ).toBeNull();
  });
});

describe("Codex P1: guard / helper の selection 配線（source-assertion）", () => {
  const guardSrc = read(
    "src/components/screen-protection/screen-protection-guard.tsx",
  );
  const helperSrc = read("src/lib/screen-protection.ts");

  it("guard: copy/cut で getSelection を確認し selection fallback を使う", () => {
    expect(guardSrc).toMatch(/document\.getSelection\(\)/);
    expect(guardSrc).toMatch(
      /surfaceFromTarget\(e\.target\) \?\? surfaceFromSelection\(\)/,
    );
    expect(guardSrc).toMatch(/resolveProtectedSurfaceForRanges/);
  });

  it("guard: contextmenu は従来どおり target 判定（selection を使わない）", () => {
    expect(guardSrc).toMatch(/onContextMenu[\s\S]*surfaceFromTarget\(e\.target\)/);
  });

  it("helper: range の 3 container を辿る", () => {
    expect(helperSrc).toMatch(/commonAncestorContainer/);
    expect(helperSrc).toMatch(/startContainer/);
    expect(helperSrc).toMatch(/endContainer/);
  });

  it("Codex P2: guard は querySelectorAll で protected 要素を集め、helper は intersectsNode で交差判定", () => {
    expect(guardSrc).toMatch(/querySelectorAll\(PII_REGION_SELECTOR\)/);
    expect(guardSrc).toMatch(
      /resolveProtectedSurfaceForRanges\([\s\S]*protectedEls/,
    );
    expect(helperSrc).toMatch(/intersectsNode/);
  });

  it("guard は選択テキストを文字列化して送らない（PII を監査に入れない）", () => {
    expect(guardSrc).not.toMatch(/toString/);
    expect(guardSrc).not.toMatch(/selectedText/);
  });
});
