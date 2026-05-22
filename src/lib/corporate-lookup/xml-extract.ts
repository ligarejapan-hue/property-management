// 国税庁 法人番号 Web-API (type=12) は UTF-8 XML を返す。
// 取得対象は <corporation> ブロック配下の単純なテキスト要素のみで、
// CDATA / namespace / nested 構造はないため、最小限のテキスト抽出に限定する。
//
// JSON parser ではなく XML 専用扱い: 不正値で例外を投げず null を返す方針。
// raw XML 全文は呼び出し側でも保存しない（AuditLog / レスポンス共に除外）。

const XML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlEntities(input: string): string {
  let out = input.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITY_MAP[m] ?? m);
  // numeric entity (&#1234; / &#x4e2d;) — 国税庁データに通常含まれないが防御的に対応
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return out;
}

/**
 * `<tag>...</tag>` を取り出す。
 * - 自己閉じタグ `<tag/>` → null
 * - 空タグ `<tag></tag>` → null
 * - 存在しない → null
 * - 1回目のマッチのみ採用（block 内の最初の要素を取る前提）
 */
export function extractTagText(xml: string, tagName: string): string | null {
  const selfClose = new RegExp(`<${tagName}\\s*/>`);
  if (selfClose.test(xml)) return null;

  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const m = re.exec(xml);
  if (!m) return null;
  const decoded = decodeXmlEntities(m[1]).trim();
  return decoded === "" ? null : decoded;
}

/**
 * `<corporation>...</corporation>` ブロックを順に抽出する。
 * count=0 や要素が無い場合は空配列。
 */
export function extractCorporationBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<corporation>([\s\S]*?)<\/corporation>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}
