/**
 * PR2 のスコープ・ガードレール（source assertion）。
 *  #8: 新規 UI ファイルが APIキー/secret/外部 provider/外部ホストを露出しない
 *      （取得は api-client wrapper＝社内 route 経由のみ）。
 *  #9: Owner/Property/Building のフォーム本体にまだ組み込んでいない（#163 競合回避）。
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

// 住所補完を将来組み込む候補。本 PR ではいずれにも import を入れない。
// owner-link-modal.tsx は #163(別ブランチ)所有のため当ブランチには存在しない場合がある。
const FORM_FILES = [
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/components/properties/new-property-modal.tsx",
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/buildings/page.tsx",
  "src/app/(dashboard)/buildings/[id]/page.tsx",
  "src/components/owners/owner-link-modal.tsx",
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

describe("#9 フォーム本体にまだ住所補完UIを組み込んでいない", () => {
  for (const f of FORM_FILES) {
    it(`${f}`, () => {
      const abs = resolve(process.cwd(), f);
      if (!existsSync(abs)) return; // 当ブランチに無いファイルは対象外(#163 所有等)。
      const src = readFileSync(abs, "utf8");
      expect(src).not.toContain("address-lookup-controls");
      expect(src).not.toContain("AddressLookupControls");
      expect(src).not.toContain("use-address-lookup");
      expect(src).not.toContain("useAddressLookup");
    });
  }
});
