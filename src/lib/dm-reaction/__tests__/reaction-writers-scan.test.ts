import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 宛先不明の解除(2026-11-13)の守り(走査)。
 *
 * ① 反響(reactionStatus)を書き換える所は、解除の印の扱い(clearedFieldsOnReactionWrite)を
 *    必ず一緒に書く。忘れると「解除した宛先不明」の印が、別の反響や新しい宛先不明に残る。
 * ② 送付対象から外す理由になる記録かどうかを、読む側が `reactionStatus: { in: 終端の集合 }` や
 *    `reactionStatus: "undeliverable"` で直書きしない(dm-reaction/core.ts の断片だけを使う)。
 *    直書きすると、解除を無視して外し続ける/数え続ける(食い違う)。
 */
const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "generated" || name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({
  rel: relative(process.cwd(), p).replace(/\\/g, "/"),
  src: readFileSync(p, "utf8").replace(/\r\n/g, "\n"),
}));

describe("反響を書き換える所は、解除の印の扱いも書く", () => {
  it("`reactionStatus: next.reactionStatus` の直後に clearedFieldsOnReactionWrite がある", () => {
    const missing: string[] = [];
    let found = 0;
    for (const { rel, src } of files) {
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/^\s*reactionStatus: next\.reactionStatus,\s*$/.test(line)) return;
        found += 1;
        const after = lines.slice(i + 1, i + 4).join("\n");
        if (!after.includes("...clearedFieldsOnReactionWrite(")) missing.push(`${rel}:${i + 1}`);
      });
    }
    // 空振りでないこと(書き換える所は 6 か所: 手動・孤児・配信停止2つ・同期・突き合わせ)
    expect(found).toBeGreaterThanOrEqual(6);
    expect(missing, `解除の印の扱いが無い: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("外す理由になる記録かを、読む側で直書きしない", () => {
  // dm-reaction/core.ts が唯一の定義元。画面・型・一覧の表示など「絞り込みでない」所は対象外。
  const ALLOWED = new Set(["src/lib/dm-reaction/core.ts", "src/lib/dm-reaction/undeliverable-flag.ts"]);

  it("where に `reactionStatus: { in: [...TERMINAL…` / SELF_EXCLUDING… を書いていない", () => {
    const bad: string[] = [];
    for (const { rel, src } of files) {
      if (ALLOWED.has(rel)) continue;
      src.split("\n").forEach((line, i) => {
        if (/reactionStatus:\s*\{\s*in:\s*\[\s*\.\.\.(TERMINAL_REACTIONS|TERMINAL_REACTION_VALUES|SELF_EXCLUDING_REACTION_VALUES)/.test(line)) {
          bad.push(`${rel}:${i + 1}`);
        }
        if (/reactionStatus:\s*(terminalIn|\{\s*in:\s*\[\s*"refused",\s*"undeliverable")/.test(line)) {
          bad.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(bad, `dm-reaction/core.ts の断片を使うこと: ${bad.join(", ")}`).toEqual([]);
  });

  it('DB の where に `reactionStatus: "undeliverable"` を直書きしていない(数える・探すは core の断片で)', () => {
    const bad: string[] = [];
    for (const { rel, src } of files) {
      if (ALLOWED.has(rel)) continue;
      // route / lib の DB 条件だけを見る(画面の部品・型定義・クライアントの型は対象外)
      if (!rel.startsWith("src/app/api/") && !rel.startsWith("src/lib/") && !rel.startsWith("src/app/u/")) continue;
      src.split("\n").forEach((line, i) => {
        if (/^\s*reactionStatus:\s*"undeliverable",?\s*$/.test(line)) bad.push(`${rel}:${i + 1}`);
        if (/where:\s*\{[^}]*reactionStatus:\s*"undeliverable"/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad, `activeUndeliverableLogWhere / countActiveUndeliverable を使うこと: ${bad.join(", ")}`).toEqual([]);
  });
});
