import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { lockOwnerRow } from "../row-locks";

/**
 * `lockOwnerRow` は所有者側の行ロックを1関数に集約する(review Important 4)。
 * 4つの経路(owners/[id]・corporate-apply・edit-locks/acquire・
 * edit-locks/force-release)が同じ SQL をコピペしていたのをここへまとめた。
 * SQL の中身自体は今までと同一であることを固定する。
 */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ""), "");
}

/**
 * owners テーブルを単一 id で FOR UPDATE する SQL の「形」。
 * ⚠review R3: 最初の版はコピペそのもの(1バイトも違わない文字列)しか
 * 捕まえられなかった。次の3つの言い換えを素通りさせない:
 *   - 空白/改行の揺れ(整形・複数行化)
 *   - 引用符付き識別子("owners"・"id")
 *   - キャストの書き方の違い(`::uuid` / `CAST(... AS uuid)`)
 * ⚠一方で `src/lib/dm-batch/locks.ts` の複数行バルクロック
 * (`WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`)は**別物**として
 * 除外し続ける: id の直後が `${`/`CAST(` ではなく `ANY(` なので、この正規表現は
 * そもそもそこにマッチしない(除外のための特別扱いは書いていない)。
 */
const OWNER_FOR_UPDATE_INLINE_SQL =
  /FROM\s+"?owners"?\s+WHERE\s+"?id"?\s*=\s*(?:\$\{[^}]+\}\s*::\s*uuid|CAST\(\s*\$\{[^}]+\}\s*AS\s*uuid\s*\))\s*FOR\s+UPDATE/i;

/** `dir` 配下の `.ts` ファイルを再帰的に列挙する(`excludeDirs` は対象外)。 */
function listSourceFiles(dir: string, excludeDirs: readonly string[]): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      files.push(...listSourceFiles(full, excludeDirs));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("lockOwnerRow", () => {
  it("エクスポートされている(呼び出し元が壊れて気づかない、を防ぐ)", () => {
    expect(typeof lockOwnerRow).toBe("function");
  });

  it("owners を id で FOR UPDATE ロックする(所有者→物件の親行の順序規約の所有者側)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw };
    const ownerId = "22222222-2222-4222-8222-222222222222";

    await lockOwnerRow(tx, ownerId);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("owners");
    expect(sql).toContain(`{${ownerId}}`);
  });

  it("渡された tx をそのまま使う(base client を勝手に使わない)", async () => {
    const txQueryRaw = vi.fn().mockResolvedValue([]);
    const otherQueryRaw = vi.fn().mockResolvedValue([]);
    await lockOwnerRow({ $queryRaw: txQueryRaw }, "id");
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(otherQueryRaw).not.toHaveBeenCalled();
  });

  // ⚠複製の再発防止(review Important 4 / R3): 4つのコピペを lockOwnerRow に
  // 置き換えても、「5つ目」がまた別の窓口にコピペ(または言い換え)されたら
  // このロック順序規約は再び崩れる。**このSQLの形(言い換えを含む)が
  // row-locks.ts 以外のどのファイルにも存在しない**ことを走査で固定し、
  // 次の複製をここで止める。

  it("row-locks.ts 自身はこの SQL の形を持つ(正規表現が空振りしていないことの確認)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/edit-lock/row-locks.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toMatch(OWNER_FOR_UPDATE_INLINE_SQL);
  });

  it("正規表現はコピペを言い換えた書き方(引用符付き識別子・改行・CASTキャスト)にも反応する(review R3)", () => {
    // ⚠実ファイルではなく、この正規表現自体の網羅性をピン留めするための
    //   その場限りの文字列。row-locks.ts の実装とは無関係。
    const rewordedCopy = [
      'await tx.$queryRaw`',
      '  SELECT "id"',
      '  FROM "owners"',
      '  WHERE "id" =',
      '    CAST(${ownerId} AS uuid)',
      '  FOR UPDATE',
      '`;',
    ].join("\n");
    expect(rewordedCopy).toMatch(OWNER_FOR_UPDATE_INLINE_SQL);
  });

  it("owner の FOR UPDATE ロック SQL(言い換えを含む)は src/ 配下で row-locks.ts にしか無い(唯一の正当な置き場)", () => {
    const root = join(process.cwd(), "src");
    const matches = listSourceFiles(root, ["__tests__", "generated"])
      .filter((file) => OWNER_FOR_UPDATE_INLINE_SQL.test(readFileSync(file, "utf8").replace(/\r\n/g, "\n")))
      .map((file) => relative(process.cwd(), file).replace(/\\/g, "/"));
    expect(matches).toEqual(["src/lib/edit-lock/row-locks.ts"]);
  });
});
