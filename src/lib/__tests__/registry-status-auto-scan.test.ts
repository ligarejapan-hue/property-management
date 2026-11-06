/**
 * 登記状況の自動「取得済」(2026-11-06)の配線を全経路で守る走査テスト。
 *   - 謄本の添付(type "registry")を作るファイルは、どれも autoMarkRegistryObtainedBestEffort を呼ぶ
 *     (新しい入口を足して呼び忘れると、その入口だけ未取得のまま残る)
 *   - 謄本の取得の成功は、取得済にした更新のあと・課金後の失敗に変える try の外で履歴を残す
 * ⚠改行を LF に正規化してから比べる。
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, it, expect } from "vitest";

const SRC = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const read = (p: string) => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/** attachment.create の data に謄本の種類を書くファイル(固定の "registry" か、謄本になり得る変数)。 */
function createsRegistryAttachment(src: string): boolean {
  const re = /attachment\.create\(\{\s*data:\s*\{([\s\S]*?)\n\s*\},/g;
  for (const m of src.matchAll(re)) {
    if (/\btype:\s*"registry"/.test(m[1])) return true;
  }
  return false;
}

describe("謄本の添付を作る入口は、どれも登記状況を取得済に上げる", () => {
  const files = walk(SRC).filter((p) => !p.endsWith("registry-status-auto.ts"));
  const creators = files.filter((p) => createsRegistryAttachment(read(p)));
  // 種類を変数で渡す入口(添付・分割)は、謄本になり得るので名前で足す。
  const variableTyped = [
    "app/api/properties/[id]/attachments/route.ts",
    "app/api/properties/[id]/attachments/split/route.ts",
  ];

  it("固定の謄本を作る入口を見つけられている(走査そのものの確認)", () => {
    const rel = creators.map((p) => relative(SRC, p).replace(/\\/g, "/")).sort();
    expect(rel).toEqual([
      "app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/route.ts",
      "lib/registry-pdf-bulk/process-row.ts",
      "lib/registry-pdf/process.ts",
    ]);
  });

  it.each([...variableTyped, "app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/route.ts", "lib/registry-pdf-bulk/process-row.ts", "lib/registry-pdf/process.ts"])(
    "%s は autoMarkRegistryObtainedBestEffort を呼ぶ",
    (rel) => {
      expect(read(join(SRC, rel))).toMatch(/await autoMarkRegistryObtainedBestEffort\(\{/);
    },
  );

  it("見つけた入口はすべて呼んでいる", () => {
    for (const p of creators) expect(read(p), p).toMatch(/autoMarkRegistryObtainedBestEffort\(/);
  });
});

describe("行の確定に失敗すると添付を取り消す入口は、確定のあとで上げる(@codex P2)", () => {
  it("一括取り込みの行: finalizeRow の成功(取り消しの分岐)より後", () => {
    const src = read(join(SRC, "lib/registry-pdf-bulk/process-row.ts"));
    const lastUndo = src.lastIndexOf("await undoAttachmentBestEffort(");
    const mark = src.indexOf("await autoMarkRegistryObtainedBestEffort(");
    expect(lastUndo).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(lastUndo);
    // 呼ぶのは1か所だけ(確定の前に残っていない)。
    expect(src.indexOf("autoMarkRegistryObtainedBestEffort(", mark + "await autoMarkRegistryObtainedBestEffort(".length)).toBe(-1);
  });

  it("取込の行から謄本を付ける画面: 行の確定と取り消しの catch より後", () => {
    const src = read(join(SRC, "app/api/import/jobs/[jobId]/rows/[rowId]/manual-attach-registry-pdf/route.ts"));
    const undo = src.indexOf("await prisma.attachment.delete({ where: { id: attachmentId } });");
    const rethrow = src.indexOf("throw finalizeErr;", undo);
    const mark = src.indexOf("await autoMarkRegistryObtainedBestEffort(");
    expect(undo).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(rethrow);
    // 呼ぶのは1か所だけ(確定の前に残っていない)。
    expect(src.indexOf("autoMarkRegistryObtainedBestEffort(", mark + "await autoMarkRegistryObtainedBestEffort(".length)).toBe(-1);
  });
});

describe("謄本の取得の成功で変更履歴を残す", () => {
  const src = read(join(SRC, "lib/registry-fetch/auto-fetch.ts"));

  it("取得済にした更新のあと、課金後の失敗に変える catch の外で残す", () => {
    const update = src.indexOf('data: { registryStatus: "obtained", version: { increment: 1 } }');
    const postCatch = src.indexOf("} catch (postErr) {");
    const log = src.indexOf("await logRegistryObtainedByFetch({ propertyId, previousStatus, changedBy: session.id });");
    expect(update).toBeGreaterThan(0);
    expect(postCatch).toBeGreaterThan(update);
    expect(log).toBeGreaterThan(postCatch);
    // catch の閉じより後(=try の外)
    const catchEnd = src.indexOf("\n    }\n", postCatch);
    expect(log).toBeGreaterThan(catchEnd);
  });
});
