/**
 * 全部事項証明書の「権利部」を読み、**今も効力のある登記**だけを取り出す。
 *
 * 謄本の読み方（登記事項証明書の決まり）:
 *   - 下線のある事項は抹消事項（＝もう効力がない）。証明書の欄外に
 *     「下線のあるものは抹消事項であることを示す。」と印字される。
 *   - 「N番○○抹消」の登記がされると、N番の事項に下線が引かれる
 *     （例: 乙区「2 1番根抵当権抹消」→ 乙区1番に下線）。抹消の登記そのものには下線は無い。
 *   - 付記登記（付記1号…）は、その順位番号の主登記にぶら下がる。
 *     「N番登記名義人住所変更」が入ると、N番の所有者の古い住所に下線が引かれ、
 *     今の住所は付記の「住所」欄になる。主登記が抹消されれば付記も効力を失う。
 *   - 甲区＝所有権に関する事項、乙区＝所有権以外の権利（抵当権・根抵当権・賃借権など）。
 *
 * 下線の情報が無い入力（テキスト貼り付け）でも、「N番…抹消」の登記から対象を判定する。
 *
 * ⚠ 判断がつかない形（持分の移転が残っている、共有者の付記変更 など）は**推測で埋めず**、
 *   `notes` に「目視で確認してください」を出して所有者を返さない。
 * ⚠ 結果には氏名・住所が入る（画面の確認表示用）。ログ・AuditLog には出さないこと。
 */
import { joinSpacedKanji, toHalfWidthDigits } from "../registry-text-normalize";
import { hasAnyStrike, isFullyStruck, type StrikeLine } from "./lines";

export interface RegistryCurrentOwner {
  name: string;
  address: string | null;
  share: string | null;
}

export interface RegistryActiveRight {
  /** 順位番号（半角数字） */
  rank: string;
  /** 登記の目的（例: 抵当権設定 / 根抵当権設定） */
  purpose: string;
  /** 債権額 または 極度額（例: 金4,500万円） */
  amount: string | null;
  /** 抵当権者・根抵当権者・権利者など */
  holder: string | null;
  /** 債務者 */
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

interface Entry {
  /** 順位番号の欄（例: "3" / "付記1号" / ""） */
  rankCell: string;
  purposeCells: Cell[];
  detailCells: Cell[];
  /** 主登記の順位番号（付記なら親の番号） */
  mainRank: string | null;
  /** 付記の番号（主登記なら null） */
  annotation: string | null;
}

const VERTICAL = new Set(["┃", "│"]);

function compact(s: string): string {
  return s.replace(/[\s　]/g, "");
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
  // ┃ ├────… : 順位番号の欄は続き、その右から新しい登記（付記）が始まる
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

  for (const row of rows) {
    const sep = isSeparator(row.text);
    if (sep) {
      flush();
      pendingSub = sep === "sub";
      continue;
    }
    const cells = splitRow(row);
    if (!cells || cells.length < 4) continue;
    const [rankC, purposeC, , detailC] = cells;
    if (compact(rankC.text).includes("順位番号")) continue; // 見出し

    if (!cur) {
      const rankCell = toHalfWidthDigits(compact(rankC.text));
      let mainRank: string | null = null;
      let annotation: string | null = null;
      const ann = rankCell.match(/^付記(\d+)号$/);
      if (/^\d+$/.test(rankCell)) {
        mainRank = rankCell;
        lastMainRank = rankCell;
      } else if (ann) {
        mainRank = lastMainRank;
        annotation = ann[1];
      } else if (pendingSub && rankCell === "") {
        // 順位番号の欄が空の付記（実物で、空欄の付記の枠が出ることがある）
        mainRank = lastMainRank;
        annotation = "";
      }
      cur = { rankCell, purposeCells: [], detailCells: [], mainRank, annotation };
    }
    cur.purposeCells.push(purposeC);
    cur.detailCells.push(detailC);
  }
  flush();
  return entries;
}

function purposeOf(e: Entry): string {
  return toHalfWidthDigits(compact(e.purposeCells.map((c) => c.text).join("")));
}

function purposeStruck(e: Entry): boolean {
  const joined: Cell = {
    text: e.purposeCells.map((c) => c.text).join(""),
    struck: e.purposeCells.flatMap((c) => c.struck),
  };
  return isFullyStruck(joined);
}

/** 「N番(付記M号)…抹消」の登記なら、対象の番号を返す。 */
function cancellationTarget(purpose: string): { rank: string; annotation: string | null } | null {
  const m = purpose.match(/^(\d+)番(?:付記(\d+)号)?.*抹消$/);
  if (!m) return null;
  return { rank: m[1], annotation: m[2] ?? null };
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
      isCancellation: cancellationTarget(purpose) !== null,
    };
  });
  // 抹消の登記（それ自体が効力を保っているもの）が指す対象を抹消扱いにする
  for (const j of judged) {
    if (j.cancelled || !j.isCancellation) continue;
    const t = cancellationTarget(j.purpose)!;
    for (const k of judged) {
      if (k === j || k.entry.mainRank !== t.rank) continue;
      if (t.annotation === null || k.entry.annotation === t.annotation) k.cancelled = true;
    }
  }
  // 主登記が抹消なら、その付記も効力を失う
  for (const k of judged) {
    if (k.entry.annotation === null) continue;
    const main = judged.find(
      (m) => m.entry.annotation === null && m.entry.mainRank === k.entry.mainRank,
    );
    if (main?.cancelled) k.cancelled = true;
  }
  return judged;
}

// ---------------------------------------------------------------------------
// 欄の中身（「所有者」「債権額」などのラベル付きの行）
// ---------------------------------------------------------------------------

const KOU_LABELS = ["所有者", "共有者", "原因", "住所", "氏名", "名称", "順位", "目的", "権利者", "義務者", "債権者", "差押債権者"];
const OTSU_LABELS = [
  "原因",
  "債権額",
  "極度額",
  "債権の範囲",
  "利息",
  "損害金",
  "債務者",
  "連帯債務者",
  "抵当権者",
  "根抵当権者",
  "権利者",
  "地上権者",
  "賃借権者",
  "質権者",
  "共同担保",
  "順位",
  "取扱店",
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

/** 「所有者」欄: 住所（複数行）→ 氏名（最終行）。 */
function parseSoleOwner(cells: Cell[]): { owner: RegistryCurrentOwner | null; addressStruck: boolean } {
  const addressStruck = cells.some((c) => hasAnyStrike(c));
  const live = liveLines(cells);
  if (live.length === 0) return { owner: null, addressStruck };
  const name = clean(live[live.length - 1]);
  const address = joinAddress(live.slice(0, -1));
  return { owner: { name, address, share: null }, addressStruck };
}

/** 「共有者」欄: 住所 → 持分 → 氏名 の繰り返し。 */
function parseCoOwners(cells: Cell[]): RegistryCurrentOwner[] | null {
  const live = liveLines(cells);
  const owners: RegistryCurrentOwner[] = [];
  let addr: string[] = [];
  let share: string | null = null;
  for (const l of live) {
    const m = toHalfWidthDigits(compact(l)).match(/^持分(\d+分の\d+)$/);
    if (m) {
      share = m[1];
      continue;
    }
    if (share !== null) {
      owners.push({ name: clean(l), address: joinAddress(addr), share });
      addr = [];
      share = null;
    } else {
      addr.push(l);
    }
  }
  if (addr.length > 0 || share !== null) return null; // 途中で崩れた → 推測しない
  return owners;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

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

  // --- 甲区: 今の所有者 ---
  let currentOwners: RegistryCurrentOwner[] = [];
  const liveKou = kou.filter((j) => !j.cancelled && !j.isCancellation);
  for (const j of liveKou) {
    if (j.entry.annotation === null && CAUTION_RE.test(j.purpose)) {
      cautions.push({ section: "甲区", rank: j.entry.mainRank!, purpose: j.purpose });
    }
  }
  const ownership = liveKou.filter(
    (j) =>
      j.entry.annotation === null &&
      /所有権(保存|移転)/.test(j.purpose) &&
      !/仮登記|請求権/.test(j.purpose),
  );
  const last = ownership[ownership.length - 1];
  if (!hasKouku) {
    // 所有者事項など、権利部の無い謄本。ここでは何もしない。
  } else if (!last) {
    notes.push("甲区から今の所有者を判定できませんでした。目視で確認してください。");
  } else if (
    // 「○○持分全部移転」「所有権一部移転」など、持分が動く登記が残っている
    liveKou.some((j) => j.entry.annotation === null && /持分.*移転|一部移転/.test(j.purpose))
  ) {
    notes.push("持分の移転登記が残っています。所有者と持分は目視で確認してください。");
  } else {
    const b = blocks(last.entry.detailCells, KOU_LABELS);
    const sole = b.get("所有者");
    const co = b.get("共有者");
    if (sole) {
      const { owner, addressStruck } = parseSoleOwner(sole);
      if (owner) currentOwners = [owner];
      // 付記（登記名義人の住所・氏名の変更）を反映
      const changes = liveKou.filter(
        (j) =>
          j.entry.annotation !== null &&
          j.entry.mainRank === last.entry.mainRank &&
          /登記名義人.*(住所|氏名|名称)/.test(j.purpose),
      );
      for (const c of changes) {
        const cb = blocks(c.entry.detailCells, KOU_LABELS);
        const addr = joinAddress(liveLines(cb.get("住所")));
        const name = liveLines(cb.get("氏名") ?? cb.get("名称"));
        if (currentOwners[0] && addr) currentOwners[0].address = addr;
        if (currentOwners[0] && name.length > 0) currentOwners[0].name = clean(name.join(""));
      }
      if (addressStruck && changes.length === 0 && currentOwners[0]) {
        // 下線で古い住所が消えたのに、変更後の住所の付記が見当たらない
        currentOwners[0].address = null;
        notes.push("所有者の住所に変更があります。今の住所は目視で確認してください。");
      }
    } else if (co) {
      const owners = parseCoOwners(co);
      const hasChange = liveKou.some(
        (j) => j.entry.annotation !== null && j.entry.mainRank === last.entry.mainRank,
      );
      if (!owners || owners.length === 0) {
        notes.push("共有者の欄を読み取れませんでした。目視で確認してください。");
      } else if (hasChange || co.some((c) => hasAnyStrike(c))) {
        notes.push("共有者の住所・氏名に変更の登記があります。目視で確認してください。");
      } else {
        currentOwners = owners;
      }
    } else {
      notes.push("所有者の欄を読み取れませんでした。目視で確認してください。");
    }
  }

  // --- 乙区: 残っている権利 ---
  const activeRights: RegistryActiveRight[] = [];
  const liveOtsu = otsu.filter((j) => !j.cancelled && !j.isCancellation);
  for (const j of liveOtsu) {
    if (j.entry.annotation !== null) continue;
    const b = blocks(j.entry.detailCells, OTSU_LABELS);
    const amount = liveLines(b.get("債権額") ?? b.get("極度額"));
    const holderCells =
      b.get("抵当権者") ?? b.get("根抵当権者") ?? b.get("権利者") ?? b.get("地上権者") ?? b.get("賃借権者") ?? b.get("質権者");
    const holder = liveLines(holderCells);
    const debtor = liveLines(b.get("債務者") ?? b.get("連帯債務者"));
    activeRights.push({
      rank: j.entry.mainRank!,
      purpose: j.purpose,
      amount: amount.length > 0 ? clean(amount.join("")) : null,
      holder: holder.length > 0 ? clean(holder[holder.length - 1]) : null,
      debtor: debtor.length > 0 ? clean(debtor[debtor.length - 1]) : null,
      activeAnnotations: liveOtsu.filter(
        (k) => k.entry.annotation !== null && k.entry.mainRank === j.entry.mainRank,
      ).length,
    });
    if (CAUTION_RE.test(j.purpose)) {
      cautions.push({ section: "乙区", rank: j.entry.mainRank!, purpose: j.purpose });
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

