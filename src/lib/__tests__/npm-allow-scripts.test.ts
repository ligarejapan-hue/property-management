// npm 11 の allowScripts(部品を入れるときのスクリプトの許可一覧)の固定テスト。
//
// 背景:
// - npm 11.17 では、package.json の allowScripts に無い部品の install スクリプトは「警告だけ」で動く。
//   ただし npm の説明書に「将来の版では、確認していない install スクリプトを止める」とある。
// - 止められると、本番の反映(Linux x64・npm ci --include=dev)で @prisma/engines(migrate に要る)や
//   sharp(写真の縮小)の準備が行われず、反映が壊れる。
// - 2026-10-06 発注者判断: いまの版に限って許可する(pin)。部品の版を上げたら、この一覧も新しい版で
//   許可し直す(中身を確かめてから)。このテストは、版を上げて一覧を直し忘れたときに落ちる。
//
// 対象は「本番(Linux x64)に入る部品のうち install スクリプトを持つもの」。他の OS 専用の部品
// (fsevents・@embedded-postgres/darwin-* など)は本番に入らないので対象外。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readJson<T>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8")) as T;
}

interface LockPackage {
  version?: string;
  name?: string;
  hasInstallScript?: boolean;
  os?: string[];
  cpu?: string[];
}

const pkg = readJson<{ allowScripts?: Record<string, boolean> }>("package.json");
const lock = readJson<{ packages: Record<string, LockPackage> }>("package-lock.json");

/** npm の os / cpu 指定(「!win32」の否定も含む)が target に入るか。指定が無ければ入る。 */
function matchesPlatform(list: string[] | undefined, target: string): boolean {
  if (!list || list.length === 0) return true;
  if (list.includes(`!${target}`)) return false;
  const positives = list.filter((v) => !v.startsWith("!"));
  return positives.length === 0 || positives.includes(target);
}

/** lock の場所(node_modules/a/node_modules/@b/c)から部品名(@b/c)を取り出す。 */
function packageName(location: string, entry: LockPackage): string {
  if (entry.name) return entry.name;
  const i = location.lastIndexOf("node_modules/");
  return location.slice(i + "node_modules/".length);
}

const linuxInstallScripts = Object.entries(lock.packages)
  .filter(([loc, e]) => loc !== "" && e.hasInstallScript && matchesPlatform(e.os, "linux") && matchesPlatform(e.cpu, "x64"))
  .map(([loc, e]) => `${packageName(loc, e)}@${e.version}`)
  .sort();

describe("npm allowScripts(部品を入れるときのスクリプトの許可)", () => {
  it("os / cpu の指定の読み方", () => {
    expect(matchesPlatform(undefined, "linux")).toBe(true);
    expect(matchesPlatform(["linux"], "linux")).toBe(true);
    expect(matchesPlatform(["darwin"], "linux")).toBe(false);
    expect(matchesPlatform(["!win32"], "linux")).toBe(true);
    expect(matchesPlatform(["!linux"], "linux")).toBe(false);
  });

  it("本番(Linux x64)に入る install スクリプト付きの部品は、すべて同じ版で許可されている", () => {
    const allowed = Object.entries(pkg.allowScripts ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    expect(linuxInstallScripts.length).toBeGreaterThan(0);
    const missing = linuxInstallScripts.filter((id) => !allowed.includes(id));
    // 落ちたら: 部品の版が上がった(または増えた)。中身を確かめてから package.json の allowScripts を新しい版にする。
    expect(missing).toEqual([]);
  });

  it("許可一覧に、もう入っていない版の部品が残っていない", () => {
    const stale = Object.keys(pkg.allowScripts ?? {}).filter((id) => !linuxInstallScripts.includes(id));
    expect(stale).toEqual([]);
  });
});
