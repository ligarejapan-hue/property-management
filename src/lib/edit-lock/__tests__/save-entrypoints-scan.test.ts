import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存窓口を呼ぶ入口すべてが合言葉のヘッダを付ける(仕様 5.1・6.1)。
 * 1つでも付け忘れると、その入口からの保存だけが鍵をすり抜ける。
 *
 * ⚠**corporate-lookup-panel.tsx は今はまだ含めない**(Task 7 の判断)。
 *   仕様上の6入口目だが、配線するのは Task 8。このタスク時点ではまだ
 *   `editLockHeaders(` を通していないため、ここに含めると走査が常に落ちた
 *   ままになり、「フル vitest run が green」というこのタスクのゲートを
 *   満たせない。Task 8 がその入口を配線するときに、この配列へ
 *   `src/components/owners/corporate-lookup-panel.tsx` を追記すること
 *   (そのときにこの走査がちょうど効く=Task 8 のレビューでも確認できる)。
 */
const ENTRYPOINTS = [
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/components/properties/registry-chiban-popup.tsx",
];

describe("保存の入口(走査)", () => {
  for (const rel of ENTRYPOINTS) {
    it(`${rel} は editLockHeaders を通している`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      // ⚠ブリーフのStep1コードの正規表現(`/editLockHeaders\(/`)は、各ファイルの
      //   JSDoc(「⚠合言葉は必ず `editLockHeaders()` を通す」という注意書き)にも
      //   一致してしまう。**実際の呼び出し**(`...editLockHeaders(`という spread、
      //   本番の3か所が実際にこの形)だけを見るよう絞る(このテスト自体を用いた
      //   実演で確認済み=下の bite 3 参照)。
      expect(src).toMatch(/\.\.\.editLockHeaders\(/);
    });
  }

  it("client 側の合言葉モジュールは server 専用の依存を引かない", () => {
    // ⚠ブリーフのStep1コードの正規表現(`/@\/lib\/(api-helpers|prisma|auth)/`)は
    //   コメント中の説明文(例: header-names.tsが「screen-token.tsは@/lib/api-helpers
    //   を経由するのでclientから import できない」と書いている一文)にも一致してしまい、
    //   本来引いていない依存を誤検知する。実際の import 文だけを見るよう
    //   `from "@/lib/..."` の形に絞る。
    for (const rel of ["src/lib/edit-lock/header-names.ts", "src/lib/edit-lock/screen-token-client.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).not.toMatch(/from "@\/lib\/(api-helpers|prisma|auth)"/);
    }
  });

  it("client の部品は server 用の screen-token.ts を import しない", () => {
    // ⚠`use-edit-lock-status.ts` はブリーフのStep1コードに載っていたが、このリポには
    //   存在しない(`src/hooks/` には `use-edit-lock.ts` しか無い・全文検索でも0件)。
    //   無いファイルを readFileSync すると ENOENT でこのテスト自体が落ちるため、
    //   実在するものだけを対象にする。将来そのフックが増えたら追記すること。
    for (const rel of [...ENTRYPOINTS, "src/hooks/use-edit-lock.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).not.toMatch(/from "@\/lib\/edit-lock\/screen-token"/);
    }
  });
});
