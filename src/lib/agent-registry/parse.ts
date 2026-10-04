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

function authorityLabel(code: string, authorityText: string): string {
  return code === "00" ? "国土交通大臣" : `${authorityText}知事`;
}

/** 一覧(takkenKensaku.do の検索・ページ送りの結果)を読む。 */
export function parseListPage(html: string): ListPage {
  const totalM = html.match(/検索結果：\s*([\d,]+)\s*件/);
  if (!totalM) throw new LayoutChanged("件数の文言");
  const total = Number(totalM[1].replace(/,/g, ""));
  if (total === 0) return { total: 0, pages: 0, page: 0, rows: [] };

  const select = html.match(/<select id="pageListNo1"[\s\S]*?<\/select>/)?.[0];
  if (!select) throw new LayoutChanged("ページの選択");
  const pagesM = select.match(/>\s*\d+\/(\d+)\s*</);
  const pageM = select.match(/<option value="(\d+)" selected/);
  if (!pagesM || !pageM) throw new LayoutChanged("ページ数");

  const table = html.match(/<table class="re_disp"\s*>([\s\S]*?)<\/table>/)?.[1];
  if (!table) throw new LayoutChanged("一覧の表");
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => cleanText(m[1]));
  if (headers.join("|") !== LIST_HEADERS.join("|")) throw new LayoutChanged("一覧の見出し");

  const byKey = new Map<string, ListRow & { isMain: boolean }>();
  for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length === 0) continue; // 見出しの行
    if (cells.length !== LIST_HEADERS.length) throw new LayoutChanged("一覧の行の列数");
    const keyM = cells[3].match(/js_ShowDetail\('(\d{8})'\)/);
    if (!keyM) throw new LayoutChanged("詳細を開く引数");
    const licenseKey = keyM[1];
    const authority = licenseKey.slice(0, 2);
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
  const rows = [...byKey.values()].map(({ isMain: _isMain, ...r }) => r);
  return { total, pages: Number(pagesM[1]), page: Number(pageM[1]), rows };
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
  const authorityOk = authority === "00" ? licenseText.includes("国土交通大臣") : licenseText.includes("知事");
  if (!numberM || numberM[1] !== licenseKey.slice(2) || !authorityOk) {
    throw new LayoutChanged("開いた会社と免許番号が違う");
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
