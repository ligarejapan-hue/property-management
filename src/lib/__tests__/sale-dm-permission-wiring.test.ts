/**
 * @codex(47aa08c) follow-on: sale_dm:generate(有料AI生成の専用権限) の配線一貫性を検証する。
 *
 * R20 で gate(campaigns POST)と users 権限編集UI には sale_dm を追加したが、別系統の
 * 「テンプレート編集UI の RESOURCES」と「mock(admin 相当)権限」に追加し忘れていた:
 *  - テンプレートで権限を配る環境では admin が sale_dm:generate をテンプレートに付与できず、
 *    そのユーザーは campaign 作成 gate を必ず 403。
 *  - NEXT_PUBLIC_USE_MOCK=true の demo/dev では mock 権限に無く、MockLetterProvider があるのに 403。
 * registry:auto_fetch と同じ source-assertion 方式（registry-auto-fetch-permission.test.ts に倣う）。
 *
 * 設計: sale_dm:generate は「admin が明示付与する高リスク・課金操作」（seed では自動付与しない＝
 * 登録手順で付与する）。本テストは『付与できる経路(テンプレUI)に出る』『mock 全権限に含む』ことのみ担保し、
 * 既定付与(seed/auto-grant)は意図的に検証しない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { hasPermission } from "@/lib/permissions";

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
const usersPermPageSrc = read(
  "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
);
const templatesPageSrc = read(
  "src/app/(dashboard)/admin/templates/[id]/page.tsx",
);
const apiHelpersSrc = read("src/lib/api-helpers.ts");
const campaignsRouteSrc = read(
  "src/app/api/properties/sale-dm/campaigns/route.ts",
);

// ⚠PR-D2 で AI直結を廃止したため、この権限は**効果を持たない**。既存の付与を隠さない
//   よう選択肢は残すが、ラベルで「廃止・効果なし」と明示する（@codex #376 R7）。
const SALE_DM_ROW =
  /key: "sale_dm", label: "売却促進DM\(廃止・効果なし\)", actions: \["generate"\]/;

describe("sale_dm:generate の権限編集UI 配線(廃止済みだが選択肢は残す)", () => {
  it("users 権限編集UI に sale_dm の行が「廃止」ラベルで残っている", () => {
    expect(usersPermPageSrc).toMatch(SALE_DM_ROW);
  });

  it("templates 編集UI にも同じラベルで残っている", () => {
    expect(templatesPageSrc).toMatch(SALE_DM_ROW);
  });

  it("両UIで既存リソースのラベル（インポート/監査ログ）が壊れていない", () => {
    for (const src of [usersPermPageSrc, templatesPageSrc]) {
      expect(src).toMatch(/key: "import", label: "インポート"/);
      expect(src).toMatch(/key: "audit_log", label: "監査ログ"/);
    }
  });
});

describe("sale_dm:generate の mock(admin 相当)権限", () => {
  it("mock 全権限に sale_dm:generate(granted=true) がある（demo/dev で MockLetterProvider を使えるように）", () => {
    expect(apiHelpersSrc).toMatch(
      /resource:\s*"sale_dm",\s*action:\s*"generate",\s*granted:\s*true/,
    );
  });
});

describe("sale_dm:generate の gate と hasPermission", () => {
  it("campaign 作成 route は sale_dm:generate を要求しない(AI直結廃止・PR-D2)", () => {
    // このゲートの根拠は「課金 + オーナーPIIを外部APIへ送る」ことだった。外部AI方式は
    // どちらも無いので要求しない。書込門は property:write に統一(設計 §2.5)。
    expect(campaignsRouteSrc).not.toMatch(
      /hasPermission\(permissions, "sale_dm", "generate"\)/,
    );
  });

  it("campaign 作成 route は property:write を要求する", () => {
    expect(campaignsRouteSrc).toMatch(
      /hasPermission\(permissions, "property", "write"\)/,
    );
  });

  it("granted=true なら hasPermission が true", () => {
    expect(
      hasPermission(
        [{ resource: "sale_dm", action: "generate", granted: true }],
        "sale_dm",
        "generate",
      ),
    ).toBe(true);
  });

  it("付与が無ければ既定 deny(false)", () => {
    expect(hasPermission([], "sale_dm", "generate")).toBe(false);
  });
});
