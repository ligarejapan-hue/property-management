import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// permissions.ts は @/lib/api-helpers(ApiError)を import しているだけだが、
// api-helpers 自体は next-auth を読み込むため、この source-scan テストでは
// permissions.test.ts と同じく最小限のモックに差し替える(next-auth 起動は不要)。
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import { OWNER_FIELD_RESOURCES } from "../permissions";

/**
 * `canWriteOwnerAnyField`(所有者の鍵を取れるかの判定)が見る所有者フィールド権限
 * (`OWNER_FIELD_RESOURCES`)は、実際の書込ゲート `PATCH /api/owners/[id]` の
 * `fieldWriteChecks`(src/app/api/owners/[id]/route.ts)の resource 集合と手作業で
 * 二重管理されている(permissions.ts のコメントに明記された既存の契約)。
 *
 * ⚠新しい所有者フィールドの書込権限(resource)が fieldWriteChecks に足されても、
 *   OWNER_FIELD_RESOURCES への追記を忘れると気づく手段が無かった。その場合、
 *   その resource だけを持つ利用者は「保存はできるのに鍵は取れない」という
 *   抜けになる(逆に fieldWriteChecks から先に消せば「鍵は取れるが実際には
 *   何も書けない」resource が残ってしまう)。
 *
 * authoritative source の選定(Task 9):
 *   `src/lib/permissions.ts`(resolveOwnerDisplayConfig)や `prisma/seed.ts` も
 *   owner_* resource 一覧を持つが、いずれも「表示レベル」「初期テンプレートに
 *   何を割り当てるか」という別の関心事の副産物であり、"owner フィールドを
 *   書ける resource は何か" を定義してはいない。それを実際に定義している唯一の
 *   コードは、書込を許可判定している fieldWriteChecks そのもの
 *   (`src/app/api/owners/[id]/route.ts`)。かつ OWNER_FIELD_RESOURCES 自身の
 *   コメントも既にこれを authoritative としている(controller決定・2026-09-18)。
 *   よってこの一致を fieldWriteChecks 側から機械的に検証する。
 */
function extractFieldWriteCheckResources(): string[] {
  const src = readFileSync(
    join(process.cwd(), "src/app/api/owners/[id]/route.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  const startMarker = "const fieldWriteChecks";
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      "src/app/api/owners/[id]/route.ts に `const fieldWriteChecks` が見つからない" +
        "(変数名が変わった? owner-field-permission-drift-scan.test.ts の抽出ロジックを直すこと)",
    );
  }
  const end = src.indexOf("\n    ];", start);
  if (end === -1) {
    throw new Error(
      "fieldWriteChecks 配列の終端(`\\n    ];`)が見つからない" +
        "(インデント/整形が変わった? 抽出ロジックを直すこと)",
    );
  }
  const block = src.slice(start, end);
  const resources = [...block.matchAll(/resource:\s*"([a-zA-Z_]+)"/g)].map(
    (m) => m[1],
  );
  if (resources.length === 0) {
    throw new Error(
      "fieldWriteChecks から resource を1件も抽出できなかった" +
        "(正規表現が実際の書き方とずれている可能性)",
    );
  }
  return resources;
}

describe("所有者フィールド権限リストのドリフト検出(edit-lock vs 書込ゲート)", () => {
  it("OWNER_FIELD_RESOURCES は fieldWriteChecks の resource 集合(重複除去)と一致する", () => {
    const fromRoute = new Set(extractFieldWriteCheckResources());
    const fromLock = new Set(OWNER_FIELD_RESOURCES as readonly string[]);

    const missingInLock = [...fromRoute].filter((r) => !fromLock.has(r)).sort();
    const extraInLock = [...fromLock].filter((r) => !fromRoute.has(r)).sort();

    expect(
      { missingInLock, extraInLock },
      missingInLock.length > 0
        ? `fieldWriteChecks に新しい resource (${missingInLock.join(", ")}) があるのに` +
            " OWNER_FIELD_RESOURCES に追記されていない。このままだと、その resource" +
            "だけを持つ利用者は保存できるのに編集の鍵を取れない。" +
            "src/lib/edit-lock/permissions.ts の OWNER_FIELD_RESOURCES に追記すること。"
        : extraInLock.length > 0
          ? `OWNER_FIELD_RESOURCES に fieldWriteChecks には無い resource (${extraInLock.join(", ")})` +
            " が残っている。書込ゲートから消えた resource が鍵の判定にだけ残っている" +
            "(削除し忘れの可能性)。"
          : undefined,
    ).toEqual({ missingInLock: [], extraInLock: [] });
  });

  it("抽出そのものが空振りしていないことの確認(正規表現の健全性)", () => {
    // 現時点で8個(owner_name/owner_name_kana/owner_phone/owner_zip/owner_address/
    // owner_email/owner_note/owner_corporate_number)+ companyRegistryNumber の
    // 別名エントリ1件で計9件。将来増減してもよいが、0件は抽出ロジックが
    // 壊れているサインとして扱う。
    expect(extractFieldWriteCheckResources().length).toBeGreaterThanOrEqual(8);
  });
});
