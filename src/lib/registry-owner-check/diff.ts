/**
 * 謄本の名義の確認: どこが違うかを見せる(ピュア・2026-11-09 発注者依頼)。
 *
 * - 似ている人どうしを組にする(名前の似ている度合い)。組にならない人は相手を空欄にする
 * - 組の中で、違う文字だけに印を付ける(全角半角・空白の違いは印にしない)
 * - 物件ごとの違いの種類(漢字の違い・法人の書き方の違い・人数が違う・別の人)
 *
 * ⚠判定(同じ/違う)は compare.ts のまま。ここは見せ方だけで、判定には使わない。
 * ⚠保存してよいのは `stored`(種類の記号と人数)だけ。氏名・違う字は保存しない。
 */
import { normalizeName as importNormalizeName } from "@/lib/normalize";
import { foldNameVariants } from "@/lib/deals/crosscheck";
import { hasPrivateUseChar, isPrivateUseChar, stripPrivateUse } from "@/lib/private-use-char";

export interface Segment {
  text: string;
  /** 相手に無い文字 */
  diff: boolean;
}

/** 1文字ずつ比べる形(全角半角・大文字小文字をそろえる)。空白は比べない。 */
const charKey = (c: string) => c.normalize("NFKC").toLowerCase();
const isSpace = (c: string) => /^\s$/u.test(c.normalize("NFKC"));
/** 同じ字か。謄本の外字(私用領域)はどの字とも一致しない=いつも印を付ける(2026-11-11)。 */
const charEq = (a: string, b: string) => !isPrivateUseChar(a) && charKey(a) === charKey(b);

type Op = { kind: "eq" | "del" | "ins"; a?: number; b?: number };

/** 空白を除いた文字の並びの、一番長い共通部分で、違う所を探す。 */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = charEq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (charEq(a[i], b[j])) {
      ops.push({ kind: "eq", a: i++, b: j++ });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", a: i++ });
    } else {
      ops.push({ kind: "ins", b: j++ });
    }
  }
  while (i < n) ops.push({ kind: "del", a: i++ });
  while (j < m) ops.push({ kind: "ins", b: j++ });
  return ops;
}

function lcsLength(a: string, b: string): number {
  return diffOps([...a], [...b]).filter((o) => o.kind === "eq").length;
}

/** 文字の並びに、違う文字の印を付けて、続いた同じ印をまとめる。 */
function toSegments(chars: string[], diffAt: Set<number>): Segment[] {
  const out: Segment[] = [];
  chars.forEach((c, i) => {
    // 空白は比べない=印を付けない
    const diff = !isSpace(c) && diffAt.has(i);
    const last = out.at(-1);
    if (last && last.diff === diff) last.text += c;
    else out.push({ text: c, diff });
  });
  return out;
}

interface Hunk {
  a: string;
  b: string;
}

function diffWithHunks(a: string, b: string): { a: Segment[]; b: Segment[]; hunks: Hunk[] } {
  const ac = [...a];
  const bc = [...b];
  const ai = ac.map((_, i) => i).filter((i) => !isSpace(ac[i]));
  const bi = bc.map((_, i) => i).filter((i) => !isSpace(bc[i]));
  const ops = diffOps(
    ai.map((i) => ac[i]),
    bi.map((i) => bc[i]),
  );
  const aDiff = new Set<number>();
  const bDiff = new Set<number>();
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === "eq") {
      if (cur) hunks.push(cur);
      cur = null;
      continue;
    }
    cur ??= { a: "", b: "" };
    if (op.kind === "del") {
      aDiff.add(ai[op.a!]);
      cur.a += ac[ai[op.a!]];
    } else {
      bDiff.add(bi[op.b!]);
      cur.b += bc[bi[op.b!]];
    }
  }
  if (cur) hunks.push(cur);
  return { a: toSegments(ac, aDiff), b: toSegments(bc, bDiff), hunks };
}

/** 2つの文字列を比べ、それぞれの違う文字に印を付ける(住所にも使う)。 */
export function diffChars(a: string, b: string): { a: Segment[]; b: Segment[] } {
  const { a: sa, b: sb } = diffWithHunks(a, b);
  return { a: sa, b: sb };
}

// ---------- 法人の書き方 ----------

const CORP_WORDS = /株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|\(有\)|\(同\)|\(資\)|\(名\)/g;
const CORP_CANON: Record<string, string> = {
  "(株)": "株式会社",
  "(有)": "有限会社",
  "(同)": "合同会社",
  "(資)": "合資会社",
  "(名)": "合名会社",
};

/** 法人の言葉を除いた名前(NFKC・空白なし・小文字)。 */
function coreName(name: string): string {
  return importNormalizeName(name).toLowerCase().replace(CORP_WORDS, "");
}

/** 法人の言葉と、前に付くか後ろに付くか。 */
function corpSignature(name: string): string {
  const s = importNormalizeName(name).toLowerCase();
  const out: string[] = [];
  for (const m of s.matchAll(CORP_WORDS)) {
    out.push(`${m.index === 0 ? "前" : "後"}${CORP_CANON[m[0]] ?? m[0]}`);
  }
  return out.join(",");
}

// ---------- 組にする ----------

/** 名前の似ている度合い(0〜1)。法人の言葉と異体字をそろえて比べる。 */
function similarity(a: string, b: string): number {
  const ka = foldNameVariants(coreName(a)) || foldNameVariants(a);
  const kb = foldNameVariants(coreName(b)) || foldNameVariants(b);
  if (!ka || !kb) return 0;
  return (2 * lcsLength(ka, kb)) / ([...ka].length + [...kb].length);
}

/** これより似ていなければ、別の人として組にしない。 */
const PAIR_THRESHOLD = 0.5;

export type PairKind = "gaiji" | "kanji" | "corp" | "partial";

export interface OwnerDiffRow {
  systemIndex: number | null;
  registryIndex: number | null;
  status: "same" | "differs" | "system_only" | "registry_only";
  /** 組の違いの種類(differs のときだけ) */
  pairKinds: PairKind[];
  /** 謄本の字／システムの字(漢字の違いのとき) */
  kanjiPairs: string[];
  system: Segment[] | null;
  registry: Segment[] | null;
}

/** 「✓ 同じ」の線(取込と同じそろえ方)。外字を含む名前はどれとも同じにしない(2026-11-11)。 */
const sameName = (a: string, b: string) =>
  !hasPrivateUseChar(a) && !hasPrivateUseChar(b) && importNormalizeName(a) === importNormalizeName(b);

const isHan = (s: string) => s.length > 0 && /^\p{Script=Han}+$/u.test(s);
/**
 * 漢字1字と1字の入れ替わり(髙／高・﨑／崎 など)。2字以上が替わる(佐藤／鈴木・太郎／花子)のは
 * 字体の違いではなく別の名前=「名前の一部が違う」(2026-11-10・自動の登録で別人を足すため)。
 */
const isOneHanChar = (s: string) => isHan(s) && [...s].length === 1;

function classifyPair(systemName: string, registryName: string): Pick<OwnerDiffRow, "pairKinds" | "kanjiPairs"> {
  const kinds: PairKind[] = [];
  const kanjiPairs: string[] = [];
  const coreSys = coreName(systemName);
  const coreReg = coreName(registryName);
  // 謄本の外字(私用領域)=どの字か分からない。外字が替わっただけの所は「外字を含む」だけにし、
  // ほかに違う所があれば今までどおり種類を足す(2026-11-11)。
  const gaiji = hasPrivateUseChar(systemName) || hasPrivateUseChar(registryName);
  if (gaiji) kinds.push("gaiji");
  if (coreSys !== coreReg || gaiji) {
    const hunks = diffWithHunks(coreReg, coreSys).hunks.flatMap((h) => {
      if (!gaiji) return [h];
      const a = stripPrivateUse(h.a);
      const b = stripPrivateUse(h.b);
      const puaA = [...h.a].length - [...a].length;
      const puaB = [...h.b].length - [...b].length;
      // 外字が普通の字(同じ数まで)に替わっただけ=外字の違いで説明できる
      if ((a === "" && [...b].length <= puaA) || (b === "" && [...a].length <= puaB)) return [];
      return [{ a, b }];
    });
    const onlyGaiji = gaiji && hunks.length === 0;
    if (!onlyGaiji && hunks.length > 0 && hunks.every((h) => isOneHanChar(h.a) && isOneHanChar(h.b))) {
      kinds.push("kanji");
      for (const h of hunks) {
        const label = `${h.a}／${h.b}`;
        if (!kanjiPairs.includes(label)) kanjiPairs.push(label);
      }
    } else if (!onlyGaiji) {
      kinds.push("partial");
    }
  }
  if (corpSignature(systemName) !== corpSignature(registryName)) kinds.push("corp");
  // 法人の言葉も名前の字も同じなのに違う(大文字小文字など)=一部が違う
  if (kinds.length === 0) kinds.push("partial");
  return { pairKinds: kinds, kanjiPairs };
}

// ---------- 物件ごとの違いの種類 ----------

export type OwnerDiffCode = "kanji" | "corp" | "gaiji" | "partial" | "count" | "someone" | "different" | "other";

/**
 * 一覧で並べる順(小さいほど先)。物件の中で一番大きいものを使う。
 * ⚠数は diff_rank に保存済み=今ある数は変えない(外字は「名前の一部が違う」と同じ重さ)。
 */
export const OWNER_DIFF_RANK: Readonly<Record<OwnerDiffCode, number>> = {
  kanji: 1,
  corp: 2,
  gaiji: 3,
  partial: 3,
  count: 4,
  someone: 5,
  different: 6,
  other: 7,
};

const BASE_LABEL: Readonly<Record<OwnerDiffCode, string>> = {
  kanji: "漢字の違い",
  corp: "法人の書き方の違い",
  gaiji: "外字を含む（謄本の字が読めない）",
  partial: "名前の一部が違う",
  count: "人数が違う",
  someone: "一部が別の人（所有者が変わった可能性）",
  different: "別の人（所有者が変わった可能性）",
  other: "その他の違い",
};

const countLabel = (registry: number, system: number) => `人数が違う（謄本${registry}名・システム${system}名）`;

export interface OwnerDiffKind {
  code: OwnerDiffCode;
  label: string;
}

export interface OwnerDiffResult {
  rows: OwnerDiffRow[];
  /** 物件ごとの違いの種類(種類の順) */
  kinds: OwnerDiffKind[];
  /** 一覧で並べる値(一番重い種類) */
  rank: number;
  /** 保存する形(種類の記号と人数だけ・氏名や字は入れない) */
  stored: string;
}

const KANJI_PAIRS_SHOWN = 3;

/**
 * 謄本の名義とシステムの所有者を、組にして並べ、違いの種類を出す。
 * 並びはシステムの順(組になった人・システムだけの人)→謄本だけの人(謄本の順)。
 */
export function ownerDiff(registryNames: readonly string[], systemNames: readonly string[]): OwnerDiffResult {
  const sys = systemNames.map((n, i) => ({ n, i })).filter((x) => importNormalizeName(x.n).length > 0);
  const reg = registryNames.map((n, i) => ({ n, i })).filter((x) => importNormalizeName(x.n).length > 0);

  // 似ている度合いの高い組から順に決める(同じ度合いならシステム→謄本の並びの順)
  const cands: { s: number; r: number; score: number }[] = [];
  for (const s of sys) {
    for (const r of reg) {
      const exact = sameName(s.n, r.n);
      const score = exact ? 2 : similarity(s.n, r.n);
      if (score >= PAIR_THRESHOLD) cands.push({ s: s.i, r: r.i, score });
    }
  }
  // 同じ度合いなら、外字(私用領域)の無いシステムの人を先に組にする(2026-11-11 昼)。外字のまま
  // 入った人と普通の字の人が同じくらい似ていても、並び順で組の相手(=直しても残す人)が変わらないように。
  // 外字の無い物件では全員 0 なので、今までの順のまま。
  const sysGaiji = new Set(sys.filter((x) => hasPrivateUseChar(x.n)).map((x) => x.i));
  const g = (s: number) => (sysGaiji.has(s) ? 1 : 0);
  cands.sort((x, y) => y.score - x.score || g(x.s) - g(y.s) || x.s - y.s || x.r - y.r);
  const pairOfSys = new Map<number, number>();
  const usedReg = new Set<number>();
  for (const c of cands) {
    if (pairOfSys.has(c.s) || usedReg.has(c.r)) continue;
    pairOfSys.set(c.s, c.r);
    usedReg.add(c.r);
  }

  const rows: OwnerDiffRow[] = [];
  for (const s of sys) {
    const ri = pairOfSys.get(s.i);
    if (ri === undefined) {
      rows.push({
        systemIndex: s.i,
        registryIndex: null,
        status: "system_only",
        pairKinds: [],
        kanjiPairs: [],
        system: [{ text: s.n, diff: false }],
        registry: null,
      });
      continue;
    }
    const rn = registryNames[ri];
    if (sameName(s.n, rn)) {
      rows.push({
        systemIndex: s.i,
        registryIndex: ri,
        status: "same",
        pairKinds: [],
        kanjiPairs: [],
        system: [{ text: s.n, diff: false }],
        registry: [{ text: rn, diff: false }],
      });
      continue;
    }
    const d = diffChars(s.n, rn);
    rows.push({
      systemIndex: s.i,
      registryIndex: ri,
      status: "differs",
      ...classifyPair(s.n, rn),
      system: d.a,
      registry: d.b,
    });
  }
  for (const r of reg) {
    if (usedReg.has(r.i)) continue;
    rows.push({
      systemIndex: null,
      registryIndex: r.i,
      status: "registry_only",
      pairKinds: [],
      kanjiPairs: [],
      system: null,
      registry: [{ text: r.n, diff: false }],
    });
  }

  const codes = new Set<OwnerDiffCode>();
  const kanjiPairs: string[] = [];
  // 外字の人が組にならなくても(謄本だけ・システムだけ)、外字を含むことは種類に出す
  if ([...sys, ...reg].some((x) => hasPrivateUseChar(x.n))) codes.add("gaiji");
  for (const row of rows) {
    for (const k of row.pairKinds) codes.add(k);
    for (const p of row.kanjiPairs) if (!kanjiPairs.includes(p)) kanjiPairs.push(p);
  }
  const paired = rows.filter((r) => r.systemIndex !== null && r.registryIndex !== null).length;
  const unmatched = rows.length - paired;
  if (sys.length !== reg.length) codes.add("count");
  else if (unmatched > 0) codes.add(paired === 0 ? "different" : "someone");
  // 全員が別の人で人数も違う=人数の違いより「別の人」を先に見せる
  if (paired === 0 && sys.length > 0 && reg.length > 0) codes.add("different");

  const ordered = [...codes].sort((a, b) => OWNER_DIFF_RANK[a] - OWNER_DIFF_RANK[b]);
  const kinds: OwnerDiffKind[] = ordered.map((code) => ({
    code,
    label:
      code === "kanji" && kanjiPairs.length > 0
        ? `${BASE_LABEL.kanji}（${kanjiPairs.slice(0, KANJI_PAIRS_SHOWN).join("、")}${kanjiPairs.length > KANJI_PAIRS_SHOWN ? " ほか" : ""}）`
        : code === "count"
          ? countLabel(reg.length, sys.length)
          : BASE_LABEL[code],
  }));
  const storedCodes = ordered.length > 0 ? ordered : (["other"] as OwnerDiffCode[]);
  return {
    rows,
    kinds,
    rank: Math.max(...storedCodes.map((c) => OWNER_DIFF_RANK[c])),
    stored: storedCodes.map((c) => (c === "count" ? `count:${reg.length}:${sys.length}` : c)).join(","),
  };
}

/**
 * 保存した種類の末尾に付ける印=「謄本にだけいる人の自動の登録まで済んだ」(2026-11-10)。
 * 種類ではないので、一覧の文言には出さない。印の無い未判断の「違う」は比べ直しに回る。
 */
export const AUTO_ADD_DONE_TOKEN = "autoadd";

/**
 * 保存した種類に付ける印=「この謄本(所有者事項)から、登記上の記載(行ごとの住所と持分)の記録を
 * 試し終えた」(2026-11-12 第2回・発注者決定=DB に列を足さない)。
 * - 種類ではないので、一覧の文言には出さない。
 * - 「違う」以外の結果(同じ など)の行にも付く(その行は種類が無く、この印だけになる)。
 * - 印の無い行は比べ直しに回る=前に比べた物件も1回ずつ読み直して記録する。比べ直すと印が付くので
 *   1回だけ回る(行が1つも当たらない物件・読めない物件も、試し終えた印で止まる)。
 */
export const ENTRIES_DONE_TOKEN = "entries";

/** 保存した形から、一覧に出す文言に戻す(字は保存していないので出さない)。 */
export function ownerDiffLabelFromStored(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const tokens = stored
    .split(",")
    .filter((t) => t !== AUTO_ADD_DONE_TOKEN && t !== ENTRIES_DONE_TOKEN);
  if (tokens.length === 0) return null;
  return tokens
    .map((token) => {
      const [code, a, b] = token.split(":");
      if (code === "count" && a && b) return countLabel(Number(a), Number(b));
      return code in BASE_LABEL ? BASE_LABEL[code as OwnerDiffCode] : BASE_LABEL.other;
    })
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join("・");
}
