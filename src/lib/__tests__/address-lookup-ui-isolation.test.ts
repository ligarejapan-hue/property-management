/**
 * 住所補完 UI core のスコープ・ガードレール（source assertion）。
 *  #8: UI core ファイルが APIキー/secret/外部 provider/外部ホストを露出しない
 *      （取得は api-client wrapper＝社内 route 経由のみ）。
 *  #9: Property/Building のフォーム本体には**まだ組み込まない**（21-C 方針: Owner 先行・
 *      Property/Building は postalCode カラム要否を別途判断してから／本 PR では非接触）。
 *      Owner フォーム（owner-link-modal / 物件詳細 OwnerCard）は本 PR で統合するため対象外。
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

// Property/Building のフォーム本体。21-C PR4 方針変更により本 PR では非接触＝import を入れない。
// （Property/Building は zip カラムを持たず、postalCode 追加の要否を別途判断してから統合する。）
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

describe("#9 Property/Building フォーム本体には住所補完UIを組み込んでいない（21-C 方針: Owner 先行）", () => {
  for (const f of PROPERTY_BUILDING_FORM_FILES) {
    it(`${f}`, () => {
      const abs = resolve(process.cwd(), f);
      if (!existsSync(abs)) return;
      const src = readFileSync(abs, "utf8");
      expect(src).not.toContain("address-lookup-controls");
      expect(src).not.toContain("AddressLookupControls");
      expect(src).not.toContain("use-address-lookup");
      expect(src).not.toContain("useAddressLookup");
    });
  }
});
