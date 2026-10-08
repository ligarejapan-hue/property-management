/**
 * 国交省の宅建業者検索(etsuran2.mlit.go.jp/TAKKEN)の画面を値に読む(純関数)。
 *
 * - 代表者名・宅建士などの個人名は**読み捨てる**(どの戻り値にも入れない)。
 * - 想定の見出し・列・件数が見つからないときは推測せず `LayoutChanged` を投げる
 *   (先方の画面が変わったら止めて記録する=計画 G3)。
 */

export interface ListRow {
  /** 行政庁2桁+番号6桁("13000001")。免許の回次を含まない=更新しても変わらない */
  licenseKey: string;
  authority: string;
  /** 表示用 "東京都知事(17)第000001号" */
  licenseLabel: string;
  companyName: string;
  address: string | null;
  /** このページに本店の行があった(所在地は本店のもの)。false なら所在地は支店のもの=本店の所在地を上書きしない */
  isMain: boolean;
}

export interface ListPage {
  total: number;
  pages: number;
  page: number;
  rows: ListRow[];
}

export interface Detail {
  licenseKey: string;
  companyKana: string | null;
  address: string | null;
  phone: string | null;
  validUntil: string | null;
}

export class LayoutChanged extends Error {
  constructor(what: string) {
    super(`先方の画面の作りが想定と違います: ${what}`);
    this.name = "LayoutChanged";
  }
}

const LIST_HEADERS = ["No.", "免許行政庁", "免許証番号", "商号又は名称", "代表者名", "事務所名", "所在地"];
/** 1ページの行数(検索で頼む dispCount と同じ値・client と共有)。 */
export const PAGE_SIZE = 50;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** タグを外し、文字参照を戻し、全角空白を含む空白を1つの半角空白にまとめる。 */
export function cleanText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[\s　]+/g, " ")
    .trim();
}

/** 詳細の「免許証番号」の欄に出る免許行政庁の名前(対象の5つ)。 */
const AUTHORITY_NAMES: Record<string, string> = {
  "00": "国土交通大臣",
  "11": "埼玉県知事",
  "12": "千葉県知事",
  "13": "東京都知事",
  "14": "神奈川県知事",
};

/**
 * 大臣免許の行の一覧の「免許行政庁」の欄の、実物の書き方(2026-10-08 本番の1回目で確認)。
 * 一覧では「国土交通大臣」ではなく窓口の「各地方整備局等」と出る(詳細の免許証番号の欄は「国土交通大臣免許」)。
 */
const MINISTER_LIST_CELL = "各地方整備局等";

/** 一覧の「免許行政庁」の欄が、免許の鍵の行政庁と合っているか(対象の5つ以外は確かめない)。 */
function visibleAuthorityOk(code: string, cellText: string): boolean {
  // 大臣も都県と同じく欄そのものと照らす(実物の書き方と一字一句・@codex #477)。
  if (code === "00") return cellText === MINISTER_LIST_CELL;
  const name = AUTHORITY_NAMES[code];
  return name ? cellText === name.replace(/知事$/, "") : true;
}

const TEXT_TO_CODE: [string, string][] = [
  ["国土交通大臣", "00"],
  ["埼玉県", "11"],
  ["千葉県", "12"],
  ["東京都", "13"],
  ["神奈川県", "14"],
];

/**
 * 免許番号の文字(手入力の名簿の「東京都知事（３）第１２３４５号」など)から免許の鍵("13012345")を作る。
 * 全角・空白・回次の書き方の違いを吸収する。対象の5つの行政庁でなければ null。
 */
export function licenseKeyFromText(text: string): string | null {
  const s = text.normalize("NFKC");
  const code = TEXT_TO_CODE.find(([name]) => s.includes(name))?.[1];
  const num = s.match(/第\s*0*(\d{1,6})\s*号/)?.[1];
  return code && num ? `${code}${num.padStart(6, "0")}` : null;
}

function authorityLabel(code: string, authorityText: string): string {
  return code === "00" ? "国土交通大臣" : `${authorityText}知事`;
}

/** 一覧(takkenKensaku.do の検索・ページ送りの結果)を読む。 */
export function parseListPage(html: string): ListPage {
  const totalM = html.match(/検索結果：\s*([\d,]+)\s*件/);
  if (!totalM) throw new LayoutChanged("件数の文言");
  const total = Number(totalM[1].replace(/,/g, ""));
  if (total === 0) return { total: 0, pages: 0, page: 0, rows: [] };
  // 「1件目～50件目までを表示」=このページにあるはずの行の数(1件=1行・2026-10-03 の実物で確認)。
  const rangeM = html.match(/(\d+)件目～(\d+)件目/);
  if (!rangeM) throw new LayoutChanged("表示している範囲の文言");
  const rangeStart = Number(rangeM[1]);
  const rangeEnd = Number(rangeM[2]);
  const expectedRows = rangeEnd - rangeStart + 1;

  const select = html.match(/<select id="pageListNo1"[\s\S]*?<\/select>/)?.[0];
  if (!select) throw new LayoutChanged("ページの選択");
  const pagesM = select.match(/>\s*\d+\/(\d+)\s*</);
  const pageM = select.match(/<option value="(\d+)" selected/);
  if (!pagesM || !pageM) throw new LayoutChanged("ページ数");
  const page = Number(pageM[1]);
  const pages = Number(pagesM[1]);
  // ページ数が件数と合っているか(50件ずつ)。合わない(26906件なのに「1/1」など)画面をそのまま進めると、
  // 1ページで行政庁を終わりにして、残りの会社を締めで消してしまう(@codex #477)。
  if (pages !== Math.ceil(total / PAGE_SIZE)) throw new LayoutChanged("ページ数が件数と合わない");
  // 表示している範囲が、選んだページと件数に合っているか(50件ずつ・最後のページは件数で終わる)。
  // 合わない=別のページの中身。そのまま進めると間のページを読まずに締めで会社を消してしまう(@codex #477)。
  if (rangeStart !== (page - 1) * PAGE_SIZE + 1 || rangeEnd !== Math.min(page * PAGE_SIZE, total)) {
    throw new LayoutChanged("表示している範囲がページと合わない");
  }

  const table = html.match(/<table class="re_disp"\s*>([\s\S]*?)<\/table>/)?.[1];
  if (!table) throw new LayoutChanged("一覧の表");
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => cleanText(m[1]));
  if (headers.join("|") !== LIST_HEADERS.join("|")) throw new LayoutChanged("一覧の見出し");

  const byKey = new Map<string, ListRow>();
  let dataRows = 0;
  for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length === 0) continue; // 見出しの行
    if (cells.length !== LIST_HEADERS.length) throw new LayoutChanged("一覧の行の列数");
    dataRows++;
    const keyM = cells[3].match(/js_ShowDetail\('(\d{8})'\)/);
    if (!keyM) throw new LayoutChanged("詳細を開く引数");
    const licenseKey = keyM[1];
    const authority = licenseKey.slice(0, 2);
    // 見えている「免許行政庁」と免許の鍵が食い違う行=想定外の画面。推測で読まない(@codex #477)。
    if (!visibleAuthorityOk(authority, cleanText(cells[1]))) throw new LayoutChanged("免許行政庁の欄と免許番号が食い違う");
    // cells[4]=代表者名は読まない(個人名を持たない)。
    const office = cleanText(cells[5]);
    const address = cleanText(cells[6]) || null;
    const isMain = office === "本店";
    const prev = byKey.get(licenseKey);
    if (prev && (prev.isMain || !isMain)) continue;
    byKey.set(licenseKey, {
      licenseKey,
      authority,
      licenseLabel: `${authorityLabel(authority, cleanText(cells[1]))}${cleanText(cells[2])}`,
      companyName: cleanText(cells[3]),
      address,
      isMain,
    });
  }
  // 件数が0でないのに行が無い=想定外の画面。空のページとして進めると締めで会社を消してしまう(@codex #477)。
  if (dataRows === 0) throw new LayoutChanged("件数があるのに行が無い");
  // 読めた行の数=詳細を開く引数の数。違えば読めなかった行がある=黙って落とさず止める(計画 G3)。
  if (dataRows !== (table.match(/js_ShowDetail\(/g) ?? []).length) throw new LayoutChanged("読めなかった行");
  // 表示している範囲の行の数と違う=行が欠けた画面。そのまま進めると締めで欠けた会社を消してしまう(@codex #477)。
  if (dataRows !== expectedRows) throw new LayoutChanged("表示している範囲と行の数が違う");
  return { total, pages, page, rows: [...byKey.values()] };
}

/** 詳細(tkGaiyo.do)を読む。開いた会社と違う免許番号なら取り違えとして止める。 */
export function parseDetail(html: string, licenseKey: string): Detail {
  const fields = new Map<string, string>();
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    fields.set(cleanText(m[1]).replace(/ /g, ""), m[2]);
  }
  const license = fields.get("免許証番号");
  if (license === undefined) throw new LayoutChanged("免許証番号の欄");
  const licenseText = cleanText(license);
  const numberM = licenseText.match(/第(\d{6})号/);
  const authority = licenseKey.slice(0, 2);
  // 番号が同じでも都県が違えば別の会社。頼んだ行政庁の名前まで一致を確かめる(@codex #477)。
  const expectedName = AUTHORITY_NAMES[authority];
  const authorityOk = expectedName
    ? licenseText.startsWith(expectedName)
    : !licenseText.includes("国土交通大臣") && licenseText.includes("知事");
  if (!numberM || numberM[1] !== licenseKey.slice(2) || !authorityOk) {
    throw new LayoutChanged("開いた会社と免許番号が違う");
  }

  // 見出しそのものが無い=画面の作りが変わった。空欄(値が無い)と区別しないと、電話を消して
  // 1年取り直さなくなる(@codex #477)。
  for (const heading of ["商号又は名称", "主たる事務所の所在地", "電話番号"]) {
    if (!fields.has(heading)) throw new LayoutChanged(`詳細の「${heading}」の欄`);
  }
  const nameCell = fields.get("商号又は名称") ?? "";
  const kanaRaw = nameCell.match(/<p class="phonetic">([\s\S]*?)<\/p>/)?.[1];
  const companyKana = kanaRaw ? cleanText(cleanText(kanaRaw).normalize("NFKC")) || null : null;
  // 「代表者の氏名」の欄は読まない(個人名を持たない)。

  const address = cleanText(fields.get("主たる事務所の所在地") ?? "") || null;
  const phone = cleanText(fields.get("電話番号") ?? "") || null;
  const validText = cleanText(fields.get("免許の有効期間") ?? "");
  const validUntil = validText.match(/から(.+?)まで/)?.[1].trim() ?? (validText || null);

  return { licenseKey, companyKana, address, phone, validUntil };
}
