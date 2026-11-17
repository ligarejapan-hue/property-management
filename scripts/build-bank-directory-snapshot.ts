/**
 * 金融機関データの控え(data/bank-directory/zengin.json)を作り直す CLI(手元で使う・本番では使わない)。
 *
 * 使い方(データを新しくしたいとき):
 *   git clone --depth 1 https://github.com/zengin-code/source-data.git <置き場所>
 *   npx tsx scripts/build-bank-directory-snapshot.ts <置き場所>
 *   → data/bank-directory/zengin.json を書き換える。差分を PR にして、本番では
 *     scripts/import-bank-directory.ts で表に入れ直す。
 *
 * 元データ: zengin-code/source-data(MIT ライセンス・出典 ykaku.net)。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type SourceRow } from "../src/lib/bank-directory/snapshot";

const dir = process.argv[2];
if (!dir) {
  console.error("使い方: npx tsx scripts/build-bank-directory-snapshot.ts <source-data を置いたフォルダ>");
  process.exit(2);
}
const read = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const banks = read<Record<string, SourceRow>>(join(dir, "data", "banks.json"));
const branches: Record<string, Record<string, SourceRow>> = {};
for (const code of Object.keys(banks)) {
  const p = join(dir, "data", "branches", `${code}.json`);
  if (existsSync(p)) branches[code] = read<Record<string, SourceRow>>(p);
}
const commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const updatedAt = readFileSync(join(dir, "data", "updated_at"), "utf8").trim();
const snapshot = buildSnapshot(banks, branches, { source: "https://github.com/zengin-code/source-data", commit, updatedAt });

// リポジトリの一番上で実行する前提。
const out = join(process.cwd(), "data", "bank-directory", "zengin.json");
// 1金融機関1行(差分が読めるように)。
const lines = snapshot.banks.map((b) => JSON.stringify(b));
const { banks: _omit, ...head } = snapshot;
void _omit;
const body = JSON.stringify(head).slice(0, -1) + `,"banks":[\n${lines.join(",\n")}\n]}\n`;
writeFileSync(out, body, "utf8");
const branchCount = snapshot.banks.reduce((n, b) => n + b[4].length, 0);
console.log(`書き出し: ${out}(${snapshot.version}・金融機関 ${snapshot.banks.length}・支店 ${branchCount})`);
