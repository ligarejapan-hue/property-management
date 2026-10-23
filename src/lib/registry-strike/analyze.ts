/**
 * 全部事項証明書の「権利部」を読み、**今も効力のある登記**だけを取り出す。
 *
 * 謄本の読み方（登記事項証明書の決まり。法務省「不動産登記記録例」の形に合わせる）:
 *   - 下線のある事項は抹消事項（＝もう効力がない）。証明書の欄外に
 *     「下線のあるものは抹消事項であることを示す。」と印字される。
 *   - 「N番○○抹消」の登記がされると、N番の事項に下線が引かれる
 *     （例: 乙区「2 1番根抵当権抹消」→ 乙区1番に下線）。抹消の登記そのものには下線は無い。
 *   - 付記登記（付記1号…）は、その順位番号の主登記にぶら下がり、主登記の内容を書き換える
 *     （登記名義人の住所・氏名の変更/更正、所有権更正、抵当権の移転・変更 など）。
 *     書き換えられた古い値には下線が引かれ、今の値は付記の欄にある。
 *     主登記が抹消されれば付記も効力を失う。
 *   - 仮登記の下の「余白」に本登記が記録されると、その順位で本登記の効力が生じる。
 *   - 共有の持分は「A持分全部移転」「A持分一部移転」「所有権一部移転」で動く。記録される
 *     「持分○分の○」は物件全体に対する割合。
 *   - 甲区＝所有権に関する事項、乙区＝所有権以外の権利（抵当権・根抵当権・賃借権など）。
 *   - 「相続人申告」は権利関係を公示するものではない（証明書の欄外の注記）。
 *
 * 下線の情報が無い入力（テキスト貼り付け）でも、「N番…抹消」の登記から対象を判定する。
 *
 * ⚠ 判断がつかない形（持分の合計が1にならない、名前が一致しない、抹消回復 など）は
 *   **推測で埋めず**、`notes` に「目視で確認してください」を出して所有者を返さない。
 * ⚠ 実物の謄本で確かめた形は「登記名義人住所変更」「根抵当権・仮登記の抹消」だけ（2026-10）。
 *   それ以外は登記記録例の形で組み立てている。
 * ⚠ 結果には氏名・住所が入る（画面の確認表示用）。ログ・AuditLog には出さないこと。
 */
import { joinSpacedKanji, toHalfWidthDigits } from "../registry-text-normalize";
import { hasAnyStrike, isFullyStruck, type StrikeLine } from "./lines";

export interface RegistryCurrentOwner {
  name: string;
  address: string | null;
  /** 共有のときの持分（例: "2分の1"）。単独所有は null */
  share: string | null;
}

export interface RegistryActiveRight {
  /** 順位番号（半角数字） */
  rank: string;
  /** 登記の目的（例: 抵当権設定 / 根抵当権設定） */
  purpose: string;
  /** 債権額 または 極度額（変更の付記があれば変更後） */
  amount: string | null;
  /** 抵当権者・根抵当権者・権利者など（移転の付記があれば移転後。一部移転は「、」区切り） */
  holder: string | null;
  /** 債務者（変更の付記があれば変更後。複数は「、」区切り） */
  debtor: string | null;
  /** この権利にぶら下がる、効力のある付記登記の件数 */
  activeAnnotations: number;
}

export interface RegistryCaution {
  section: "甲区" | "乙区";
  rank: string;
  purpose: string;
}

export interface RegistryRightsSummary {
  /** 下線（抹消の印）を1つでも読めたか。false でも「N番…抹消」からの判定は行う */
  underlineDetected: boolean;
  /** 権利部（甲区）を読めたか */
  hasKouku: boolean;
  /** 権利部（乙区）を読めたか（乙区が無い謄本もある） */
  hasOtsuku: boolean;
  /** 今の所有者（判断できないときは空。理由は notes） */
  currentOwners: RegistryCurrentOwner[];
  /** 今も残っている乙区の権利 */
  activeRights: RegistryActiveRight[];
  /** 差押え・仮登記など、残っていると取引に影響する登記 */
  cautions: RegistryCaution[];
  /** 抹消済みと判定した登記の件数（付記を含む） */
  cancelled: { kouku: number; otsuku: number };
  /** 表題部に変更前の記載（下線）がある */
  titleHasStruck: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// 表の読み取り
// ---------------------------------------------------------------------------

type Section = "title" | "kouku" | "otsuku" | "other";

interface Cell {
  text: string;
  struck: boolean[];
}

type EntryKind = "main" | "annotation" | "margin";

interface Entry {
  kind: EntryKind;
  /** 主登記の順位番号（付記・余白なら親の番号） */
  mainRank: string | null;
  /** 付記の番号（付記のときだけ） */
  annotation: string | null;
  purposeCells: Cell[];
  detailCells: Cell[];
  /** 表の中での並び順 */
  order: number;
}

const VERTICAL = new Set(["┃", "│"]);

function compact(s: string): string {
  return s.replace(/[\s　]/g, "");
}

/** 外字（私用領域）。実物では「余白」の枠がこの文字で描かれていた。 */
function stripPrivateUse(s: string): string {
  return s.replace(/[-]/g, "");
}

function sectionOf(line: string): Section | null {
  const c = compact(line);
  if (/^[┏┃]*共同担保目録|^[┏┃]*信託目録/.test(c)) return "other";
  if (c.includes("権利部") && c.includes("甲区")) return "kouku";
  if (c.includes("権利部") && c.includes("乙区")) return "otsuku";
  if (c.includes("表題部")) return "title";
  return null;
}

/** ┃…│…┃ の行をセル（文字＋下線の印）に分ける。罫線を含まない行は null。 */
function splitRow(line: StrikeLine): Cell[] | null {
  const chars = Array.from(line.text);
  const bounds: number[] = [];
  chars.forEach((ch, i) => {
    if (VERTICAL.has(ch)) bounds.push(i);
  });
  if (bounds.length < 2) return null;
  const cells: Cell[] = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const s = bounds[b] + 1;
    const e = bounds[b + 1];
    cells.push({ text: chars.slice(s, e).join(""), struck: line.struck.slice(s, e) });
  }
  return cells;
}

function isSeparator(line: string): "full" | "sub" | null {
  const t = line.trim();
  if (/^[┠┏┗┣]/.test(t)) return "full";
  // ┃ ├────… : 順位番号の欄は続き、その右から新しい登記（付記・余白）が始まる
  if (/^┃[\s　]*[├┝]/.test(t)) return "sub";
  return null;
}

/** 今の（下線の無い）文字だけを残す。 */
function currentText(cell: Cell): string {
  const chars = Array.from(cell.text);
  return chars.filter((_, i) => !cell.struck[i]).join("");
}

function clean(s: string): string {
  return joinSpacedKanji(s.replace(/　/g, " ").replace(/ {2,}/g, " ").trim());
}

function parseEntries(rows: StrikeLine[]): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let pendingSub = false;
  let lastMainRank: string | null = null;

  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };

  // ⚠ ページの変わり目では、表の下枠（┗）・上枠（┏）・見出しの行が入ることがあるが、
  //   登記はそのまま次のページへ続く。区切り線ですぐに登記を閉じず、次の中身の行を見て
  //   「ページをまたいだ続き」（順位番号も登記の目的も空）なら前の登記に足す。
  let pendingSep: "full" | "sub" | null = null;
  let crossedPage = false;
  let prevPage: number | null = null;

  for (const row of rows) {
    if (prevPage !== null && row.page !== prevPage) crossedPage = true;
    prevPage = row.page;

    const sep = isSeparator(row.text);
    if (sep) {
      pendingSep = sep;
      continue;
    }
    const cells = splitRow(row);
    if (!cells || cells.length < 4) continue;
    const [rankC, purposeC, , detailC] = cells;
    if (compact(rankC.text).includes("順位番号")) continue; // 見出し

    const isContinuation =
      cur !== null &&
      crossedPage &&
      compact(stripPrivateUse(rankC.text)) === "" &&
      compact(stripPrivateUse(purposeC.text)) === "";
    crossedPage = false;
    if (isContinuation) {
      pendingSep = null;
    } else if (pendingSep) {
      flush();
      pendingSub = pendingSep === "sub";
      pendingSep = null;
    }

    if (!cur) {
      const rankCell = toHalfWidthDigits(compact(rankC.text));
      let kind: EntryKind = "main";
      let mainRank: string | null = null;
      let annotation: string | null = null;
      const ann = rankCell.match(/^付記(\d+)号$/);
      if (/^\d+$/.test(rankCell)) {
        mainRank = rankCell;
        lastMainRank = rankCell;
      } else if (ann) {
        kind = "annotation";
        mainRank = lastMainRank;
        annotation = ann[1];
      } else if (pendingSub && rankCell === "") {
        // 順位番号の欄が空で、主登記の下に区切られた枠 = 余白（仮登記の本登記を書く欄）
        kind = "margin";
        mainRank = lastMainRank;
      }
      cur = { kind, mainRank, annotation, purposeCells: [], detailCells: [], order: entries.length };
    }
    cur.purposeCells.push(purposeC);
    cur.detailCells.push(detailC);
  }
  flush();
  return entries;
}

function purposeOf(e: Entry): string {
  const p = toHalfWidthDigits(compact(stripPrivateUse(e.purposeCells.map((c) => c.text).join(""))));
  return p === "余白" ? "" : p;
}

function purposeStruck(e: Entry): boolean {
  const joined: Cell = {
    text: e.purposeCells.map((c) => c.text).join(""),
    struck: e.purposeCells.flatMap((c) => c.struck),
  };
  return isFullyStruck(joined);
}

/**
 * 「N番(付記M号)…抹消」の登記なら、対象の番号をすべて返す。
 * 1つの登記で複数の順位をまとめて抹消することがある（例:「1番、2番抵当権抹消」）。
 */
function cancellationTargets(purpose: string): { rank: string; annotation: string | null }[] | null {
  if (/回復$/.test(purpose) || !/抹消$/.test(purpose)) return null;
  const head = purpose.match(/^((?:\d+番(?:付記\d+号)?[、，,・]?)+)/);
  if (!head) return null;
  const out: { rank: string; annotation: string | null }[] = [];
  for (const m of head[1].matchAll(/(\d+)番(?:付記(\d+)号)?/g)) {
    out.push({ rank: m[1], annotation: m[2] ?? null });
  }
  return out.length > 0 ? out : null;
}

interface Judged {
  entry: Entry;
  purpose: string;
  cancelled: boolean;
  isCancellation: boolean;
}

/** 下線と「N番…抹消」の両方から、各登記が抹消済みかを判定する。 */
function judge(entries: Entry[]): Judged[] {
  const real = entries.filter((e) => e.mainRank !== null && purposeOf(e) !== "");
  const judged: Judged[] = real.map((entry) => {
    const purpose = purposeOf(entry);
    return {
      entry,
      purpose,
      cancelled: purposeStruck(entry),
      isCancellation: cancellationTargets(purpose) !== null,
    };
  });
  // 抹消の登記（それ自体が効力を保っているもの）が指す対象を抹消扱いにする
  for (const j of judged) {
    if (j.cancelled || !j.isCancellation) continue;
    for (const t of cancellationTargets(j.purpose)!) {
      for (const k of judged) {
        if (k === j || k.entry.mainRank !== t.rank) continue;
        if (t.annotation === null || k.entry.annotation === t.annotation) k.cancelled = true;
      }
    }
  }
  // 主登記が抹消なら、その付記・余白の本登記も効力を失う
  for (const k of judged) {
    if (k.entry.kind === "main") continue;
    const main = judged.find((m) => m.entry.kind === "main" && m.entry.mainRank === k.entry.mainRank);
    if (main?.cancelled) k.cancelled = true;
  }
  return judged;
}

// ---------------------------------------------------------------------------
// 欄の中身（「所有者」「債権額」などのラベル付きの行）
// ---------------------------------------------------------------------------

const KOU_LABELS = [
  "所有者",
  "共有者",
  "原因",
  "住所",
  "氏名",
  "名称",
  "本店",
  "商号",
  "順位",
  "目的",
  "権利者",
  "義務者",
  "債権者",
  "差押債権者",
  "買戻権者",
  "売買代金",
  "契約費用",
  "期間",
];
const OTSU_LABELS = [
  "原因",
  "債権額",
  "極度額",
  "債権の範囲",
  "利息",
  "損害金",
  "債務者",
  "連帯債務者",
  "指定債務者",
  "抵当権者",
  "根抵当権者",
  "権利者",
  "地上権者",
  "賃借権者",
  "質権者",
  "共同担保",
  "順位",
  "取扱店",
  "弁済額",
  "譲渡額",
  "目的",
  "賃料",
  "支払時期",
  "存続期間",
  "地代",
  "特約",
];

/**
 * ラベルごとに、続く行をまとめる。ラベル行の残り（ラベルの後ろ）も中身に含める。
 * 謄本の欄では、ラベルは欄の左端から始まり、続きの行は空白で字下げされる:
 *   「所有者 東京都…」/「 スタージュ…」/「 山 田 太 郎」
 * なので**字下げの無い行の先頭**にあり、直後が空白か行末のものだけをラベルとみなす。
 */
function blocks(lines: Cell[], labels: string[]): Map<string, Cell[]> {
  const map = new Map<string, Cell[]>();
  let curLabel: string | null = null;
  for (const line of lines) {
    const chars = Array.from(line.text);
    // 「順位4番の登記を移記」「昭和63年法務省令…の規定により移記」など、欄の終わりに付く
    // 記載は、直前のラベル（所有者など）の続きではない。ここで欄を区切る。
    if (/^[^ 　]/.test(line.text) && /移記|規定により/.test(compact(line.text))) {
      curLabel = null;
      continue;
    }
    const label = labels
      .filter((l) => {
        if (line.text.slice(0, l.length) !== l) return false;
        const next = chars[l.length];
        return next === undefined || next === " " || next === "　";
      })
      .sort((a, b) => b.length - a.length)[0];
    if (label) {
      curLabel = label;
      const rest: Cell = {
        text: chars.slice(label.length).join(""),
        struck: line.struck.slice(label.length),
      };
      map.set(label, [...(map.get(label) ?? []), rest]);
      continue;
    }
    if (curLabel) map.set(curLabel, [...(map.get(curLabel) ?? []), line]);
  }
  return map;
}

/** 下線の無い行だけを残し、空行を落とす。 */
function liveLines(cells: Cell[] | undefined): string[] {
  if (!cells) return [];
  return cells
    .filter((c) => !isFullyStruck(c))
    .map((c) => currentText(c).replace(/　/g, " ").trim())
    .filter((t) => t !== "");
}

function joinAddress(parts: string[]): string | null {
  if (parts.length === 0) return null;
  return clean(parts.join(""));
}

// ---------------------------------------------------------------------------
// 持分（分数）
// ---------------------------------------------------------------------------

interface Frac {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}
function frac(n: number, d: number): Frac {
  const g = gcd(n, d) || 1;
  return { n: n / g, d: d / g };
}
function add(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}
function sub(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}
function isOne(a: Frac): boolean {
  return a.n === a.d;
}
function parseShare(s: string): Frac | null {
  const m = toHalfWidthDigits(compact(s)).match(/^持分(\d+)分の(\d+)$/);
  if (!m) return null;
  const d = Number(m[1]);
  const n = Number(m[2]);
  if (!d || n > d) return null;
  return frac(n, d);
}
function shareText(f: Frac): string {
  return `${f.d}分の${f.n}`;
}

// ---------------------------------------------------------------------------
// 甲区: 名義人の一覧
// ---------------------------------------------------------------------------

interface Person {
  name: string;
  address: string | null;
  share: Frac | null;
}

/**
 * 欄の行を「並び」で読むための形にする。
 * ⚠ 下線の付いた行も**落とさない**。氏名に下線（氏名変更）があると、落とした瞬間に
 *   住所の行を氏名と取り違える。並びで役割を決め、住所だけ下線の無い行を使う。
 */
function rowsOf(cells: Cell[]): { raw: string; live: string; struck: boolean }[] {
  return cells
    .map((c) => ({
      raw: c.text.replace(/　/g, " ").trim(),
      live: currentText(c).replace(/　/g, " ").trim(),
      struck: isFullyStruck(c),
    }))
    .filter((r) => r.raw !== "");
}

/** 「所有者」欄: 住所（複数行）→ 氏名（最終行）。 */
function parseSole(cells: Cell[]): Person | null {
  const rows = rowsOf(cells);
  if (rows.length === 0) return null;
  const nameRow = rows[rows.length - 1];
  const addr = rows.slice(0, -1).filter((r) => !r.struck).map((r) => r.live);
  return { name: clean(nameRow.raw), address: joinAddress(addr), share: null };
}

/** 「共有者」欄: 住所 → 持分 → 氏名 の繰り返し。崩れていれば null（推測しない）。 */
function parseCo(cells: Cell[]): Person[] | null {
  const out: Person[] = [];
  let addr: string[] = [];
  let share: Frac | null = null;
  for (const r of rowsOf(cells)) {
    const f = parseShare(r.raw);
    if (f) {
      share = f;
      continue;
    }
    if (share !== null) {
      out.push({ name: clean(r.raw), address: joinAddress(addr), share });
      addr = [];
      share = null;
    } else if (!r.struck) {
      addr.push(r.live);
    }
  }
  if (addr.length > 0 || share !== null || out.length === 0) return null;
  return out;
}

/** 欄から名義人を読む（所有者 または 共有者）。読めなければ null。 */
function personsOf(detail: Cell[]): Person[] | null {
  const b = blocks(detail, KOU_LABELS);
  const sole = b.get("所有者");
  if (sole) {
    const p = parseSole(sole);
    return p ? [p] : null;
  }
  const co = b.get("共有者");
  if (co) return parseCo(co);
  return null;
}

interface Holder {
  name: string;
  /** 旧氏名など、同じ人として扱う名前（持分移転の「A持分」の照合に使う） */
  aliases: Set<string>;
  address: string | null;
  share: Frac;
  /** どの順位番号の登記で名義人になったか（付記の住所変更などの当て先） */
  fromRank: string;
}

const key = (s: string) => compact(s);

function findHolder(state: Holder[], name: string): Holder[] {
  const k = key(name);
  return state.filter((h) => h.aliases.has(k));
}

function addHolder(state: Holder[], p: Person, share: Frac, rank: string): void {
  const same = state.find(
    (h) => h.aliases.has(key(p.name)) && (h.address ?? "") === (p.address ?? ""),
  );
  if (same) {
    same.share = add(same.share, share);
    same.fromRank = rank;
    return;
  }
  state.push({ name: p.name, aliases: new Set([key(p.name)]), address: p.address, share, fromRank: rank });
}

/**
 * 名義人の住所・氏名の変更/更正の付記を当てはめる。当て先が分からなければ false。
 *
 * 書き方は2通り:
 *   - 名義人が1人の登記:「住所 X」/「氏名 X」（続きの行を含む）
 *   - 共有者ごと:「共有者Aの住所 X」/「Aの氏名 X」
 * ⚠ 変更が重なると（A→B→C）、途中の付記の値（B）にも下線が引かれる。その付記は
 *   「もう今の値ではない」だけで当て先は分かるので、失敗にせず読み飛ばす。
 *   ただし途中の氏名（B）は、後の付記「共有者Bの…」の照合に使うので別名として覚える。
 */
function applyNameAddressChange(state: Holder[], detail: Cell[], targetRank: string): boolean {
  type Val = { raw: string; live: string; struck: boolean };
  type Group = { who: string | null; field: string; vals: Val[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  const PER = /^(?:共有者)?(.+?)の(住所|氏名|名称|本店|商号)[ 　]*(.*)$/;
  const PLAIN = /^(住所|氏名|名称|本店|商号)(?:[ 　]+(.*))?$/;

  for (const c of detail) {
    const raw = c.text.replace(/　/g, " ");
    if (raw.trim() === "") continue;
    const struck = isFullyStruck(c);
    const live = currentText(c).replace(/　/g, " ");
    if (!/^ /.test(raw)) {
      // 字下げの無い行 = ラベルの行
      if (/^原因( |$)/.test(raw)) {
        cur = null;
        continue;
      }
      const plain = raw.match(PLAIN);
      const per = plain ? null : raw.match(PER);
      if (plain || per) {
        const field = plain ? plain[1] : per![2];
        const rest = (plain ? plain[2] ?? "" : per![3]).trim();
        const liveRest = struck ? "" : ((plain ? live.match(PLAIN)?.[2] : live.match(PER)?.[3]) ?? "").trim();
        cur = { who: per ? clean(per[1]) : null, field, vals: [] };
        if (rest) cur.vals.push({ raw: rest, live: liveRest, struck });
        groups.push(cur);
        continue;
      }
      cur = null;
      continue;
    }
    if (cur) cur.vals.push({ raw: raw.trim(), live: live.trim(), struck });
  }
  if (groups.length === 0) return false;

  for (const g of groups) {
    let target: Holder;
    if (g.who) {
      const hit = findHolder(state, g.who);
      if (hit.length !== 1) return false;
      target = hit[0];
    } else {
      const hit = state.filter((h) => h.fromRank === targetRank);
      if (hit.length !== 1) return false;
      target = hit[0];
    }
    const liveParts = g.vals.filter((v) => !v.struck && v.live !== "").map((v) => v.live);
    if (liveParts.length === 0) {
      // 後の付記で置き換わった途中の値。氏名なら別名として覚えるだけ。
      if (g.field !== "住所" && g.field !== "本店" && g.vals.length > 0) {
        target.aliases.add(key(clean(g.vals.map((v) => v.raw).join(""))));
      }
      continue;
    }
    applyField(target, g.field, liveParts);
  }
  return true;
}

function applyField(h: Holder, field: string, parts: string[]): void {
  if (field === "住所" || field === "本店") {
    h.address = joinAddress(parts);
  } else {
    const name = clean(parts.join(""));
    h.name = name;
    h.aliases.add(key(name));
  }
}

function ownerBlockHasStrike(detail: Cell[]): boolean {
  const b = blocks(detail, KOU_LABELS);
  return [...(b.get("所有者") ?? []), ...(b.get("共有者") ?? [])].some((c) => hasAnyStrike(c));
}

const FULL_TRANSFER = /^(所有権保存|所有権移転|共有者全員持分全部移転)$/;
const PART_TRANSFER = /^(所有権一部移転|(.+)持分全部移転|(.+)持分一部移転)$/;
const NAME_ADDRESS_CHANGE = /登記名義人.*(住所|氏名|名称|本店|商号).*(変更|更正)$/;

/**
 * 甲区を古い順に当てはめて、今の名義人と持分を出す。
 * 判断できない形に当たったら理由を返す（所有者は返さない）。
 */
function replayOwners(kou: Judged[], notes: string[]): RegistryCurrentOwner[] {
  const live = kou.filter((j) => !j.cancelled && !j.isCancellation);
  const annotationsOf = (rank: string) =>
    live.filter((j) => j.entry.kind === "annotation" && j.entry.mainRank === rank);

  if (live.some((j) => /回復$/.test(j.purpose))) {
    notes.push("甲区に抹消回復の登記があります。所有者は目視で確認してください。");
    return [];
  }

  let state: Holder[] | null = null;
  const fail = (msg: string): RegistryCurrentOwner[] => {
    notes.push(msg);
    return [];
  };

  // 名義が動く登記（主登記と、仮登記の余白に書かれた本登記）
  const moves = live.filter(
    (j) =>
      (j.entry.kind === "main" || j.entry.kind === "margin") &&
      (FULL_TRANSFER.test(j.purpose) || PART_TRANSFER.test(j.purpose)),
  );
  for (const j of moves) {
    const rank = j.entry.mainRank!;
    // 所有権更正の付記があれば、名義人はそちらで読む（最後のものを使う）
    const corrections = annotationsOf(rank).filter((a) => /^\d+番(所有権|.+持分)更正$/.test(a.purpose));
    const source = corrections.length > 0 ? corrections[corrections.length - 1].entry : j.entry;
    const persons = personsOf(source.detailCells);
    if (!persons) return fail("所有者の欄を読み取れませんでした。目視で確認してください。");

    if (FULL_TRANSFER.test(j.purpose)) {
      state = [];
      if (persons.length === 1 && persons[0].share === null) {
        addHolder(state, persons[0], frac(1, 1), rank);
      } else {
        for (const p of persons) {
          if (!p.share) return fail("共有者の持分を読み取れませんでした。目視で確認してください。");
          addHolder(state, p, p.share, rank);
        }
      }
    } else {
      if (!state) return fail("持分の移転より前の所有者が分かりません。目視で確認してください。");
      const m = j.purpose.match(/^(.+)持分(全部|一部)移転$/);
      let from: Holder | null = null;
      if (m) {
        const hit = findHolder(state, m[1]);
        if (hit.length !== 1) {
          return fail(`「${j.purpose}」の名義人を特定できません。所有者と持分は目視で確認してください。`);
        }
        from = hit[0];
      } else {
        // 所有権一部移転: 名義人が1人のときだけ（複数なら誰の持分が動いたか書かれない）
        if (state.length !== 1) {
          return fail("所有権一部移転の対象を特定できません。所有者と持分は目視で確認してください。");
        }
        from = state[0];
      }
      let moved = frac(0, 1);
      for (const p of persons) {
        if (!p.share) return fail("移転した持分を読み取れませんでした。目視で確認してください。");
        moved = add(moved, p.share);
      }
      if (m && m[2] === "全部") {
        if (moved.n * from.share.d !== from.share.n * moved.d) {
          return fail("持分の移転の割合が合いません。所有者と持分は目視で確認してください。");
        }
        state = state.filter((h) => h !== from);
      } else {
        const rest = sub(from.share, moved);
        if (rest.n <= 0) {
          return fail("持分の移転の割合が合いません。所有者と持分は目視で確認してください。");
        }
        from.share = rest;
      }
      for (const p of persons) addHolder(state, p, p.share!, rank);
    }

    // 住所・氏名の変更/更正の付記
    const changes = annotationsOf(rank).filter((a) => NAME_ADDRESS_CHANGE.test(a.purpose));
    if (changes.length === 0 && ownerBlockHasStrike(source.detailCells)) {
      // 古い住所・氏名に下線があるのに、変更後を書いた付記が見当たらない
      notes.push("名義人の住所・氏名に変更の跡（下線）があります。今の住所・氏名は目視で確認してください。");
    }
    for (const a of changes) {
      if (!applyNameAddressChange(state, a.entry.detailCells, rank)) {
        return fail("名義人の住所・氏名の変更の当て先を特定できません。目視で確認してください。");
      }
    }
  }

  if (!state || state.length === 0) {
    return fail("甲区から今の所有者を判定できませんでした。目視で確認してください。");
  }
  const total = state.reduce((s, h) => add(s, h.share), frac(0, 1));
  if (!isOne(total)) {
    return fail("持分の合計が1になりません。所有者と持分は目視で確認してください。");
  }
  const out = state.map((h) => ({
    name: h.name,
    address: h.address,
    share: state!.length === 1 && isOne(h.share) ? null : shareText(h.share),
  }));
  return out;
}

// ---------------------------------------------------------------------------
// 乙区: 残っている権利と、付記による書き換え
// ---------------------------------------------------------------------------

const HOLDER_LABELS = ["抵当権者", "根抵当権者", "権利者", "地上権者", "賃借権者", "質権者"];

function firstBlock(b: Map<string, Cell[]>, labels: string[]): Cell[] | undefined {
  for (const l of labels) {
    const v = b.get(l);
    if (v) return v;
  }
  return undefined;
}

/**
 * 権利者欄の名前。欄は「住所（複数行のこともある）→ 名前」で、名前は最後の行。
 * 「（取扱店 ○○支店）」の行は名前ではないので除く。
 */
/** 住所の書き出し（都道府県、または市・区・郡まで）。 */
const ADDRESS_START = /^(東京都|北海道|京都府|大阪府|[^0-9０-９]{2,3}県|[^0-9０-９]{1,5}?[市区郡])/;

/** 権利者・債務者の欄の名前（複数なら全員）。 */
function holderNames(cells: Cell[] | undefined): string[] {
  // ⚠ 下線の付いた行も落とさず「並び」で読む（名前に下線＝名称変更でも住所と取り違えない）
  const rows = rowsOf(cells ?? []).filter((r) => !/^（?取扱店/.test(compact(r.raw)));
  // 名前は**最後の行**（社名に数字が入ることもあるので、数字の有無では決めない）。
  // 複数のときは「住所→名前」が繰り返されるので、「次の行が住所の書き出し（都道府県・市区郡）」
  // で、自分は住所らしくない行を、途中の名前とみなす。
  if (rows.length === 0) return [];
  const addressish = (t: string) => /[0-9０-９]|丁目|番地/.test(t) || ADDRESS_START.test(compact(t));
  const names: string[] = [];
  rows.forEach((r, i) => {
    if (i === rows.length - 1) return;
    const next = rows[i + 1];
    if (!addressish(r.raw) && ADDRESS_START.test(compact(next.raw))) names.push(clean(r.raw));
  });
  names.push(clean(rows[rows.length - 1].raw));
  return names;
}


const CAUTION_RE = /差押|仮差押|仮処分|仮登記|買戻|競売|破産|処分禁止|請求権/;

export function analyzeRegistryRights(lines: StrikeLine[]): RegistryRightsSummary {
  const notes: string[] = [];
  const underlineDetected = lines.some((l) => hasAnyStrike(l));

  // 区ごとに行を分ける
  const bySection: Record<Section, StrikeLine[]> = { title: [], kouku: [], otsuku: [], other: [] };
  let section: Section = "other";
  for (const l of lines) {
    const s = sectionOf(l.text);
    if (s) section = s;
    bySection[section].push(l);
  }
  const titleHasStruck = bySection.title.some((l) => hasAnyStrike(l));
  if (titleHasStruck) {
    notes.push("表題部に変更前の記載（下線）があります。今の値は下線の無い行です。");
  }

  const kou = judge(parseEntries(bySection.kouku));
  const otsu = judge(parseEntries(bySection.otsuku));
  const hasKouku = bySection.kouku.length > 0;
  const hasOtsuku = bySection.otsuku.length > 0;

  const cautions: RegistryCaution[] = [];
  const hasMarginRegistration = (list: Judged[], rank: string) =>
    list.some((j) => !j.cancelled && j.entry.kind === "margin" && j.entry.mainRank === rank);

  // --- 甲区 ---
  const liveKou = kou.filter((j) => !j.cancelled && !j.isCancellation);
  for (const j of liveKou) {
    if (j.entry.kind === "margin") continue;
    if (!CAUTION_RE.test(j.purpose)) continue;
    // 仮登記の下に本登記が入っていれば、もう仮登記ではない
    if (/仮登記/.test(j.purpose) && hasMarginRegistration(kou, j.entry.mainRank!)) continue;
    cautions.push({ section: "甲区", rank: j.entry.mainRank!, purpose: j.purpose });
  }
  if (liveKou.some((j) => /相続人申告/.test(j.purpose))) {
    notes.push("相続人申告の登記があります（所有者の相続人からの申出の記録で、権利関係を示すものではありません）。");
  }
  const currentOwners = hasKouku ? replayOwners(kou, notes) : [];

  // --- 乙区 ---
  const activeRights: RegistryActiveRight[] = [];
  const liveOtsu = otsu.filter((j) => !j.cancelled && !j.isCancellation);
  if (liveOtsu.some((j) => /回復$/.test(j.purpose))) {
    notes.push("乙区に抹消回復の登記があります。残っている権利は目視で確認してください。");
  }
  for (const j of liveOtsu) {
    if (j.entry.kind !== "main" || /回復$/.test(j.purpose)) continue;
    const rank = j.entry.mainRank!;
    const margin = liveOtsu.find((k) => k.entry.kind === "margin" && k.entry.mainRank === rank);
    const base = margin ?? j; // 仮登記の本登記があれば本登記の内容
    const b = blocks(j.entry.detailCells, OTSU_LABELS);
    const bb = margin ? blocks(margin.entry.detailCells, OTSU_LABELS) : b;
    const amountLines = liveLines(firstBlock(bb, ["債権額", "極度額"]) ?? firstBlock(b, ["債権額", "極度額"]));
    let amount = amountLines.length > 0 ? clean(amountLines.join("")) : null;
    let holders = holderNames(firstBlock(bb, HOLDER_LABELS) ?? firstBlock(b, HOLDER_LABELS));
    if (holders.length > 1) {
      notes.push(`乙区${rank}番の権利者が複数あります（${holders.length}名）。漏れがないか目視で確認してください。`);
    }
    let debtors = holderNames(firstBlock(bb, ["債務者", "連帯債務者"]) ?? firstBlock(b, ["債務者", "連帯債務者"]));

    const anns = liveOtsu.filter((k) => k.entry.kind === "annotation" && k.entry.mainRank === rank);
    for (const a of anns) {
      const ab = blocks(a.entry.detailCells, OTSU_LABELS);
      if (/^\d+番付記\d+号/.test(a.purpose)) {
        // 付記を指す登記（例:「1番付記1号抵当権移転」= 一部移転で取得した分だけの移転）。
        // 誰の分が動いたかを当てはめないと権利者の一覧を誤るので、読み取り対象外にする。
        holders = [];
        notes.push(`乙区${rank}番に「${a.purpose}」があります。権利者は目視で確認してください。`);
      } else if (/権?一部移転$/.test(a.purpose)) {
        const add = holderNames(firstBlock(ab, HOLDER_LABELS));
        if (add.length === 0) notes.push(`乙区${rank}番の一部移転の権利者を読み取れません。目視で確認してください。`);
        holders = [...holders, ...add];
      } else if (/権移転$/.test(a.purpose)) {
        const to = holderNames(firstBlock(ab, HOLDER_LABELS));
        if (to.length === 0) notes.push(`乙区${rank}番の移転後の権利者を読み取れません。目視で確認してください。`);
        else holders = to;
      } else if (NAME_ADDRESS_CHANGE.test(a.purpose)) {
        // 権利者（抵当権者など）の名称・住所の変更/更正。住所は表示しないので名称だけ反映する
        const nb = blocks(a.entry.detailCells, KOU_LABELS);
        const newName = liveLines(firstBlock(nb, ["名称", "氏名", "商号"]));
        if (newName.length > 0) {
          if (holders.length === 1) holders = [clean(newName.join(""))];
          else notes.push(`乙区${rank}番の権利者の名称変更の当て先を特定できません。目視で確認してください。`);
        } else if (!firstBlock(nb, ["住所", "本店"])) {
          notes.push(`乙区${rank}番に付記「${a.purpose}」があります。内容は目視で確認してください。`);
        }
      } else if (/(変更|更正)$/.test(a.purpose)) {
        let applied = false;
        const am = liveLines(firstBlock(ab, ["債権額", "極度額"]));
        if (am.length > 0) {
          amount = clean(am.join(""));
          applied = true;
        }
        const db = holderNames(firstBlock(ab, ["債務者", "連帯債務者", "指定債務者"]));
        if (db.length > 0) {
          debtors = db;
          applied = true;
        }
        // 利息・債権の範囲など、表示していない項目だけの変更は「反映済み」と言わずに知らせる
        if (!applied && !firstBlock(ab, ["債権の範囲", "利息", "損害金"])) {
          notes.push(`乙区${rank}番に付記「${a.purpose}」があります。内容は目視で確認してください。`);
        }
      } else if (/順位|元本確定/.test(a.purpose)) {
        // 順位の変更・譲渡、元本確定は、権利者・金額を変えない
      } else {
        notes.push(`乙区${rank}番に付記「${a.purpose}」があります。内容は目視で確認してください。`);
      }
    }

    if (debtors.length > 1) {
      notes.push(`乙区${rank}番の債務者が複数あります（${debtors.length}名）。漏れがないか目視で確認してください。`);
    }
    activeRights.push({
      rank,
      purpose: base.purpose,
      amount,
      holder: holders.length > 0 ? holders.join("、") : null,
      debtor: debtors.length > 0 ? debtors.join("、") : null,
      activeAnnotations: anns.length,
    });
    if (CAUTION_RE.test(j.purpose) && !(/仮登記/.test(j.purpose) && margin)) {
      cautions.push({ section: "乙区", rank, purpose: j.purpose });
    }
  }

  return {
    underlineDetected,
    hasKouku,
    hasOtsuku,
    currentOwners,
    activeRights,
    cautions,
    cancelled: {
      kouku: kou.filter((j) => j.cancelled).length,
      otsuku: otsu.filter((j) => j.cancelled).length,
    },
    titleHasStruck,
    notes,
  };
}
