/**
 * 反響資料のゲートが見る項目一覧と、**実サンプル(fixtures)に実在する所有者の項目**を
 * 突き合わせる（@codex PR#414 18巡目 ②）。
 *
 * ⚠17巡目で `nameKana`(フリガナ)を入れ忘れ、`owner_name_kana` をマスクする利用者が
 *   **PDFでは生のカナを読めた**。実サンプルB(査定依頼)には
 *   `■フリガナ　　　　： サトウ　ハナコ` が実在していたのに、
 *   「現行書式に無い」という誤った前提で park してしまった。
 * ⚠このテストがあれば起きなかった。**見本に所有者の項目が増えたら、
 *   ゲートの一覧を更新しない限り落ちる**形にしてある。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";
import { REFERRAL_GATED_OWNER_FIELDS } from "@/lib/uploads-authorization";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../paste-import/__tests__/fixtures");

/**
 * 下書きの所有者欄 → 表示レベル設定(resolveOwnerDisplayConfig)のキー。
 * ⚠貼り付け元の「現住所」は、表示レベルの上では登記上住所と同じ `address` で扱う
 *   （src/app/api/owners/route.ts と同じ規則）。
 */
const OWNER_FIELD_TO_DISPLAY_KEY: Record<string, string> = {
  name: "name",
  nameKana: "nameKana",
  phone: "phone",
  email: "email",
  currentAddress: "address",
};

/** 見本1件に実在する所有者の項目（値が入っているものだけ）を表示レベルのキーで返す。 */
function ownerDisplayKeysInFixture(text: string): string[] {
  const draft = buildPasteDraft(text);
  if (!draft.owner) return [];
  const keys: string[] = [];
  for (const [field, displayKey] of Object.entries(OWNER_FIELD_TO_DISPLAY_KEY)) {
    const value = draft.owner[field as keyof typeof draft.owner]?.value ?? null;
    if (value !== null && value.trim() !== "") keys.push(displayKey);
  }
  return keys;
}

describe("ゲートの項目一覧が、実サンプルの所有者の項目を漏れなく覆っている", () => {
  const fixtureNames = readdirSync(fixturesDir).filter((n) => n.endsWith(".txt"));

  it("見本ファイルが存在する（走査が空当たりでないことの前提）", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    it(`★${name} の所有者の項目は、すべてゲートの対象に入っている`, () => {
      const text = readFileSync(join(fixturesDir, name), "utf8").replace(/\r\n/g, "\n");
      const present = ownerDisplayKeysInFixture(text);
      const gated = new Set<string>(REFERRAL_GATED_OWNER_FIELDS);
      const missing = present.filter((k) => !gated.has(k));
      expect(
        missing,
        `${name}: ゲートに入っていない所有者の項目がある: ${missing.join(", ")}\n` +
          "REFERRAL_GATED_OWNER_FIELDS を更新すること",
      ).toEqual([]);
    });
  }

  it("★実サンプルB(査定依頼)には氏名・フリガナ・電話・メール・住所が実在する", () => {
    // ⚠この前提が崩れたら上の突き合わせは空当たりになる。前提そのものを固定する。
    const text = readFileSync(join(fixturesDir, "home4u-assessment.txt"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const present = ownerDisplayKeysInFixture(text);
    expect(present.sort()).toEqual(["address", "email", "name", "nameKana", "phone"].sort());
  });

  it("★ゲートの一覧に重複や余計な項目が無い", () => {
    const list = [...REFERRAL_GATED_OWNER_FIELDS];
    expect(new Set(list).size).toBe(list.length);
    expect(list.sort()).toEqual(["address", "email", "name", "nameKana", "phone"].sort());
  });
});
