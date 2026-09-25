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
 *   満たせない。Task 8 がその入口を配線するときに、下の
 *   `describe("corporate-lookup-panel.tsx(6入口目)")` を書き換えること
 *   (そのときにその「まだ配線していない」テストが赤くなり、書き換えを強制する
 *   =fix round1 Important #3)。
 */
const ENTRYPOINTS = [
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/components/properties/registry-chiban-popup.tsx",
  "src/lib/api-client.ts",
];

/**
 * 入口ごとの**実際の呼び出し箇所**(ファイル丸ごとではない・fix round1 Important #2)。
 *
 * ⚠ファイル単位の「どこかに `...editLockHeaders(` があればOK」という検査だと、
 *   1つのファイルに複数の保存経路が同居しているとき(`page.tsx` は
 *   案件ステータス・導入ルート・所有者カードの3入口を持つが、実際に
 *   `...editLockHeaders(` を書く箇所は `runNoLockPropertyPatch` 1本だけ)、
 *   別の保存経路(例: 所有者カードが呼ぶ `updateOwner`)がヘッダを落としても
 *   ファイル内のどこかに別の入口の呼び出しさえ残っていれば green のままになる。
 *   実際、所有者カードのヘッダは `page.tsx` にはまったく現れない
 *   (`api-client.ts` の `updateOwner` の中でだけ組み立てられる)ため、
 *   `src/lib/api-client.ts` を対象に含めない限りこの入口は検査されない。
 *   関数本体を切り出して、その中に `...editLockHeaders(` があることを固定する。
 */
const ENTRYPOINT_CALL_SITES: { label: string; file: string; anchor: RegExp }[] = [
  {
    label: "物件の編集ウィンドウ(property-edit-form.tsx・buildPropertySaveInit)",
    file: "src/components/properties/property-edit-form.tsx",
    anchor: /export function buildPropertySaveInit\([^)]*\)[^{]*\{[\s\S]{0,400}?\.\.\.editLockHeaders\(/,
  },
  {
    label: "案件ステータス・導入ルートのプルダウン(page.tsx・runNoLockPropertyPatch)",
    file: "src/app/(dashboard)/properties/[id]/page.tsx",
    anchor: /export async function runNoLockPropertyPatch\([\s\S]{0,400}?\.\.\.editLockHeaders\(/,
  },
  {
    label: "地番ポップアップ(registry-chiban-popup.tsx・runChibanSave)",
    file: "src/components/properties/registry-chiban-popup.tsx",
    anchor: /export async function runChibanSave\([\s\S]{0,400}?\.\.\.editLockHeaders\(/,
  },
  {
    label: "所有者カード(api-client.ts・updateOwner)",
    file: "src/lib/api-client.ts",
    anchor: /export async function updateOwner\([\s\S]{0,600}?\.\.\.editLockHeaders\(opts\.lockId\)/,
  },
];

describe("保存の入口(走査・呼び出し箇所ごと)", () => {
  for (const { label, file, anchor } of ENTRYPOINT_CALL_SITES) {
    it(`${label} は呼び出し箇所自体で editLockHeaders を通している`, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(anchor);
    });
  }

  it("所有者カードの呼び出し元(page.tsx)は取得できた lockId を updateOwner の第3引数に渡す", () => {
    // ⚠これだけでは「ヘッダが付く」ことは固定できない(それは上の updateOwner 側の
    //   検査の役目)。ここで固定するのは、呼び出し元が世代(lockId)を取り違えずに
    //   渡していること(owner-card-edit-lock.test.tsxの走査と同趣旨・二重の網)。
    const src = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).toMatch(/updateOwner\(po\.ownerId,[\s\S]*?\{\s*lockId:\s*lock\.lockId,?\s*\}/);
  });

  it("client 側の合言葉モジュールは server 専用の依存を引かない", () => {
    // ⚠ブリーフのStep1コードの正規表現(`/@\/lib\/(api-helpers|prisma|auth)/`)は
    //   コメント中の説明文(例: header-names.tsが「screen-token.tsは@/lib/api-helpers
    //   を経由するのでclientから import できない」と書いている一文)にも一致してしまい、
    //   本来引いていない依存を誤検知する。実際の import 文だけを見るよう
    //   `from "@/lib/..."` の形に絞る。
    // ⚠(review Minor #3) `from "@/lib/(api-helpers|prisma|auth)"` は完全一致の
    //   specifier しか拾わず、将来 `from "@/lib/auth/options"` のようなサブパスが
    //   増えても見逃す。末尾に `/` か `"` のどちらかを許す。
    for (const rel of ["src/lib/edit-lock/header-names.ts", "src/lib/edit-lock/screen-token-client.ts"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).not.toMatch(/from "@\/lib\/(api-helpers|prisma|auth)["/]/);
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

/**
 * 6入口目(fix round1 Important #3)。
 *
 * ⚠この入口だけは「まだ配線していないこと」を**今日**固定する。Task 8が
 *   `corporate-lookup-panel.tsx` を配線した瞬間、このテストが赤くなる
 *   (=下のコメントに従って `ENTRYPOINT_CALL_SITES` へ追記し、この
 *   describe を消すか「配線済み」の検査に差し替える、という強制力を持つ)。
 *   コメントだけで「追記すること」と書いても誰も気づけない、というレビュー指摘への対応。
 */
describe("corporate-lookup-panel.tsx(6入口目・Task 8がまだ配線していない)", () => {
  it("⚠まだ editLockHeaders を通していない(Task 8がここを配線したらこのテストは赤くなる→上のENTRYPOINT_CALL_SITESへ追記して差し替えること)", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).not.toMatch(/\.\.\.editLockHeaders\(/);
  });
});
