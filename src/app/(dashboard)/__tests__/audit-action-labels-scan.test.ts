/**
 * 監査ログ画面の「操作種別」は、コードが記録する action をすべて日本語で出す。
 *
 * 背景(実機確認 2026-10-22): 本番の操作種別 123 個のうち 28 個が英字のまま
 * (sale_dm_scenario_update など)。新しい機能で action を足すたびに
 * ACTION_LABELS へ足し忘れる型なので、ソース走査で守る。
 *
 * 走査の境界:
 *  - 見るのは監査ログの書き込み(`writeAuditLog(` / `auditLog.create(` /
 *    `auditLog.createMany(`)の呼び出しの中に **素の文字列** で書かれた action だけ
 *    (三項演算子の両辺も拾う)。変数や式で組み立てた action は見えない。
 *  - 式で組み立てる既知の経路(物件のワンクリック操作 `action:${action}`・
 *    画面保護 `eventTypeToAuditAction`・受付メール `inquiry_auto_reply_${status}`)は
 *    別の it で、その元の集合を名指しで照合する。
 *  - 本番で観測した 28 個は固定の一覧で照合する(走査の抜けの保険)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const PAGE = read("src/app/(dashboard)/admin/audit-logs/page.tsx");

/** 画面の ACTION_LABELS の鍵を取り出す(純関数)。 */
export function actionLabelKeys(src: string): Set<string> {
  const start = src.indexOf("const ACTION_LABELS");
  const end = src.indexOf("const TARGET_TABLE_LABELS");
  const block = src.slice(start, end);
  const keys = new Set<string>();
  for (const m of block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*"/gm)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

/** src 配下の .ts/.tsx(テスト・生成物を除く)。 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

/** 呼び出しの開き括弧から、対応する閉じ括弧までの文字列(文字列リテラルの中の括弧は数えない)。 */
export function callText(src: string, openIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return src.slice(openIndex);
}

/** 監査の書き込み呼び出しの中にある、素の文字列の action をすべて集める。 */
export function literalAuditActions(src: string): string[] {
  const out: string[] = [];
  const re = /(writeAuditLog|auditLog\.create|auditLog\.createMany)\(/g;
  for (const m of src.matchAll(re)) {
    let text = callText(src, m.index! + m[0].length - 1);
    // detail の中身(`detail: { action: "retry" }` など)は操作種別ではないので除く。
    for (;;) {
      const d = text.search(/\bdetail:\s*\{/);
      if (d < 0) break;
      const inner = callText(text, text.indexOf("{", d));
      text = text.slice(0, d) + text.slice(d + (text.indexOf("{", d) - d) + inner.length);
    }
    // `action: "x"` と `action: cond ? "a" : "b"` の両方を拾う。
    for (const a of text.matchAll(/\baction:\s*([^\n,]+)/g)) {
      for (const s of a[1].matchAll(/"([^"]+)"/g)) out.push(s[1]);
    }
  }
  return out;
}

describe("監査ログの操作種別はすべて日本語名を持つ(ソース走査)", () => {
  const labels = actionLabelKeys(PAGE);

  it("ACTION_LABELS を読めている(100個以上)", () => {
    expect(labels.size).toBeGreaterThan(100);
  });

  it("コードが素の文字列で記録する action は、すべて ACTION_LABELS にある", () => {
    const missing = new Map<string, string[]>();
    for (const file of walk(join(ROOT, "src"))) {
      const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (!/writeAuditLog\(|auditLog\.create/.test(src)) continue;
      for (const a of literalAuditActions(src)) {
        if (labels.has(a)) continue;
        const rel = file.slice(ROOT.length + 1).split("\\").join("/");
        missing.set(a, [...(missing.get(a) ?? []), rel]);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it("本番で英字のまま出ていた28個(2026-10-22 実測)がある", () => {
    const observed = [
      "agent_create",
      "agent_inquiry_create",
      "agent_inquiry_material_apply",
      "agent_inquiry_material_send",
      "agent_inquiry_update",
      "building.auto_create",
      "building.catalog_adopt",
      "edit_lock_acquire",
      "edit_lock_release",
      "paste_import_property_create",
      "property_ad_permissions_update",
      "property.building_link",
      "sale_dm_body_paste",
      "sale_dm_lp_asset_upload",
      "sale_dm_lp_body_paste",
      "sale_dm_lp_prompt_view",
      "sale_dm_lp_variant_create",
      "sale_dm_prompt_view",
      "sale_dm_scenario_create",
      "sale_dm_scenario_letter_illustration_update",
      "sale_dm_scenario_letter_template",
      "sale_dm_scenario_lp_image_prompt_view",
      "sale_dm_scenario_lp_preview_view",
      "sale_dm_scenario_lp_template",
      "sale_dm_scenario_media_update",
      "sale_dm_scenario_update",
      "sale_dm_template_apply",
      // 旧コードが記録した分(案件ステータスの拡張で経路は消えたが、記録は残る)
      "action:advance_case_status",
    ];
    expect(observed.filter((a) => !labels.has(a))).toEqual([]);
  });

  it("物件のワンクリック操作(action:<名前>)は、受け付ける名前すべてに日本語名がある", () => {
    const route = read("src/app/api/properties/[id]/actions/route.ts");
    const enumText = route.match(/action:\s*z\.enum\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    const names = [...enumText.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !labels.has(`action:${n}`))).toEqual([]);
  });

  it("画面保護(eventTypeToAuditAction)と受付メール(inquiry_auto_reply_<結果>)の全値に日本語名がある", () => {
    const sp = read("src/lib/screen-protection.ts");
    const fnStart = sp.indexOf("export function eventTypeToAuditAction");
    const fn = sp.slice(fnStart, sp.indexOf("export function", fnStart + 1));
    const piiActions = [...fn.matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
    expect(piiActions.length).toBeGreaterThan(0);
    expect(piiActions.filter((a) => !labels.has(a))).toEqual([]);
    for (const s of ["sent", "failed", "skipped"]) {
      expect(labels.has(`inquiry_auto_reply_${s}`)).toBe(true);
    }
  });

  it("未知コードの生表示フォールバックは残す(古いログ対策)", () => {
    expect(PAGE).toMatch(/ACTION_LABELS\[[^\]]+\]\s*\?\?/);
  });
});
