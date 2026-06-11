/**
 * 住所補完 UI core のスコープ・ガードレール（source assertion）。
 *  #8: UI core ファイルが APIキー/secret/外部 provider/外部ホストを露出しない
 *      （取得は api-client wrapper＝社内 route 経由のみ）。
 *  #9: Property/Building フォーム本体には住所補完 UI を統合済み（21-C PR-2 / postalCode 追加後）。
 *      AddressLookupControls を import し、addressEdited（user-edit signal）を渡す。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf8");

const NEW_FILES = [
  "src/lib/address-lookup-ui-utils.ts",
  "src/hooks/use-address-lookup.ts",
  "src/components/address/address-lookup-controls.tsx",
];

// Property/Building のフォーム本体。21-C PR-2 で AddressLookupControls を統合済み
// （postalCode カラム追加 #167 後）。
const PROPERTY_BUILDING_FORM_FILES = [
  "src/components/properties/new-property-modal.tsx",
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/buildings/page.tsx",
  "src/app/(dashboard)/buildings/[id]/page.tsx",
];

describe("#8 新規UIファイルは APIキー/secret/外部provider を露出しない", () => {
  for (const f of NEW_FILES) {
    it(`${f}`, () => {
      const src = read(f);
      expect(src).not.toContain("ADDRESS_LOOKUP_API_KEY");
      expect(src).not.toContain("process.env.ADDRESS_LOOKUP");
      expect(src).not.toContain("japanpost-provider");
      // 外部 API ホストを直接叩かない（社内 route / api-client wrapper 経由のみ）。
      expect(src).not.toMatch(/japanpost\.jp|ent-api/);
      // env を読む orchestrator(index) を runtime import しない（型は /types から取る）。
      expect(src).not.toMatch(/from\s+["']@\/lib\/address-lookup["']/);
      expect(src).not.toMatch(/from\s+["']\.\/address-lookup["']/);
    });
  }
});

describe("#9 Property/Building フォーム本体に住所補完UIを統合済み（21-C PR-2）", () => {
  for (const f of PROPERTY_BUILDING_FORM_FILES) {
    it(`${f}`, () => {
      const abs = resolve(process.cwd(), f);
      expect(existsSync(abs)).toBe(true);
      const src = readFileSync(abs, "utf8");
      expect(src).toMatch(
        /from\s+["']@\/components\/address\/address-lookup-controls["']/,
      );
      expect(src).toContain("<AddressLookupControls");
      // user-edit signal を渡している。
      expect(src).toContain("addressEdited={addressEdited}");
    });
  }
});
