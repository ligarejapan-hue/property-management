import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const importsOf = (src: string) => [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

/**
 * 画面(ブラウザ)で読む資料送付のファイルは、サーバー専用のもの(認可・DB・保存先)を読まない
 * (@codex 7巡目 P1: material-send → uploads-authorization → prisma/pg/fs が画面に入り本番の build が落ちた)。
 */
const CLIENT_FILES = [
  "src/components/agent-inquiry/material-send-dialog.tsx",
  "src/lib/agent-inquiry/material-send-form.ts",
  "src/lib/agent-inquiry/material-send-limits.ts",
];
const SERVER_ONLY = [
  /^@\/lib\/agent-inquiry\/material-send$/,
  /^\.\/material-send$/,
  /^@\/lib\/agent-inquiry\/material-send-service$/,
  /^\.\/material-send-service$/,
  /uploads-authorization/,
  /^@\/lib\/prisma$/,
  /^@\/lib\/storage/,
  /^@\/lib\/permissions$/,
  /^@\/lib\/api-helpers$/,
  /^node:/,
];

describe("資料送付の画面側はサーバー専用のものを読まない", () => {
  it.each(CLIENT_FILES)("%s", (f) => {
    const bad = importsOf(read(f)).filter((i) => SERVER_ONLY.some((re) => re.test(i)));
    expect(bad).toEqual([]);
  });
  it("上限・宛先の確かめは画面用のファイルにあり、サーバー側はそれを使い回す(数字を2か所に書かない)", () => {
    expect(read("src/lib/agent-inquiry/material-send-limits.ts")).toMatch(/export const MATERIAL_SEND_LIMITS =/);
    expect(read("src/lib/agent-inquiry/material-send.ts")).not.toMatch(/export const MATERIAL_SEND_LIMITS =/);
  });
});
