/**
 * 戻し手順(docs/deploy.md 8.2・案件ステータスの整理)が、旧版の間に人が変えた物件を
 * 上書きしないこと(@codex #538 P2)。控えに版(version)を残し、戻すのは
 * 「退避で1つ進めたあと誰も触っていない行」(版がちょうど +1)だけ。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CASE_STATUS_DEPRECATED_MAP } from "@/lib/property-types";

const doc = readFileSync(resolve(process.cwd(), "docs/deploy.md"), "utf8");
const sec = doc.slice(doc.indexOf("### 8.2 案件ステータスの整理"), doc.indexOf("### 現況「賃貸中」"));

describe("deploy.md 8.2 案件ステータスの戻し手順", () => {
  it("節がある", () => {
    expect(sec.length).toBeGreaterThan(100);
  });

  it("控えに版を残す", () => {
    expect(sec).toMatch(/SELECT id, case_status::text AS case_status, version FROM properties/);
  });

  it("戻すのは版がちょうど1つ進んだだけの行(旧版の間に触られていない)", () => {
    expect(sec).toMatch(/p\.version = b\.version \+ 1/);
    expect(sec).not.toMatch(/p\.case_status = 'negotiating'/);
  });

  it("新コードへ戻す前に、旧版の間に保存されたやめた値を移し直す(対応表と同じ・@codex #538 R2 P2)", () => {
    const fwd = sec.slice(sec.indexOf("再び新コードへ進める"));
    const got: Record<string, string> = {};
    for (const m of fwd.matchAll(/SET case_status = '(\w+)'[^;]*?WHERE case_status IN \(([^)]*)\)/g)) {
      for (const f of m[2].matchAll(/'(\w+)'/g)) got[f[1]] = m[1];
    }
    expect(got).toEqual(CASE_STATUS_DEPRECATED_MAP);
    // 新コードを start する前に流す
    expect(fwd.indexOf("SET case_status = 'contacting_owner'")).toBeLessThan(fwd.indexOf("systemctl start"));
  });

  it("サービスを止めてから退避する", () => {
    expect(sec.indexOf("systemctl stop")).toBeLessThan(sec.indexOf("CREATE TABLE"));
  });
});
