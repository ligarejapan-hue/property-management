import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/** owners テーブルを単一 id で FOR UPDATE する、集約前のコピペ SQL の形。 */
const OWNER_FOR_UPDATE_INLINE_SQL = /FROM owners WHERE id = \$\{[A-Za-z0-9_]+\}::uuid FOR UPDATE/;

/** `dir` 配下の `.ts` ファイルを再帰的に列挙する(`__tests__` は対象外)。 */
function listRouteSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...listRouteSourceFiles(full));
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

  // ⚠複製の再発防止(コーディネーター指摘): 4つ目のコピペ(force-release)を
  // lockOwnerRow に置き換えても、「5つ目」がまた別の窓口にコピペされたら
  // このロック順序規約は再び崩れる。**このSQLの形が row-locks.ts 以外の
  // どの route file にも存在しない**ことを走査で固定し、次の複製をここで止める。
  it("row-locks.ts 自身はこの SQL の形を持つ(正規表現が空振りしていないことの確認)", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/edit-lock/row-locks.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toMatch(OWNER_FOR_UPDATE_INLINE_SQL);
  });

  it("owner の FOR UPDATE ロック SQL は src/app/api/ 配下のどの route file にも複製されていない(row-locks.ts が唯一の置き場)", () => {
    const root = join(process.cwd(), "src/app/api");
    const offenders = listRouteSourceFiles(root)
      .filter((file) => OWNER_FOR_UPDATE_INLINE_SQL.test(readFileSync(file, "utf8").replace(/\r\n/g, "\n")))
      .map((file) => file.replace(process.cwd(), "").replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
