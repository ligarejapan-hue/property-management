/**
 * 監査ログ画面の「対象」欄は、コードが記録する targetTable をすべて日本語で出す。
 *
 * 背景(実機確認 2026-10-23): 操作種別は 10/22 に全部日本語にしたが、「対象」欄に
 * dm_inquiries などの英字が残っていた(TARGET_TABLE_LABELS への足し忘れ)。
 * 操作種別と同じく、ソース走査で守る。
 *
 * 走査の境界: `targetTable: "xxx"` と素の文字列で書かれた箇所だけ(変数で渡す経路は見えない)。
 * `orderBy: { targetTable: "asc" }` のような並び順の指定は対象名ではないので除く。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const PAGE = read("src/app/(dashboard)/admin/audit-logs/page.tsx");

/** 画面の TARGET_TABLE_LABELS の鍵を取り出す(純関数)。 */
export function targetTableLabelKeys(src: string): Set<string> {
  const start = src.indexOf("const TARGET_TABLE_LABELS");
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end);
  const keys = new Set<string>();
  for (const m of block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*"/gm)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

/** ソースに素の文字列で書かれた targetTable(並び順の asc/desc は除く)。 */
export function literalTargetTables(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\btargetTable:\s*"([A-Za-z0-9_.]+)"/g)) {
    if (m[1] === "asc" || m[1] === "desc") continue;
    out.push(m[1]);
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("監査ログの「対象」はすべて日本語名を持つ(ソース走査)", () => {
  const labels = targetTableLabelKeys(PAGE);

  it("TARGET_TABLE_LABELS を読めている(30個以上)", () => {
    expect(labels.size).toBeGreaterThan(30);
  });

  it("コードが素の文字列で記録する targetTable は、すべて TARGET_TABLE_LABELS にある", () => {
    const missing = new Map<string, string[]>();
    for (const file of walk(join(ROOT, "src"))) {
      const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (!/targetTable:/.test(src)) continue;
      for (const t of literalTargetTables(src)) {
        if (labels.has(t)) continue;
        const rel = file.slice(ROOT.length + 1).split("\\").join("/");
        missing.set(t, [...(missing.get(t) ?? []), rel]);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it("本番で英字のまま出ていた対象(2026-10-23 実測)と、その仲間がある", () => {
    for (const t of ["dm_inquiries", "agent_inquiries", "agents", "agent_viewings", "dm_scenarios", "dm_lp_variants", "dm_lp_assets", "edit_locks", "mail_config", "dm_export_batches", "dm_export_batch_items", "report_inbox_items", "push_subscriptions"]) {
      expect(labels.has(t), t).toBe(true);
    }
  });

  it("並び順の指定(asc/desc)は対象名として拾わない", () => {
    expect(literalTargetTables('orderBy: { targetTable: "asc" }')).toEqual([]);
    expect(literalTargetTables('targetTable: "agents",')).toEqual(["agents"]);
  });
});
