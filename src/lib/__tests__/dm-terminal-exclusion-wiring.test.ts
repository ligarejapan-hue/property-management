import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sanitizeAuditDetail } from "@/lib/audit-log-detail-safety";

/**
 * 拒否・宛先不明(terminal 反響)の除外が **A(宛名CSV)と B(売却DM)の両方に同じ実装で**
 * 入っていることを、ソース走査で担保する。
 *
 * ⚠なぜ走査型か: 2026-08-16 の穴は「A には入れたが B に入れなかった」という
 * **呼び出し漏れ**だった([[fix-all-call-sites-not-one]])。個々の route の挙動テストは
 * それぞれのファイルにあるが、「条件が 1 か所にしか書かれていない」ことと
 * 「両方の書き込み経路が同じ部品を呼ぶ」ことは、書き方でしか守れない。
 */
const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const CAMPAIGNS = read("src/app/api/properties/sale-dm/campaigns/route.ts");
const BATCHES = read("src/app/api/properties/dm-batches/route.ts");

/** src 配下の .ts/.tsx を列挙(テストと生成物は除く)。 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("terminal 除外の実装は 1 本だけ", () => {
  it('⚠literal の対 ["refused", "undeliverable"] を1行で書く場所はゼロ(集合の正本は dm-reaction/core.ts)', () => {
    const offenders = walk(join(process.cwd(), "src"))
      .filter((p) => readFileSync(p, "utf8").includes('"refused", "undeliverable"'))
      .map((p) => p.split("\\").join("/"));
    // 条件を 2 か所に書くと、直すとき片方だけ直して必ずずれる(2026-08-16 の穴の型)。
    expect(offenders).toEqual([]);
  });

  it("A(宛名CSV)と B(売却DM)の両方が共有部品を import している", () => {
    for (const src of [CAMPAIGNS, BATCHES]) {
      expect(src).toContain('from "@/lib/dm-batch/terminal-exclusion"');
      expect(src).toContain("findTerminalExclusions(");
      expect(src).toContain("isTerminalExcluded(");
    }
  });
});

describe("B(売却DM)での置き場所", () => {
  it("⚠除外は Owner FOR SHARE 取得の後・宛先保存(variant 作成)の前", () => {
    const lock = CAMPAIGNS.indexOf("lockOwnersForShare(");
    const excl = CAMPAIGNS.indexOf("findTerminalExclusions(");
    const variant = CAMPAIGNS.indexOf("tx.dmVariant.create(");
    expect(lock).toBeGreaterThan(-1);
    expect(excl).toBeGreaterThan(lock); // ロック保持中=terminal writer と直列化
    expect(variant).toBeGreaterThan(excl); // 保存前に外す(作ってから消すのではない)
  });

  it("全宛先が除外なら空キャンペーンを作らず ALL_EXCLUDED_TERMINAL で止める", () => {
    expect(CAMPAIGNS).toContain('"ALL_EXCLUDED_TERMINAL"');
    const allExcluded = CAMPAIGNS.indexOf("ALL_EXCLUDED_TERMINAL");
    expect(allExcluded).toBeLessThan(CAMPAIGNS.indexOf("tx.dmVariant.create("));
  });

  it("除外件数を応答と監査の両方に載せる(黙って外さない)", () => {
    expect(CAMPAIGNS).toMatch(/excludedTerminal: excludedTerminalCount/);
    // 応答と監査 detail の 2 か所
    expect((CAMPAIGNS.match(/excludedTerminal: excludedTerminalCount/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("A(宛名CSV)は共有化後も同じ規則のまま", () => {
  it("除外はロック取得の後・控え(dmExportBatch)保存の前", () => {
    const lock = BATCHES.indexOf("lockOwnersForShare(");
    const excl = BATCHES.indexOf("findTerminalExclusions(");
    const save = BATCHES.indexOf("dmExportBatch.create(");
    expect(lock).toBeGreaterThan(-1);
    expect(excl).toBeGreaterThan(lock);
    expect(save).toBeGreaterThan(excl);
  });
});

describe("監査 allowlist", () => {
  it("sale_dm_campaign_create の detail に excludedTerminal が通る(実物で検証)", () => {
    const out = sanitizeAuditDetail("sale_dm_campaign_create", {
      campaignId: "c1",
      excludedTerminal: 3,
    }) as Record<string, unknown>;
    expect(out.excludedTerminal).toBe(3);
  });
});

describe("terminal 集合の定義は 1 か所(dm-reaction/core.ts)", () => {
  it("⚠export const TERMINAL_REACTION* の定義ファイルは core.ts だけ", () => {
    // 提出前レビューで発見: 新設した terminal-exclusion.ts が 2 つ目の定義になっていた。
    // 単一行リテラルの走査は複数行定義を素通りするため、名前の定義そのものを数える。
    const defs = walk(join(process.cwd(), "src"))
      .filter((p) => /export const TERMINAL_REACTION/.test(readFileSync(p, "utf8")))
      .map((p) => p.split("\\").join("/"));
    // 正本(core.ts)は必ず存在する。
    expect(defs.some((p) => p.endsWith("src/lib/dm-reaction/core.ts"))).toBe(true);
    // core 以外で TERMINAL_REACTION* を export するファイル(例: dm-resend/candidacy.ts の
    // TERMINAL_REACTION_VALUES)は、必ず core から import した Set の**派生**であること。
    // 独立した2つ目の定義(値の直書き)は許さない。
    for (const p of defs) {
      if (p.endsWith("src/lib/dm-reaction/core.ts")) continue;
      const src = readFileSync(p, "utf8");
      expect(src, `${p} は core から派生していない独立定義`).toContain('from "@/lib/dm-reaction/core"');
    }
  });

  it("除外側(terminal-exclusion.ts)は集合を自前で持たず core を参照する", () => {
    const lib = read("src/lib/dm-batch/terminal-exclusion.ts");
    expect(lib).toContain('from "@/lib/dm-reaction/core"');
    expect(lib).not.toContain('"refused"');
  });
});

describe("出力境界(確定・印刷・送付済み)にも同じ関所がある(@codex #384 R1 P1)", () => {
  const CONFIRM = read("src/app/api/properties/sale-dm/drafts/confirm/route.ts");
  const PRINT = read("src/app/api/properties/sale-dm/campaigns/[id]/print/route.ts");
  const MARK_SENT = read("src/app/api/properties/sale-dm/drafts/[id]/mark-sent/route.ts");
  const EXPORT = read("src/app/api/properties/sale-dm/campaigns/[id]/export/route.ts");

  it("3つの route すべてが共有部品を import し、Owner ロック取得後に再評価する", () => {
    for (const src of [CONFIRM, PRINT, MARK_SENT, EXPORT]) {
      expect(src).toContain('from "@/lib/dm-batch/terminal-exclusion"');
      const lock = src.indexOf("lockOwnersForShare(");
      const excl = src.indexOf("findTerminalExclusions(");
      expect(lock).toBeGreaterThan(-1);
      expect(excl).toBeGreaterThan(lock);
    }
  });

  it("確定は検査が状態遷移(updateMany)より前・送付済みも遷移より前", () => {
    expect(CONFIRM.indexOf("findTerminalExclusions(")).toBeLessThan(
      CONFIRM.indexOf('data: { status: "confirmed"'),
    );
    expect(MARK_SENT.indexOf("findTerminalExclusions(")).toBeLessThan(
      MARK_SENT.indexOf('data: { status: "sent"'),
    );
  });

  it("⚠印刷とCSVは**実体化までロック内**(検査と出力の間に terminal writer の窓を作らない)", () => {
    // @codex #384 R2 P1: 除外判定だけ tx に入れて描画/行構築を外に出すと、
    // tx 終了〜実体化のすき間に記録された拒否が素通りする。
    expect(PRINT.indexOf("renderLetterSheetHtml(")).toBeGreaterThan(PRINT.indexOf("$transaction"));
    expect(EXPORT.indexOf("encodeCsv(")).toBeGreaterThan(EXPORT.indexOf("$transaction"));
    // 除外注記は画面専用(お客様の紙面に刷らない)。
    expect(PRINT).toContain("@media print{.pm-terminal-note{display:none");
  });

  it("印刷は除外件数を監査 detail に載せ、allowlist が通す(実物検証)", () => {
    expect(PRINT).toContain("excludedTerminal: excludedTerminalCount");
    const out = sanitizeAuditDetail("sale_dm_campaign_print", {
      campaignId: "c1",
      excludedTerminal: 2,
    }) as Record<string, unknown>;
    expect(out.excludedTerminal).toBe(2);
  });
});
