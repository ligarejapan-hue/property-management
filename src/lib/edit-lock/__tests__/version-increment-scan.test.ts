import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 物件・所有者の「編集で変える項目」を書く経路は、必ず版番号(version)を進める。
 * 進めない経路は、編集画面で変えられない項目だけを書くものに限り、ここに理由つきで
 * 載せる(仕様 5.4 / Task 9)。
 *
 * ⚠新しい書き込みを足したら、版番号を進めるか、この一覧に理由つきで足すかのどちらか。
 * 一覧の正本は `docs/superpowers/plans/2026-09-18-edit-lock-version-inventory.md`。
 * 表を更新したらこのテストの2つの Record にも同じ内容を写すこと(テストは
 * 「検出した箇所が1件残らず一覧にあるか」「一覧の行がまだそこにあるか」だけを
 * 機械的に見る。版番号を実際に進めているかどうかは、個別の振る舞いテストが見る)。
 */

/** 版番号を進める書き込み(人が編集できる項目を書く)。値は「何を書くか」の説明。 */
const VERSIONED: Record<string, string> = {
  "src/app/api/admin/owners/[id]/correction/address-fill/route.ts:275":
    "owner.address(空欄補完)+version increment",
  "src/app/api/admin/owners/[id]/correction/archive/route.ts:247":
    "owner.isArchived(アーカイブ)+version increment",
  "src/app/api/admin/owners/[id]/correction/contact-fix/route.ts:332":
    "owner の連絡先フィールド(動的 [field])+version increment",
  "src/app/api/admin/owners/[id]/correction/name-fix/route.ts:239":
    "owner.name(補正)+version increment",
  "src/app/api/admin/owners/[id]/correction/text-fix/route.ts:299":
    "owner の動的 [field]/currentZip+version increment",
  "src/app/api/admin/owners/[id]/registry-address-cleanup/route.ts:168":
    "owner.address(登記文字列除去)+version increment",
  "src/app/api/admin/owners/correction/corporate-number-bulk-apply/route.ts:124":
    "owner.corporateNumber(空欄埋め)+version increment",
  "src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:135":
    "owner.name(断片型の救出)+version increment",
  "src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:208":
    "owner.name/corporateNumber/companyRegistryNumber/address(分断型復元)+version increment",
  "src/app/api/admin/owners/correction/merge/route.ts:638":
    "owner.isArchived(統合で消えるsource)+version increment",
  "src/app/api/admin/owners/correction/merge/route.ts:664":
    "owner.currentAddress/currentZip(master引き継ぎ)+version increment",
  "src/app/api/admin/owners/correction/mislink/route.ts:518":
    "owner の version のみ進める(所有者付け替えのinvalidation)",
  "src/app/api/admin/owners/correction/mislink/route.ts:531":
    "owner(target) の version のみ進める(付け替え先のinvalidation)",
  "src/app/api/admin/owners/correction/mislink/route.ts:545":
    "property の version のみ進める(付け替えのinvalidation)",
  "src/app/api/import/csv/route.ts:750":
    "property の UPDATABLE_PROPERTY_FIELDS(CSV重複更新)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/jobs/[jobId]/rollback/route.ts:502":
    "property の RESTORABLE_PROPERTY_FIELDS(ロールバック復元)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:302":
    "owner の住所ペア空欄補完(fieldPatch)+version increment",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:344":
    "property.lotNumber/buildingNumber(空欄補完)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts:214":
    "owner の住所ペア空欄補完(fieldPatch)+version increment",
  "src/app/api/import/reception-owner/route.ts:354":
    "property.lotNumber/buildingNumber/roomNo(空欄補完)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/reception-owner/route.ts:405":
    "property.dmStatus(hold→send昇格)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/reception-owner/route.ts:629":
    "owner の住所ペア空欄補完(fieldPatch)+version increment",
  "src/app/api/import/reception-owner/route.ts:686":
    "owner.corporateNumber(空欄埋め)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/import/reception-owner/route.ts:698":
    "owner.corporateNumber/companyRegistryNumber(分断型復元の空欄埋め)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/owners/[id]/corporate-apply/route.ts:368":
    "owner の法人番号適用フィールド(編集画面の保存窓口)+version increment",
  "src/app/api/owners/[id]/corporate-cleanup/route.ts:248":
    "owner.name/address/note/corporateNumber(クリーンアップ適用)+version increment",
  "src/app/api/owners/[id]/route.ts:213":
    "owner の編集画面フィールド一式(編集画面の本体保存窓口)+version increment",
  "src/app/api/properties/[id]/actions/route.ts:157":
    "property のアクション実行結果フィールド(assign_to_me等)+version increment",
  "src/app/api/properties/[id]/clear-dm-undeliverable/route.ts:64":
    "restoreDmStatus 指定時のみ property.dmStatus+version increment" +
    "(Task 9で修正: dmStatus書き戻し時に元は進めていなかった。" +
    "dmUndeliverableAtのみのクリアは対象外[ALLOWED]と同じ理由で進めない)",
  "src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts:276":
    "property.dmStatus(undeliverable連動のno_send昇格)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/app/api/properties/[id]/route.ts:366":
    "property の編集画面フィールド一式(編集画面の本体保存窓口)+version increment",
  "src/app/api/properties/bulk-update/route.ts:87":
    "property.caseStatus/registryStatus/dmStatus/assignedTo(一括更新)+version increment",
  "src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts:244":
    "property.dmStatus(宛先不明連動のno_send昇格)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/lib/investigation/fetch-investigation.ts:646":
    "property.zoningDistrict/buildingCoverageRatio/floorAreaRatio(調査確定の書き戻し)+version increment",
  "src/lib/registry-fetch/auto-fetch.ts:238":
    "property.registryStatus(scheduled解除=previousStatusへ戻す)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/lib/registry-fetch/auto-fetch.ts:4294":
    "property.registryStatus=scheduled(有料取得の予約)+version increment",
  "src/lib/registry-fetch/auto-fetch.ts:4509":
    "property.registryStatus=obtained(有料取得の確定)+version increment",
  "src/lib/registry-pdf/process.ts:198":
    "owner.corporateNumber(空欄補完・fillOwnerCorporateNumberIfUnlocked)+version increment" +
    "(Task 7で修正済)",
  "src/lib/registry-pdf/process.ts:830":
    "property.registryStatus/realEstateNumber/lotNumber/buildingNumber(取得状況前進+空欄補完)+version increment",
};

/**
 * 版番号を進めない書き込み。**編集画面で変えられない項目だけ**を書くものに限る。
 * `reason` = 書く項目 + なぜ編集画面から書けないと確認したか。
 * `keys` = 実際に `data:` へ許可する項目名(review Minor 4)。走査は「一覧にある」
 *   だけでなく「その `data:` の中身が `keys` の部分集合か」も確認する。ここに
 *   無いキーを書くよう変わったら、鍵を外すか version increment を足すかの
 *   判断をやり直すべきサイン。
 * `isComment: true` = 正規表現がコードコメントを誤検出したもの(実際の呼び出しが
 *   存在しない)。この場合 `keys` による payload 確認はできない(対象が無いため)。
 */
interface AllowedEntry {
  reason: string;
  keys?: readonly string[];
  isComment?: true;
}

const ALLOWED_WITHOUT_VERSION: Record<string, AllowedEntry> = {
  "src/app/api/admin/owners/correction/merge/route.ts:437": {
    reason: "owner.updatedAt のみ(行ロック獲得のための touch。updatedAt は編集画面の送信項目に無い)",
    keys: ["updatedAt"],
  },
  "src/app/api/admin/owners/correction/merge/route.ts:445": {
    reason: "owner.updatedAt のみ(同上・source側の行ロックtouch)",
    keys: ["updatedAt"],
  },
  "src/app/api/admin/owners/correction/mislink/route.ts:406": {
    reason: "owner.updatedAt のみ(行ロック獲得のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/admin/owners/correction/mislink/route.ts:435": {
    reason: "property.updatedAt のみ(行ロック獲得のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:262": {
    reason: "owner.updatedAt のみ(行ロック獲得のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts:180": {
    reason: "owner.updatedAt のみ(行ロック獲得のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/import/paste/commit/route.ts:406": {
    reason: "owner.updatedAt のみ(既存所有者へのリンク可否確認のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/import/reception-owner/route.ts:589": {
    reason: "owner.updatedAt のみ(行ロック獲得のための touch)",
    keys: ["updatedAt"],
  },
  "src/app/api/owners/[id]/memos/route.ts:241": {
    reason:
      "コメント内の記述(実際の呼び出しではない。owner.updateMany の使い方を説明する" +
      "コードコメントが正規表現に引っかかっただけ)",
    isComment: true,
  },
  "src/app/api/owners/[id]/memos/route.ts:252": {
    reason: "owner.updatedAt のみ(メモ作成のための行ロックtouch。owner本体は書かない)",
    keys: ["updatedAt"],
  },
  "src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts:303": {
    reason:
      "property.dmUndeliverableAt=null のみ(残数ゼロでの自動解除。dmUndeliverableAtは" +
      "PropertyEditForm の FORM_FIELDS に無く編集画面から書けない)",
    keys: ["dmUndeliverableAt"],
  },
  "src/app/api/properties/[id]/dm-logs/[logId]/route.ts:102": {
    reason:
      "property.dmUndeliverableAt=null のみ(送付記録削除に伴う自動解除。同上の理由で" +
      "編集画面から書けない)",
    keys: ["dmUndeliverableAt"],
  },
  "src/app/api/properties/[id]/owners/route.ts:58": {
    reason: "owner.updatedAt のみ(所有者リンク時の行ロックtouch)",
    keys: ["updatedAt"],
  },
  "src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts:267": {
    reason:
      "property.dmUndeliverableAt=null のみ(訂正による自動解除。同上の理由で" +
      "編集画面から書けない)",
    keys: ["dmUndeliverableAt"],
  },
  "src/lib/registry-pdf/process.ts:296": {
    reason:
      "owner.updatedAt のみ(添付済み謄本からの反映で、候補の所有者を物件行より先に" +
      "id順で押さえる touch。ロック順を /owners 窓口と同じ Owner→物件 にそろえる)",
    keys: ["updatedAt"],
  },
  "src/lib/registry-pdf/process.ts:566": {
    reason:
      "owner.updatedAt のみ(ロック後の再探索で拾った所有者を、アーカイブされていない" +
      "条件で押さえる touch。押さえられなければ新規作成に回す)",
    keys: ["updatedAt"],
  },
  "src/lib/registry-pdf/process.ts:444": {
    reason: "owner.updatedAt のみ(既存所有者再利用時の行ロックtouch)",
    keys: ["updatedAt"],
  },
};

/**
 * 検出は**広めに**取る(@codex R6 P2 の教訓を踏襲)。Prisma の呼び方だけでなく、
 * 生SQL の UPDATE も拾う。検出した箇所は**1件残らず**一覧(VERSIONED /
 * ALLOWED_WITHOUT_VERSION)に載っていること、が合格条件。
 *
 * ⚠pure Node 実装(controller決定): grep/execSync は Git Bash 前提で
 * Windows ネイティブ環境と CI(ubuntu)で挙動が変わり得るため使わない。
 * `node:fs` でディレクトリを歩き、正規表現でマッチする行番号を集める。
 * CRLF は LF に正規化してから行分割する(手元 Windows と CI で行番号がずれない
 * ようにする。scan-test-crlf-normalization の教訓)。
 */
const WRITE_PATTERN =
  /\b(property|owner)\.(update|updateMany|upsert)\(|UPDATE\s+"?(properties|owners)"?/;

const EXCLUDE_DIRS = new Set(["__tests__", "generated", "node_modules"]);

/** review Minor 5: `.tsx` も対象にする(サーバコンポーネント/action に書き込みが
 *  生えても走査から隠れないように)。 */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...listSourceFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(full);
    }
  }
  return files;
}

/** 検出した書き込み箇所を `相対パス:行番号` の配列で返す(#テスト側の一覧のキーと同じ形)。 */
function writeSites(): string[] {
  const root = join(process.cwd(), "src");
  const sites: string[] = [];
  for (const file of listSourceFiles(root)) {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const rel = relative(process.cwd(), file).replace(/\\/g, "/");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (WRITE_PATTERN.test(lines[i])) {
        sites.push(`${rel}:${i + 1}`);
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// review Important 1: check 4 は「最も近い行」で increment を割り当てていたため、
// 間隔の狭い**別の書き込み**(別モデル・別呼び出し)の increment を誤って
// 自分のものとして拾えてしまい、fetch-investigation.ts:646 で実際に空振りした
// (削除しても検出できない)。line距離ではなく、**その呼び出し自身の引数の
// 括弧バランス**の中だけを見るように作り直す。
// ---------------------------------------------------------------------------

/**
 * `startIdx`(既に1つ開いた括弧の直後の位置)から、対応する閉じ括弧までの
 * 中身を返す。文字列リテラル・コメントの中の括弧は数えない。
 */
function extractBalancedSpan(
  text: string,
  startIdx: number,
  openChar: string,
  closeChar: string,
): string {
  let depth = 1;
  let i = startIdx;
  const n = text.length;
  while (i < n && depth > 0) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;
    i++;
  }
  return text.slice(startIdx, Math.max(startIdx, i - 1));
}

/**
 * `version: { increment: 1 }`(オブジェクトリテラル形)と `x.version = { increment: 1 }`
 * (代入形。properties/[id]/clear-dm-undeliverable/route.ts のように条件つきで data を
 * 組み立てる経路がこの形を使う)の両方を1つの正規表現で拾う。
 *
 * review Important 1 後半: このパターン自体は型注釈(`version: { increment: 1 };` を
 * 型として書いた場合も)に一致し得るが、下の `siteHasOwnVersionIncrement` は
 * **呼び出し自身の引数の中**、または `data` 変数の**初期化式(型注釈より後ろ)**
 * だけにこのパターンを適用するため、型注釈だけでは実行時の bump の証拠になれない
 * (`corporate-restore-apply/route.ts:181` の型注釈はこの経路では見ない)。
 */
const VERSION_INCREMENT_PATTERN = /version\s*[:=]\s*\{\s*increment:\s*1\s*\}/;

/** ファイル内容から絶対文字位置 -> (行, その行内オフセット) を作るための行頭オフセット表。 */
function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1); // +1 for the '\n' we split on
  }
  return offsets;
}

/**
 * `siteLine1Based` の呼び出し(`....update(`/`updateMany(`/`upsert(`)自身の
 * 引数括弧の中身を返す。呼び出し自体が見つからなければ null。
 *
 * ⚠review Important 1後半(Task 7レビュー Minor 9で持ち越し): `extractBalancedSpan`は
 * 正規表現リテラルの中の不釣り合いな括弧、正規表現の中の孤立したクォート、入れ子の
 * テンプレートリテラルを特別扱いしないため、稀にスパンが行き過ぎ(overrun)て
 * **後続の別の呼び出し**を自分の引数として取り込むことがある。抽出したスパンの中に
 * 別の `.update(`/`.updateMany(`/`.upsert(` が見つかったら、黙って通さず**ここで
 * 落ちる**(誤検出を握りつぶして「一致した」と誤判定するくらいなら、テストの失敗として
 * 気づけるほうが安全)。
 */
function callArgsSpanForSite(
  fullSrc: string,
  lines: string[],
  offsets: number[],
  siteLine1Based: number,
  contextLabel: string,
): string | null {
  const lineIdx = siteLine1Based - 1;
  const lineText = lines[lineIdx];
  const m = /\.(update|updateMany|upsert)\(/.exec(lineText);
  if (!m) return null;
  const openParenAbs = offsets[lineIdx] + m.index + m[0].length; // '(' の直後(既に depth=1)
  const span = extractBalancedSpan(fullSrc, openParenAbs, "(", ")");
  if (/\.(update|updateMany|upsert)\(/.test(span)) {
    throw new Error(
      `${contextLabel}: 引数括弧の中に別の .update/.updateMany/.upsert( が見つかった。` +
        "extractBalancedSpan が正規表現リテラルの括弧や入れ子のテンプレートリテラルで" +
        "overrunしている可能性がある。手動で確認すること。",
    );
  }
  return span;
}

/**
 * 呼び出し引数の中の `data:` が**その場のオブジェクトリテラル**なら、そのキー集合を
 * 返す。`data` が裸の識別子(変数参照)なら null を返す(=このスパンだけでは判定
 * できない、呼び出し元で別の解決を試みる)。
 */
function inlineDataObjectSpan(callArgs: string): string | null {
  const m = /\bdata\s*:\s*\{/.exec(callArgs);
  if (!m) return null;
  const openBraceAbs = m.index + m[0].length;
  return extractBalancedSpan(callArgs, openBraceAbs, "{", "}");
}

/** 裸の `data` 識別子(`data,` / `data }` / `data: data`)を引数が参照しているか。 */
function referencesBareDataVariable(callArgs: string): boolean {
  return /\bdata\s*[,}]/.test(callArgs) && !/\bdata\s*:\s*\{/.test(callArgs);
}

/**
 * `const data`/`let data` 宣言から `siteLine1Based`(呼び出し行)までのテキストを
 * 集め、**型注釈より後ろ**(`"} = {"` より後ろ)だけを対象に version increment
 * (オブジェクトリテラル形・代入形どちらも)を探す。これにより型注釈
 * (`version: { increment: 1 };` を型として書いた場合)は対象外になる
 * (review Important 1 の「型注釈を証拠にしない」要求)。
 */
function resolveBareDataVariableHasIncrement(
  lines: string[],
  siteLine1Based: number,
): boolean {
  const siteIdx = siteLine1Based - 1;
  for (let j = siteIdx; j >= Math.max(0, siteIdx - 80); j--) {
    if (/\b(?:const|let)\s+data\b/.test(lines[j])) {
      const block = lines.slice(j, siteIdx + 1).join("\n");
      const splitIdx = block.indexOf("} = {");
      // 型注釈(`const data: { ... }`)と初期化式(`= { ... }`)の境目。
      // ⚠review Important 1後半(Task 7レビュー Minor 9で持ち越し): 境目
      // (`"} = {"`)が見つからないときは**false を返す**(以前はブロック全体
      // = 型注釈だけを見てしまい、`const data: { version: { increment: 1 } }`
      // のような型注釈だけの宣言を「実行時に version を進めている」と誤判定
      // できてしまった)。境目が無ければ「実行時の増分の証拠は無い」とみなす。
      if (splitIdx < 0) return false;
      const runtimePart = block.slice(splitIdx + 1);
      return VERSION_INCREMENT_PATTERN.test(runtimePart);
    }
  }
  return false;
}

/**
 * VERSIONED の1箇所が、実際に**自分自身の呼び出し**(または自分が参照する
 * `data` 変数の初期化式)の中で version increment を書いているかを確認する。
 * 行距離での近傍割当はしない(review Important 1): 呼び出し自身の括弧バランスの
 * 中だけを見るため、間隔の狭い別の書き込み(別モデル・別呼び出し)の increment を
 * 誤って拾うことがない。
 */
function siteHasOwnVersionIncrement(
  fullSrc: string,
  lines: string[],
  offsets: number[],
  siteLine1Based: number,
  contextLabel: string,
): boolean {
  const callArgs = callArgsSpanForSite(fullSrc, lines, offsets, siteLine1Based, contextLabel);
  if (callArgs === null) return false;
  if (VERSION_INCREMENT_PATTERN.test(callArgs)) return true;
  if (referencesBareDataVariable(callArgs)) {
    return resolveBareDataVariableHasIncrement(lines, siteLine1Based);
  }
  return false;
}

function findVersionedSitesMissingIncrement(): string[] {
  const missing: string[] = [];
  for (const key of Object.keys(VERSIONED)) {
    const idx = key.lastIndexOf(":");
    const file = key.slice(0, idx);
    const line = Number(key.slice(idx + 1));
    const full = join(process.cwd(), file);
    const fullSrc = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    const lines = fullSrc.split("\n");
    const offsets = lineStartOffsets(lines);
    if (!siteHasOwnVersionIncrement(fullSrc, lines, offsets, line, key)) {
      missing.push(key);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// review Minor 4: ALLOWED_WITHOUT_VERSION は「載っているか」しか見ておらず、
// 後からそのサイトの `data:` が編集可能フィールドを書くように変わっても何も
// 落ちない。サイト自身の `data:` オブジェクトのキーが、許可した `keys` の
// 部分集合であることまで確認する。
// ---------------------------------------------------------------------------

/** オブジェクトリテラルの中身から、トップレベルのキー名一覧を返す。 */
function extractTopLevelKeys(objInner: string): string[] {
  const parts = splitTopLevel(objInner, ",");
  const keys: string[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part || part.startsWith("...")) continue;
    const keyed = /^(?:"([^"]+)"|'([^']+)'|(\w+))\s*:/.exec(part);
    if (keyed) {
      keys.push(keyed[1] ?? keyed[2] ?? keyed[3]);
      continue;
    }
    const shorthand = /^(\w+)$/.exec(part);
    if (shorthand) keys.push(shorthand[1]);
  }
  return keys;
}

/** 深さ0のカンマだけで分割する(文字列リテラル・入れ子の括弧の中は無視)。 */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      current += text.slice(start, i);
      continue;
    }
    if ("{([".includes(ch)) depth++;
    else if ("})]".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * ALLOWED_WITHOUT_VERSION の各サイト(コメント誤検出を除く)について、実際の
 * `data:` オブジェクトのキーが登録済み `keys` の部分集合かを確認する。
 * 部分集合でなければ「サイト → 想定外に書いているキー」を返す。
 */
function findAllowlistedSitesWithUnexpectedKeys(): Array<{
  site: string;
  unexpected: string[];
}> {
  const offenders: Array<{ site: string; unexpected: string[] }> = [];
  for (const [key, entry] of Object.entries(ALLOWED_WITHOUT_VERSION)) {
    if (entry.isComment) continue;
    const idx = key.lastIndexOf(":");
    const file = key.slice(0, idx);
    const line = Number(key.slice(idx + 1));
    const full = join(process.cwd(), file);
    const fullSrc = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    const lines = fullSrc.split("\n");
    const offsets = lineStartOffsets(lines);
    const callArgs = callArgsSpanForSite(fullSrc, lines, offsets, line, key);
    if (callArgs === null) {
      offenders.push({ site: key, unexpected: ["<呼び出しを再抽出できない>"] });
      continue;
    }
    const dataSpan = inlineDataObjectSpan(callArgs);
    if (dataSpan === null) {
      // data が裸の変数参照など、この単純な抽出では判定できない形。
      // ALLOWED_WITHOUT_VERSION の現在の15件は全て `data: { ... }` の
      // インラインリテラルなので、ここに来ること自体が形の変化のサイン。
      offenders.push({
        site: key,
        unexpected: ["<data がインラインオブジェクトではない(形が変わった)>"],
      });
      continue;
    }
    const actualKeys = extractTopLevelKeys(dataSpan);
    const allowed = new Set(entry.keys ?? []);
    const unexpected = actualKeys.filter((k) => !allowed.has(k));
    if (unexpected.length > 0) {
      offenders.push({ site: key, unexpected });
    }
  }
  return offenders;
}

describe("版番号の走査(仕様5.4 / Task 9)", () => {
  it("物件・所有者を書き換える箇所は、1件残らず一覧に載っている", () => {
    const known = new Set([
      ...Object.keys(VERSIONED),
      ...Object.keys(ALLOWED_WITHOUT_VERSION),
    ]);
    const sites = writeSites();
    const unknown = sites.filter((k) => !known.has(k));
    expect(
      unknown,
      unknown.length > 0
        ? `新しい書き込み箇所が見つかった: ${unknown.join(", ")}\n` +
            "この箇所は version:{increment:1} を足すか、docs/superpowers/plans/" +
            "2026-09-18-edit-lock-version-inventory.md と version-increment-scan.test.ts の " +
            "VERSIONED / ALLOWED_WITHOUT_VERSION 両方に理由つきで追記すること。"
        : undefined,
    ).toEqual([]);
  });

  it("一覧に載っている行は、今もその場所に存在する(行のずれを検出する)", () => {
    const sites = new Set(writeSites());
    const known = [
      ...Object.keys(VERSIONED),
      ...Object.keys(ALLOWED_WITHOUT_VERSION),
    ];
    const stale = known.filter((k) => !sites.has(k));
    expect(
      stale,
      stale.length > 0
        ? `一覧の行が実際のコードからずれている: ${stale.join(", ")}\n` +
            "ファイルが編集されて行番号がずれたか、書き込み自体が消えた。" +
            "version-increment-scan.test.ts の一覧を実際の行番号に更新すること。"
        : undefined,
    ).toEqual([]);
  });

  it("検出パターン自体が空振りしていない(健全性の確認)", () => {
    // 現時点で 54 箇所(VERSIONED 39 + ALLOWED_WITHOUT_VERSION 15)を検出している。
    // 0件はパターン自体が壊れているサイン。
    expect(writeSites().length).toBeGreaterThanOrEqual(50);
  });

  it("VERSIONED に載っている箇所は、実際に version increment を書いている(中身の空振り検出)", () => {
    const missing = findVersionedSitesMissingIncrement();
    expect(
      missing,
      missing.length > 0
        ? `VERSIONED に載っているのに version:{increment:1} が見つからない: ${missing.join(", ")}\n` +
            "一覧への記載だけでは足りない。実際のコードから version increment が消えている" +
            "(退行)か、一覧の記載が誤り。"
        : undefined,
    ).toEqual([]);
  });

  it("ALLOWED_WITHOUT_VERSION の各サイトは、許可したキー以外を data に書いていない(review Minor 4)", () => {
    const offenders = findAllowlistedSitesWithUnexpectedKeys();
    expect(
      offenders,
      offenders.length > 0
        ? offenders
            .map(
              (o) =>
                `${o.site} が想定外のキー(${o.unexpected.join(", ")})を書くようになった。` +
                "version increment を足すか、inventory と ALLOWED_WITHOUT_VERSION.keys に理由つきで追記すること。",
            )
            .join("\n")
        : undefined,
    ).toEqual([]);
  });
});
