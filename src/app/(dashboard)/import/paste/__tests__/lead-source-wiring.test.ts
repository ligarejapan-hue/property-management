import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 導入ルート「一括査定」(2026-10-19)。貼り付けた文章が HOME4U・タカウルの書式と読めたら
// 登録APIへその書式を知らせる(API が「一括査定」にする)。画面は "use client" で env=node では
// 動かせないため、登録の本文の配線を走査して固定する。
const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("貼り付けて物件化: 読み取った書式を登録に渡す", () => {
  it("登録の本文に leadSource: draft.sourceProfile がある", () => {
    const body = src.slice(src.indexOf("const body = {"), src.indexOf("draftSaver.markSubmitting();"));
    expect(body).toContain("leadSource: draft.sourceProfile,");
  });
});
