import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 保存窓口を呼ぶ入口すべてが合言葉のヘッダを付ける(仕様 5.1・6.1)。
 * 1つでも付け忘れると、その入口からの保存だけが鍵をすり抜ける。
 *
 * ⚠**corporate-lookup-panel.tsx(6入口目)は Task 8 でここに合流した**。
 *   ヘッダの組み立て自体は `updateOwner` と同型で `api-client.ts` の
 *   `applyOwnerCorporate` が持つ(パネル自身は手組みしない)。下の
 *   `ENTRYPOINT_CALL_SITES` に `applyOwnerCorporate` の呼び出し箇所を追加し、
 *   パネル側は「受け取った lockId を取り違えずに渡しているか」を別の検査で固定する
 *   (`updateOwner`/`page.tsx` の関係と同じ形)。
 */
const ENTRYPOINTS = [
  "src/components/properties/property-edit-form.tsx",
  "src/app/(dashboard)/properties/[id]/page.tsx",
  "src/components/properties/registry-chiban-popup.tsx",
  "src/lib/api-client.ts",
  "src/components/owners/corporate-lookup-panel.tsx",
];

/**
 * 関数の**本体全体**を取り出す(review round2 Important C)。
 *
 * ⚠固定の文字数窓(`[\s\S]{0,400}?`)は、パラメータが1つ増える・コメントが1行
 *   増えるだけで、正しいコードのまま検査が赤くなる(実測: `runNoLockPropertyPatch`
 *   379/400・`runChibanSave` 390/400 しか余裕が無かった)。数を大きくする直しは
 *   「どこかに書いてあればOK」への逆戻りで、この走査を強くした意味が無くなる。
 *   代わりに、関数名の直後の `(` から**括弧の深さを数えて**引数リストの終わりを
 *   求め、その後で最初に現れる本体の `{` から**波括弧の深さを数えて**対応する
 *   `}` までを本体として切り出す(prettierの整形や引数の増減に左右されない)。
 * ⚠`updateOwner` の引数(`data: { note?: ...} & Record<...>`)のように型注釈へ
 *   `{}` が混じっていても、括弧(`()`)の対応だけで引数リストの終わりを決める
 *   ため誤動作しない(型注釈の `{}` は引数リストの終わり判定に関与しない)。
 */
function extractFunctionBody(src: string, nameOpenParen: RegExp): string {
  const nameMatch = nameOpenParen.exec(src);
  if (!nameMatch || !nameMatch[0].endsWith("(")) {
    throw new Error(`extractFunctionBody: nameOpenParen must match up to and including "(": ${nameOpenParen}`);
  }
  const start = nameMatch.index;
  let i = start + nameMatch[0].length; // "(" の直後
  let parenDepth = 1;
  while (i < src.length && parenDepth > 0) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") parenDepth--;
    i++;
  }
  // ここで i は引数リストの閉じ ")" の直後。戻り値の型注釈を挟んで本体の "{" へ。
  const braceStart = src.indexOf("{", i);
  if (braceStart === -1) return src.slice(start);
  let braceDepth = 1;
  let j = braceStart + 1;
  while (j < src.length && braceDepth > 0) {
    if (src[j] === "{") braceDepth++;
    else if (src[j] === "}") braceDepth--;
    j++;
  }
  return src.slice(start, j);
}

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
const ENTRYPOINT_CALL_SITES: { label: string; file: string; nameOpenParen: RegExp; headerCall: RegExp }[] = [
  {
    label: "物件の編集ウィンドウ(property-edit-form.tsx・buildPropertySaveInit)",
    file: "src/components/properties/property-edit-form.tsx",
    nameOpenParen: /export function buildPropertySaveInit\(/,
    headerCall: /\.\.\.editLockHeaders\(/,
  },
  {
    label: "案件ステータス・導入ルートのプルダウン(page.tsx・runNoLockPropertyPatch)",
    file: "src/app/(dashboard)/properties/[id]/page.tsx",
    nameOpenParen: /export async function runNoLockPropertyPatch\(/,
    headerCall: /\.\.\.editLockHeaders\(/,
  },
  {
    label: "地番ポップアップ(registry-chiban-popup.tsx・runChibanSave)",
    file: "src/components/properties/registry-chiban-popup.tsx",
    nameOpenParen: /export async function runChibanSave\(/,
    headerCall: /\.\.\.editLockHeaders\(/,
  },
  {
    label: "所有者カード(api-client.ts・updateOwner)",
    file: "src/lib/api-client.ts",
    nameOpenParen: /export async function updateOwner\(/,
    headerCall: /\.\.\.editLockHeaders\(opts\.lockId\)/,
  },
  {
    label: "法人番号の反映(api-client.ts・applyOwnerCorporate)",
    file: "src/lib/api-client.ts",
    nameOpenParen: /export async function applyOwnerCorporate\(/,
    headerCall: /\.\.\.editLockHeaders\(opts\.lockId\)/,
  },
];

describe("保存の入口(走査・呼び出し箇所ごと・本体全体を切り出して検査)", () => {
  for (const { label, file, nameOpenParen, headerCall } of ENTRYPOINT_CALL_SITES) {
    it(`${label} は呼び出し箇所自体で editLockHeaders を通している`, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
      // ⚠(review round3 Minor J) `expect(body).not.toBe("")` は
      //   extractFunctionBody が例外を投げるか非空の本体を返すかのどちらか
      //   でしか無いため、常に真になり何も検査していなかった。削除。
      const body = extractFunctionBody(src, nameOpenParen);
      expect(body).toMatch(headerCall);
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

  it("法人番号パネルの呼び出し元(corporate-lookup-panel.tsx)は受け取った lockId を applyOwnerCorporate の第3引数に渡す", () => {
    // ⚠これだけでは「ヘッダが付く」ことは固定できない(それは上の applyOwnerCorporate
    //   側の検査の役目)。ここで固定するのは、パネルが受け取ったprops(lockId)を
    //   取り違えずに渡していること(所有者カードの同種テストと同趣旨・二重の網)。
    // ⚠(review round1 Minor #6) ファイル全体に対する unbounded な
    //   `[\s\S]*?` は、第3引数が消えても後方の無関係な `{ lockId }` へ
    //   マッチが飛んで空振りし得る。`handleApply` の本体だけに検査範囲を
    //   絞る(=このファイルには他に `applyOwnerCorporate(` 呼び出しが無い)。
    const src = readFileSync(
      join(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const handleApplyBody = extractFunctionBody(src, /const handleApply = async \(/);
    expect(handleApplyBody).toMatch(/applyOwnerCorporate\(\s*ownerId,[\s\S]*?\{\s*lockId,?\s*\}/);
  });

  it("物件詳細の所有者カード内は CorporateLookupPanel にカードの世代(lock.lockId)を渡す", () => {
    // 案件ステータス・導入ルート等と同じく、鍵を持つ画面はカードの世代を渡す。
    // ⚠(review round1 Minor #5) 固定の文字数窓([\s\S]{0,900}?)は、この
    //   ファイルの他の箇所が数行増えるだけで正しいコードのまま赤くなる
    //   (実測691/900・四行の余裕しかない)。sibling の updateOwner 検査と
    //   同じ unbounded `[\s\S]*?` に揃える(このファイルには
    //   `<CorporateLookupPanel` が1箇所しか無いため、unboundedでも安全)。
    const src = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).toMatch(/<CorporateLookupPanel[\s\S]*?lockId=\{lock\.lockId\}/);
  });

  it("物件詳細の所有者カード内は CorporateLookupPanel の反映失敗をカードの鍵コントローラへ伝える(onLockRefused・review round1 Important #3)", () => {
    // ⚠これが無いと、管理者がカードの鍵を強制解除しても、パネルは断りの
    //   文言を出す一方でカードの帯・保存ボタンは「保持中」のまま食い違う。
    const src = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(src).toMatch(
      /<CorporateLookupPanel[\s\S]*?onLockRefused=\{\(code\) => lock\.noteSaveError\(code, null\)\}/,
    );
  });

  it("admin/owners/[id] は鍵を持たない入口なので CorporateLookupPanel に lockId も onLockRefused も渡さない", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/admin/owners/[id]/page.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const block = src.match(/<CorporateLookupPanel[\s\S]*?\/>/)?.[0];
    expect(block).toBeTruthy();
    expect(block).not.toMatch(/lockId=/);
    expect(block).not.toMatch(/onLockRefused=/);
  });

  it("法人番号パネル(corporate-lookup-panel.tsx・handleApply)は両方のcatch節で反映失敗をカードへ報告し、423の文言組み立てへ渡す(review round1 Important #1・#3)", () => {
    // ⚠(review round1 Important #1) この配線を固定しないと、
    //   `handleCorporateApplyEditLockedError(...)` 呼び出し自体を2箇所とも
    //   削除しても全テストが green のままになる(mutation で確認済み)。
    //   `handleApply` の本体全体を切り出して、両方の catch 節(submit()自体・
    //   conflict確認後のsubmit(true))で reportCorporateApplyLockRefusal →
    //   handleCorporateApplyEditLockedError の順に呼んでいることを固定する。
    const src = readFileSync(
      join(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const handleApplyBody = extractFunctionBody(src, /const handleApply = async \(/);
    expect(handleApplyBody).toMatch(
      /catch \(err\) \{[\s\S]*?reportCorporateApplyLockRefusal\(err, onLockRefused\);[\s\S]*?handleCorporateApplyEditLockedError\(err, ownerId, setApplyError, applySeqRef, mySeq\)/,
    );
    expect(handleApplyBody).toMatch(
      /catch \(err2\) \{[\s\S]*?reportCorporateApplyLockRefusal\(err2, onLockRefused\);[\s\S]*?handleCorporateApplyEditLockedError\(err2, ownerId, setApplyError, applySeqRef, mySeq\)/,
    );
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
