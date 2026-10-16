import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 使い方ガイド・マニュアル(アプリ内複製)が、2026-10-17 の手紙の紙面と食い違っていないこと。
// 機能を足したら資料の古い説明(「【イラスト】が無ければ本文の上」だけ・「未登録の種類は今までの見た目」)も消す。
const doc = (f: string) => readFileSync(path.join(process.cwd(), "public/docs", f), "utf8");

describe("資料: 手紙の紙面(2026-10-17)", () => {
  for (const f of ["guide.html", "manual.html"]) {
    it(`${f}: 紙面の説明があり、古い「本文の上」だけの説明を残していない`, () => {
      const s = doc(f);
      expect(s).toContain("手紙の紙面（2026-10-17）");
      expect(s).toContain("A4 1枚");
      expect(s).toContain("困りごとの箇条書き（「・」の行）の枠の右");
      expect(s).not.toContain("【イラスト】が無い文面では<b>本文の上</b>");
      expect(s).not.toContain("イラストが未登録の種類は今までの見た目のままです");
      expect(s).toContain("最終更新: 2026-10-17");
    });
  }
});
