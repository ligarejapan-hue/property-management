import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 保存窓口を呼ぶ入口すべてが合言葉のヘッダを付ける(仕様 5.1・6.1・8.3)。
 * 1つでも付け忘れると、その入口からの保存だけが鍵をすり抜ける。
 *
 * ⚠**ホワイトリストではなくスイープ**(横断レビュー I4)。修理前は既知5ファイル・
 *   5箇所を列挙しているだけで、明日6つ目の画面が `PATCH /api/properties/[id]` を
 *   素の fetch で叩いてもこのテストは緑のままだった=仕様8.3の「新しい入口が
 *   増えたら落ちる」を満たしていなかった。第1段の横断レビューが
 *   `cleanup-paths-scan.test.ts` に出した H5(「ホワイトリストではなくスイープに
 *   書き直せ」)と同型の指摘であり、同じ形に揃える:
 *   ① `src/` 全体を掃いて3つの窓口(method+URL)へ送る箇所を**全部**見つける
 *   ② 見つかった保存の箇所が1件残らず下の一覧(`KNOWN_SAVE_SITES`)に載っている
 *   ③ 一覧の各箇所が今も実在する(消えたら赤=行き場のない一覧を残さない)
 *   ④ 各箇所が実際にヘッダを通している
 *   ⑤ 検出パターン自体が空振りしていない(健全性)
 *
 * ⚠GET/DELETE は対象外(3つの窓口は method まで含めて定義される)。スイープが
 *   method を読んで自分で落とすので、一覧に「理由つきの除外」を書き足す必要は無い
 *   (= 除外が増えて形骸化する余地を作らない)。method が読めない呼び出し
 *   (init を別の関数が組み立てている等)は**保存とみなして**一覧を要求する
 *   (安全側に倒す)。
 */

const EXCLUDE_DIRS = new Set(["__tests__", "generated", "node_modules"]);

/** `cleanup-paths-scan.test.ts`/`version-increment-scan.test.ts` と同じ走査(.ts/.tsx)。 */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 鍵を見る3つの保存窓口(仕様 5.1)。**method まで含めて**1つの窓口とする。
 * ⚠URLの正規表現は末尾のバッククォートまで要求する=`/api/properties/${id}/photos`
 *   のような別の窓口に一致しない。
 */
const SAVE_ENDPOINTS: { label: string; method: string; url: RegExp }[] = [
  {
    label: "PATCH /api/properties/[id]",
    method: "PATCH",
    url: /`\/api\/properties\/\$\{[^}`]+\}`/g,
  },
  { label: "PATCH /api/owners/[id]", method: "PATCH", url: /`\/api\/owners\/\$\{[^}`]+\}`/g },
  {
    label: "POST /api/owners/[id]/corporate-apply",
    method: "POST",
    url: /`\/api\/owners\/\$\{[^}`]+\}\/corporate-apply`/g,
  },
];

/**
 * ヘッダの要求。
 * - `inCall`: 呼び出しの引数の中で(その場で)ヘッダを組み立てている
 * - `viaFunction`: init を別の関数が組み立てている(呼び出し側はその関数を通すだけ)。
 *   その関数の**本体**にヘッダの組み立てがあることまで確かめる。
 */
type HeaderRequirement = {
  inCall?: RegExp;
  viaFunction?: { calledAs: RegExp; nameOpenParen: RegExp; pattern: RegExp };
};

/**
 * 今日時点の保存の入口(**6入口=物件4+所有者カード1+法人番号の反映1**。
 * ただし窓口を叩く箇所は5つで、案件ステータスと導入ルートの2入口は
 * `runNoLockPropertyPatch` 1本を共有する)。
 * 鍵は `相対パス::窓口`(行番号は使わない=巨大なファイルの無関係な編集で
 * 赤くならないため)。同じファイル・同じ窓口へ2箇所目が増えたら、下の
 * 「1箇所ずつ」の検査が落ちる。
 */
const KNOWN_SAVE_SITES: Record<string, { label: string; headers: HeaderRequirement }> = {
  "src/components/properties/property-edit-form.tsx::PATCH /api/properties/[id]": {
    label: "物件の編集ウィンドウ(init は buildPropertySaveInit が組み立てる)",
    headers: {
      viaFunction: {
        calledAs: /buildPropertySaveInit\(/,
        nameOpenParen: /export function buildPropertySaveInit\(/,
        pattern: /\.\.\.editLockHeaders\(/,
      },
    },
  },
  "src/app/(dashboard)/properties/[id]/page.tsx::PATCH /api/properties/[id]": {
    label: "案件ステータス・導入ルートのプルダウン(runNoLockPropertyPatch)",
    headers: { inCall: /\.\.\.editLockHeaders\(/ },
  },
  "src/components/properties/registry-chiban-popup.tsx::PATCH /api/properties/[id]": {
    label: "地番ポップアップ(runChibanSave)",
    headers: { inCall: /\.\.\.editLockHeaders\(/ },
  },
  "src/lib/api-client.ts::PATCH /api/owners/[id]": {
    label: "所有者カード(updateOwner)",
    headers: { inCall: /\.\.\.editLockHeaders\(opts\.lockId\)/ },
  },
  "src/lib/api-client.ts::POST /api/owners/[id]/corporate-apply": {
    label: "法人番号の反映(applyOwnerCorporate)",
    headers: { inCall: /\.\.\.editLockHeaders\(opts\.lockId\)/ },
  },
};

/**
 * 文字列リテラル・コメントの中の括弧を数えない、対応の取れた範囲の切り出し
 * (`cleanup-paths-scan.test.ts` の `extractBalancedSpan` と同じ実装。走査テストは
 * 互いに独立したファイルとして意図的に重複させる)。
 */
function extractBalancedSpan(text: string, startIdx: number, openChar: string, closeChar: string): string {
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

/** `idx` を囲んでいる呼び出しの `(` の位置(見つからなければ -1)。 */
function enclosingCallOpenParen(src: string, idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** 引数リストの、深さ0のカンマで区切った**中身のある**区画の数。 */
function topLevelArgCount(span: string): number {
  let depth = 0;
  let current = "";
  const segments: string[] = [];
  for (let i = 0; i < span.length; i++) {
    const ch = span[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < span.length && span[i] !== quote) {
        if (span[i] === "\\") {
          current += span[i];
          i++;
        }
        current += span[i];
        i++;
      }
      current += span[i] ?? "";
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((s) => s.trim() !== "").length;
}

type SweptSite = { key: string; file: string; endpoint: string; method: string; callSpan: string };

/**
 * `src/` を掃き出して、3つの保存窓口へ送っている箇所を1件残らず返す
 * (ホワイトリストではなく、実際のパターンマッチで見つける)。
 * GET/DELETE は3つの窓口ではないので落とす。method が読めない呼び出しは
 * 保存とみなして残す(安全側)。
 */
function findSaveCallSites(): SweptSite[] {
  const root = join(process.cwd(), "src");
  const sites: SweptSite[] = [];
  for (const file of listSourceFiles(root)) {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const rel = relative(process.cwd(), file).replace(/\\/g, "/");
    for (const endpoint of SAVE_ENDPOINTS) {
      const re = new RegExp(endpoint.url.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const open = enclosingCallOpenParen(src, m.index);
        if (open === -1) continue; // 呼び出しの外(型注釈・文字列の説明等)
        const callSpan = extractBalancedSpan(src, open + 1, "(", ")");
        const explicit = /\bmethod\s*:\s*"([A-Z]+)"/.exec(callSpan);
        // 引数が1つだけ(= init を渡していない)なら GET。
        const method = explicit ? explicit[1] : topLevelArgCount(callSpan) <= 1 ? "GET" : "UNKNOWN";
        if (method !== endpoint.method && method !== "UNKNOWN") continue;
        sites.push({
          key: `${rel}::${endpoint.label}`,
          file: rel,
          endpoint: endpoint.label,
          method,
          callSpan,
        });
      }
    }
  }
  return sites;
}

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

function readSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
}

describe("保存の入口(仕様8.3・スイープ)", () => {
  it("3つの窓口へ送っている箇所は、1件残らず一覧に載っている(新しい入口が増えたら落ちる)", () => {
    const known = new Set(Object.keys(KNOWN_SAVE_SITES));
    const unknown = [...new Set(findSaveCallSites().filter((s) => !known.has(s.key)).map((s) => s.key))];
    expect(
      unknown,
      unknown.length > 0
        ? `新しい保存の入口が見つかった: ${unknown.join(", ")}\n` +
            "この入口は editLockHeaders() を通してヘッダを付け、KNOWN_SAVE_SITES に追記すること" +
            "(仕様5.1の入口の数も更新する)。"
        : undefined,
    ).toEqual([]);
  });

  it("一覧に載っている箇所は今も実在する(消えた入口の抜け殻を残さない)", () => {
    const found = new Set(findSaveCallSites().map((s) => s.key));
    const stale = Object.keys(KNOWN_SAVE_SITES).filter((k) => !found.has(k));
    expect(
      stale,
      stale.length > 0
        ? `一覧の入口が実際のコードに無い: ${stale.join(", ")}\n` +
            "入口が消えた/URLの組み立て方が変わった。どちらか確かめて一覧を直すこと。"
        : undefined,
    ).toEqual([]);
  });

  it("同じファイル・同じ窓口への保存は1箇所ずつ(2箇所目が増えたら気づく)", () => {
    // ⚠鍵に行番号を使わない代わりの網。同じファイルの中に2本目の保存が生えても、
    //   上の「一覧に載っているか」だけでは新しい鍵が作られず素通りしてしまう。
    const counts = new Map<string, number>();
    for (const site of findSaveCallSites()) counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
    expect(
      duplicated.map(([k, n]) => `${k}(${n}箇所)`),
      duplicated.length > 0
        ? "同じファイルに同じ窓口への保存が2箇所以上ある。それぞれがヘッダを通しているか個別に確かめ、" +
            "この走査の鍵の付け方(ファイル::窓口)を見直すこと。"
        : undefined,
    ).toEqual([]);
  });

  it("検出パターン自体が空振りしていない(健全性の確認)", () => {
    // 今日時点で5箇所(物件3+所有者1+法人番号1)。0件はパターンが壊れたサイン。
    expect(findSaveCallSites().length).toBeGreaterThanOrEqual(5);
  });

  for (const [key, { label, headers }] of Object.entries(KNOWN_SAVE_SITES)) {
    it(`${label} はヘッダを editLockHeaders 経由で付けている(${key})`, () => {
      const sites = findSaveCallSites().filter((s) => s.key === key);
      expect(sites.length, `${key} がスイープで見つからない`).toBeGreaterThan(0);
      for (const site of sites) {
        if (headers.inCall) {
          expect(site.callSpan, `${key}: 呼び出しの中でヘッダを組み立てていない`).toMatch(
            headers.inCall,
          );
        }
        if (headers.viaFunction) {
          const { calledAs, nameOpenParen, pattern } = headers.viaFunction;
          // 呼び出し側が本当にその組み立て関数を通していること。
          expect(site.callSpan, `${key}: init の組み立て関数を通していない`).toMatch(calledAs);
          // その組み立て関数の本体が、実際にヘッダを組み立てていること。
          const body = extractFunctionBody(readSource(site.file), nameOpenParen);
          expect(body, `${key}: 組み立て関数の本体にヘッダの組み立てが無い`).toMatch(pattern);
        }
      }
    });
  }

  it("所有者カードの呼び出し元(page.tsx)は取得できた lockId を updateOwner の第3引数に渡す", () => {
    // ⚠これだけでは「ヘッダが付く」ことは固定できない(それは上の updateOwner 側の
    //   検査の役目)。ここで固定するのは、呼び出し元が世代(lockId)を取り違えずに
    //   渡していること(owner-card-edit-lock.test.tsxの走査と同趣旨・二重の網)。
    const src = readSource("src/app/(dashboard)/properties/[id]/page.tsx");
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
    const src = readSource("src/components/owners/corporate-lookup-panel.tsx");
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
    const src = readSource("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toMatch(/<CorporateLookupPanel[\s\S]*?lockId=\{lock\.lockId\}/);
  });

  it("物件詳細の所有者カード内は CorporateLookupPanel の反映失敗をカードの鍵コントローラへ伝える(onLockRefused・review round1 Important #3)", () => {
    // ⚠これが無いと、管理者がカードの鍵を強制解除しても、パネルは断りの
    //   文言を出す一方でカードの帯・保存ボタンは「保持中」のまま食い違う。
    const src = readSource("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toMatch(
      /<CorporateLookupPanel[\s\S]*?onLockRefused=\{\(code\) => lock\.noteSaveError\(code, null\)\}/,
    );
  });

  it("物件詳細の所有者カード内は、カードの保存ボタンと同じ判断(canSubmitSave)で反映ボタンを止める(外部レビューP2 round6)", () => {
    // ⚠lockId を渡すだけでは、鍵が期限切れ/管理者に外された後も反映ボタンが押せ、
    //   lockId=null で送られてしまう(カードの保存ボタンは閉じ、帯は「保存できません」)。
    const src = readSource("src/app/(dashboard)/properties/[id]/page.tsx");
    expect(src).toMatch(
      /<CorporateLookupPanel[\s\S]*?applyBlocked=\{\s*!canSubmitSave\(\{\s*tokenReady: editLockTokenReady,\s*canSave: lock\.canSave,\s*saving,\s*lockUnavailable,\s*stateKind: lock\.state\.kind,?\s*\}\)\s*\}/,
    );
  });

  it("法人番号パネルは applyBlocked の間は反映ボタンを押せない(既定は false=管理画面は従来どおり)", () => {
    const src = readSource("src/components/owners/corporate-lookup-panel.tsx");
    expect(src).toMatch(/applyBlocked = false,/);
    expect(src).toMatch(/const applyButtonEnabled =\s*!applyBlocked &&/);
  });

  it("admin/owners/[id] は鍵を持たない入口なので CorporateLookupPanel に lockId も onLockRefused も渡さない", () => {
    const src = readSource("src/app/(dashboard)/admin/owners/[id]/page.tsx");
    const block = src.match(/<CorporateLookupPanel[\s\S]*?\/>/)?.[0];
    expect(block).toBeTruthy();
    expect(block).not.toMatch(/lockId=/);
    expect(block).not.toMatch(/onLockRefused=/);
    expect(block).not.toMatch(/applyBlocked=/);
  });

  it("法人番号パネル(corporate-lookup-panel.tsx・handleApply)は両方のcatch節で423の文言組み立てを先に確定させてからカードへ報告する(review round1 Important #1・round2 Minor #4)", () => {
    // ⚠(review round1 Important #1) この配線を固定しないと、
    //   `handleCorporateApplyEditLockedError(...)` 呼び出し自体を2箇所とも
    //   削除しても全テストが green のままになる(mutation で確認済み)。
    //   `handleApply` の本体全体を切り出して、両方の catch 節(submit()自体・
    //   conflict確認後のsubmit(true))で handleCorporateApplyEditLockedError →
    //   reportCorporateApplyLockRefusal の順(round2 Minor #4=このパネル自身の
    //   表示を先に確定させてから、外部のonLockRefusedコールバックへ報告する)に
    //   呼んでいることを固定する。
    const src = readSource("src/components/owners/corporate-lookup-panel.tsx");
    const handleApplyBody = extractFunctionBody(src, /const handleApply = async \(/);
    expect(handleApplyBody).toMatch(
      /catch \(err\) \{[\s\S]*?handleCorporateApplyEditLockedError\(err, ownerId, setApplyError, applySeqRef, mySeq\)[\s\S]*?reportCorporateApplyLockRefusal\(err, lockId, onLockRefused\)/,
    );
    expect(handleApplyBody).toMatch(
      /catch \(err2\) \{[\s\S]*?handleCorporateApplyEditLockedError\(err2, ownerId, setApplyError, applySeqRef, mySeq\)[\s\S]*?reportCorporateApplyLockRefusal\(err2, lockId, onLockRefused\)/,
    );
    // ⚠(review round3 New Important 7) 上のordering正規表現は「err/err2のcatch節の
    //   どこかに1回でもこの順で現れれば」満たされてしまう。実際には各catch節の
    //   中に呼び出し箇所が2箇所ずつ(計4箇所)ある——outer catchは
    //   ①`if (handled) {...}`内(ほぼ死んでいる。lockIdを送ったこの入口では
    //   EDIT_LOCKEDがほぼ届かないためhandled=trueに滅多にならない)と
    //   ②msg.includesの分岐すべてを終えた直後・finallyの手前(EDIT_LOCK_STALE/
    //   EDIT_LOCK_FORCE_RELEASEDが実際に通る=round1 Important #3の実体そのもの)。
    //   後者だけを削除しても、上のordering正規表現は①の出現だけで満たされ続け、
    //   全テストがgreenのままになる(mutationで確認済み)。4箇所すべてが揃って
    //   いることを出現回数で固定し、どの1箇所が消えても検査が落ちるようにする。
    expect((handleApplyBody.match(/reportCorporateApplyLockRefusal\(/g) ?? []).length).toBe(4);
  });

  it("法人番号パネル(corporate-lookup-panel.tsx・handleApply)は反映の試行ごとに世代を1回だけ進める(review round2 New Important #1)", () => {
    // ⚠(review round2 New Important #1) Minor #7の直しでこの採番が
    //   handleCorporateApplyEditLockedError(テスト対象)の外、handleApply
    //   (未テストのコンポーネントコード)へ移った結果、`++applySeqRef.current`を
    //   `applySeqRef.current`(採番しない)に変えても全29テストがgreenのまま
    //   だった(mutationで確認済み・テスト側が呼び出し元の採番を自分で模して
    //   いるため、production側の採番自体は検査されていなかった)。1行のsource
    //   assertionで、この採番の呼び出し元における実装を固定する。
    const src = readSource("src/components/owners/corporate-lookup-panel.tsx");
    const handleApplyBody = extractFunctionBody(src, /const handleApply = async \(/);
    expect(handleApplyBody).toMatch(/const mySeq = \+\+applySeqRef\.current;/);
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
      expect(readSource(rel)).not.toMatch(/from "@\/lib\/(api-helpers|prisma|auth)["/]/);
    }
  });

  it("client の部品は server 用の screen-token.ts を import しない", () => {
    // ⚠検査の対象は**スイープで見つかった入口のファイル**+鍵の2つの hook。
    //   入口の一覧を手で書き写さない(増えたら自動で対象になる)。
    const entrypointFiles = [...new Set(findSaveCallSites().map((s) => s.file))];
    const targets = [
      ...entrypointFiles,
      "src/components/owners/corporate-lookup-panel.tsx",
      "src/hooks/use-edit-lock.ts",
      "src/hooks/use-edit-lock-status.ts",
    ];
    expect(targets.length).toBeGreaterThanOrEqual(7);
    for (const rel of targets) {
      expect(readSource(rel), rel).not.toMatch(/from "@\/lib\/edit-lock\/screen-token"/);
    }
  });

  /**
   * 横断レビュー I5。このブランチは同じ規則を2回破って2回直している
   * (Task 6 fix #3 = `canSubmitSave`/`shouldShowLockUnavailableNotice` を
   * `property-edit-form.tsx` から外へ・Task 7 round2 B = `formatSince` を
   * `edit-lock-banner.tsx` から外へ)。にもかかわらずラチェットが無かった。
   *
   * `src/lib/**` の判断層が component モジュール("use client"・`ui/button`・
   * `api-client` 等を引き込む)を import すると、そのモジュールを使う無関係な
   * 画面(例: 地番ポップアップ)まで一式を巻き込む。実測で今日時点の違反は
   * ゼロなので、この5行が今日から効くラチェットになる。
   */
  it("(I5) src/lib の下のモジュールは @/components を import しない(判断層と部品の境界)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), "src/lib"))) {
      const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (/from\s+["']@\/components\//.test(src)) {
        offenders.push(relative(process.cwd(), file).replace(/\\/g, "/"));
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `src/lib から @/components を import している: ${offenders.join(", ")}\n` +
            "判断層(純関数)は component モジュールを引かない。必要な純関数は src/lib 側へ移し、" +
            "component からは re-export すること(Task 6 fix #3・Task 7 round2 B と同じ直し方)。"
        : undefined,
    ).toEqual([]);
  });
});
