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
  "src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:132":
    "owner.name(断片型の救出)+version increment",
  "src/app/api/admin/owners/correction/corporate-restore-apply/route.ts:203":
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
  "src/app/api/import/jobs/[jobId]/rollback/route.ts:461":
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
  "src/lib/registry-fetch/auto-fetch.ts:235":
    "property.registryStatus(scheduled解除=previousStatusへ戻す)+version increment" +
    "(Task 9で修正: 元は進めていなかった)",
  "src/lib/registry-fetch/auto-fetch.ts:4291":
    "property.registryStatus=scheduled(有料取得の予約)+version increment",
  "src/lib/registry-fetch/auto-fetch.ts:4502":
    "property.registryStatus=obtained(有料取得の確定)+version increment",
  "src/lib/registry-pdf/process.ts:190":
    "owner.corporateNumber(空欄補完・fillOwnerCorporateNumberIfUnlocked)+version increment" +
    "(Task 7で修正済)",
  "src/lib/registry-pdf/process.ts:674":
    "property.registryStatus/realEstateNumber/lotNumber/buildingNumber(取得状況前進+空欄補完)+version increment",
};

/**
 * 版番号を進めない書き込み。**編集画面で変えられない項目だけ**を書くものに限る。
 * 値は理由(書く項目 + なぜ編集画面から書けないと確認したか)。
 */
const ALLOWED_WITHOUT_VERSION: Record<string, string> = {
  "src/app/api/admin/owners/correction/merge/route.ts:437":
    "owner.updatedAt のみ(行ロック獲得のための touch。updatedAt は編集画面の送信項目に無い)",
  "src/app/api/admin/owners/correction/merge/route.ts:445":
    "owner.updatedAt のみ(同上・source側の行ロックtouch)",
  "src/app/api/admin/owners/correction/mislink/route.ts:406":
    "owner.updatedAt のみ(行ロック獲得のための touch)",
  "src/app/api/admin/owners/correction/mislink/route.ts:435":
    "property.updatedAt のみ(行ロック獲得のための touch)",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route.ts:262":
    "owner.updatedAt のみ(行ロック獲得のための touch)",
  "src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts:180":
    "owner.updatedAt のみ(行ロック獲得のための touch)",
  "src/app/api/import/paste/commit/route.ts:406":
    "owner.updatedAt のみ(既存所有者へのリンク可否確認のための touch)",
  "src/app/api/import/reception-owner/route.ts:589":
    "owner.updatedAt のみ(行ロック獲得のための touch)",
  "src/app/api/owners/[id]/memos/route.ts:241":
    "コメント内の記述(実際の呼び出しではない。owner.updateMany の使い方を説明する" +
    "コードコメントが正規表現に引っかかっただけ)",
  "src/app/api/owners/[id]/memos/route.ts:252":
    "owner.updatedAt のみ(メモ作成のための行ロックtouch。owner本体は書かない)",
  "src/app/api/properties/[id]/dm-logs/[logId]/reaction/route.ts:303":
    "property.dmUndeliverableAt=null のみ(残数ゼロでの自動解除。dmUndeliverableAtは" +
    "PropertyEditForm の FORM_FIELDS に無く編集画面から書けない)",
  "src/app/api/properties/[id]/dm-logs/[logId]/route.ts:102":
    "property.dmUndeliverableAt=null のみ(送付記録削除に伴う自動解除。同上の理由で" +
    "編集画面から書けない)",
  "src/app/api/properties/[id]/owners/route.ts:58":
    "owner.updatedAt のみ(所有者リンク時の行ロックtouch)",
  "src/app/api/properties/sale-dm/drafts/[id]/outcome/route.ts:267":
    "property.dmUndeliverableAt=null のみ(訂正による自動解除。同上の理由で" +
    "編集画面から書けない)",
  "src/lib/registry-pdf/process.ts:361":
    "owner.updatedAt のみ(既存所有者再利用時の行ロックtouch)",
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

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** 検出した書き込み箇所を `相対パス:行番号` の配列で返す(#テスト側の一覧のキーと同じ形)。 */
function writeSites(): string[] {
  const root = join(process.cwd(), "src");
  const sites: string[] = [];
  for (const file of listTsFiles(root)) {
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

/**
 * `version: { increment: 1 }`(オブジェクトリテラル形)と `x.version = { increment: 1 }`
 * (代入形。properties/[id]/clear-dm-undeliverable/route.ts のように条件つきで data を
 * 組み立てる経路がこの形を使う)の両方を1つの正規表現で拾う。
 */
const VERSION_INCREMENT_PATTERN = /version\s*[:=]\s*\{\s*increment:\s*1\s*\}/;

/**
 * VERSIONED の各箇所が、実際に自分自身の呼び出しの近くで version increment を
 * 書いているかを確認する(名前だけの一覧では「載せたのに中身を書き忘れる」を
 * 防げないため)。
 *
 * 同じファイル内に複数の VERSIONED 箇所がある場合(例: mislink.ts の3箇所・
 * reception-owner.ts の複数箇所)、見つけた version increment の行を**最も近い
 * 呼び出し行**へ割り当てる(最近傍割当)。ある箇所の increment を消しても、
 * 近くの**別の箇所**の increment が誤って「自分のもの」として拾われないように
 * するため(単純な固定windowでの近傍探索だと、間隔の狭い箇所同士で誤検出が起きる)。
 *
 * 戻り値: increment が1つも割り当たらなかった VERSIONED キーの配列(=空なら健全)。
 */
function findVersionedSitesMissingIncrement(): string[] {
  const byFile = new Map<string, number[]>();
  for (const key of Object.keys(VERSIONED)) {
    const idx = key.lastIndexOf(":");
    const file = key.slice(0, idx);
    const line = Number(key.slice(idx + 1));
    const arr = byFile.get(file) ?? [];
    arr.push(line);
    byFile.set(file, arr);
  }

  const missing: string[] = [];
  for (const [file, siteLines] of byFile) {
    const full = join(process.cwd(), file);
    const src = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    const lines = src.split("\n");
    const incrementLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (VERSION_INCREMENT_PATTERN.test(lines[i])) incrementLines.push(i + 1);
    }

    const assignedCount = new Map<number, number>(siteLines.map((l) => [l, 0]));
    for (const incLine of incrementLines) {
      let best = siteLines[0];
      let bestDist = Math.abs(incLine - best);
      for (const s of siteLines) {
        const d = Math.abs(incLine - s);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      assignedCount.set(best, (assignedCount.get(best) ?? 0) + 1);
    }

    for (const s of siteLines) {
      if ((assignedCount.get(s) ?? 0) === 0) {
        missing.push(`${file}:${s}`);
      }
    }
  }
  return missing;
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
});
