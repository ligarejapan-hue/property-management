/**
 * 所有者詳細に「紐づく物件」の一覧が出ることの配線テスト。
 * ⚠改行を LF に正規化してから比較する。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  resolve(__dirname, "../[id]/page.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("所有者詳細の紐づく物件一覧", () => {
  it("専用APIを作らず既存の物件一覧APIを所有者で絞って呼ぶ(権限とスコープを継承する)", () => {
    expect(src).toContain('fetchProperties({ ownerId, limit: "20" })');
    expect(src).not.toContain("/api/admin/owners/${ownerId}/properties");
  });

  it("20件を超えたら物件一覧へ逃がす導線を出す", () => {
    expect(src).toContain("すべて見る");
    expect(src).toContain("/properties?ownerId=");
  });

  it("見出しは平易な日本語にする", () => {
    expect(src).toContain("紐づく物件");
  });

  it("0件のときに何も無いと分かる文言を出す", () => {
    expect(src).toContain("紐づく物件はありません");
  });
});
