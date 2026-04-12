/**
 * Registry PDF (謄本PDF) text parser.
 *
 * 対象フォーマット:
 *   - 登記事項全部証明書 (土地・建物・区分建物)
 *   - PDF から抽出したテキスト (pdf-parse v2 が出力する形式)
 *
 * 実際の謄本PDFには罫線文字 (│┃━ 等) が混入するため、
 * 前処理でクリーニングしてから正規表現で抽出する。
 */

export interface RegistryParseResult {
  /** 不動産番号 */
  realEstateNumber: string | null;
  /** 所在 (住所) */
  address: string | null;
  /** 地番 */
  lotNumber: string | null;
  /** 家屋番号 */
  buildingNumber: string | null;
  /** 地目 */
  landCategory: string | null;
  /** 地積 (面積) */
  area: string | null;
  /** 所有者情報 */
  owners: RegistryOwnerInfo[];
  /** パース信頼度 (0-1) */
  confidence: number;
  /** 警告・注記 */
  warnings: string[];
}

export interface RegistryOwnerInfo {
  name: string;
  address: string | null;
  share: string | null; // 持分 e.g. "3分の1"
}

// ---------------------------------------------------------------------------
// 前処理ユーティリティ
// ---------------------------------------------------------------------------

/**
 * PDF 抽出テキストから罫線・記号文字を除去してパースしやすい形に整形する。
 *
 * 謄本の表レイアウトで使われる文字:
 *   縦罫: │ ┃ ╎ ｜
 *   横罫: ─ ━ ═ ┄ ┅ ─
 *   角: ┌ ┐ └ ┘ ┏ ┓ ┗ ┛ ╔ ╗ ╚ ╝
 *   交点: ┼ ╋ ┬ ┴ ├ ┤ ┠ ┨ ┯ ┷ ┳ ┻ ╠ ╣ ╦ ╩ ╬
 */
function cleanRegistryText(raw: string): string {
  return (
    raw
      // 全角スペースを半角スペースに統一
      .replace(/\u3000/g, " ")
      // 罫線文字をスペースに置換
      .replace(
        /[│┃╎｜─━═┄┅┌┐└┘┏┓┗┛╔╗╚╝┼╋┬┴├┤┠┨┯┷┳┻╠╣╦╩╬＊]/g,
        " ",
      )
      // 連続スペースを1つに
      .replace(/ {2,}/g, " ")
      // 行頭末のスペースを除去
      .split("\n")
      .map((l) => l.trim())
      // 空行を除去
      .filter((l) => l.length > 0)
      .join("\n")
  );
}

/**
 * 謄本でよくある「スペース区切り漢字」を結合する。
 * 例: "坂 本 周 守" → "坂本周守"
 *     "世 田 谷 区" → "世田谷区"
 * ただし住所に含まれる数字区切りは維持する。
 */
function joinSpacedKanji(s: string): string {
  // 漢字・ひらがな・カタカナが1文字スペース1文字のパターンを結合
  return s.replace(
    /([\u3000-\u9FFF\u30A0-\u30FF\u3040-\u309F]) ([\u3000-\u9FFF\u30A0-\u30FF\u3040-\u309F])/g,
    "$1$2",
  );
}

/**
 * 全角数字・アルファベットを半角に正規化する。
 * 中点 (・) は地積の小数点として使われるため "." に変換する。
 */
function normalizeNumber(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/[・：]/g, "."); // 中点・全角コロン → 小数点 (地積表記: 150・00, 67：00 → 67.00)
}

// ---------------------------------------------------------------------------
// メインパーサー
// ---------------------------------------------------------------------------

/**
 * 登記事項証明書テキストから構造化データを抽出する。
 * テキストは pdf-parse 等で抽出済みの生文字列を渡す。
 */
export function parseRegistryText(raw: string): RegistryParseResult {
  const warnings: string[] = [];
  let confidence = 0.4;

  // --- 前処理 ---
  const text = cleanRegistryText(raw);

  // --- 不動産番号 ---
  // 例: "不動産番号 0413234567890" / "不動産番号： 1300112345678"
  const reNumMatch = text.match(
    /不動産番号[：:\s]*([0-9０-９\- ]{10,20})/,
  );
  const realEstateNumber = reNumMatch
    ? normalizeNumber(reNumMatch[1].replace(/\s/g, ""))
    : null;
  if (realEstateNumber) confidence += 0.15;

  // --- 所在 ---
  // 例: "所 在 世田谷区玉川一丁目" / "所在及び地番 世田谷区…"
  const addressPatterns = [
    /所\s*在\s+([^\n]+?)(?:\s*地\s*番|\s*地\s*目|$)/,
    /所在及び地番\s+([^\n]+?)(?:\s*地\s*目|$)/,
    /所\s*在[：:\s]+([^\n]+)/,
  ];
  let address: string | null = null;
  for (const p of addressPatterns) {
    const m = text.match(p);
    if (m && m[1].trim()) {
      address = joinSpacedKanji(m[1].trim());
      break;
    }
  }
  // 都道府県で始まる行を候補として補完
  if (!address) {
    const prefMatch = text.match(
      /(東京都|大阪府|京都府|北海道|[^\n]{2,3}県)[^\n]{3,40}/,
    );
    if (prefMatch) address = joinSpacedKanji(prefMatch[0].trim());
  }
  if (address) confidence += 0.1;

  // --- 地番 / 地目 / 地積 ---
  //
  // 全部事項証明書（土地）の表題部は典型的に 2 行構成:
  //   見出し行: "①地 番 ②地 目 ③地 積 ㎡ 原因及びその日付 …"
  //   データ行: "１９３７番３１ 宅地 １５０・００"
  //
  // cleanRegistryText 後は罫線が除去され 1 行に収まる場合もあるため、
  // まず見出し行+次行の2行マッチを試み、失敗時に同一行パターンへフォールバック。

  let lotNumber: string | null = null;
  let landCategory: string | null = null;
  let area: string | null = null;

  // --- 表形式: 見出し行直後のデータ行から一括抽出 ---
  // 見出し行パターン: ①?地番 ... ②?地目 ... ③?地積
  const tableHeaderRe =
    /(?:①\s*)?地\s*番[^\n]*(?:②\s*)?地\s*目[^\n]*(?:③\s*)?地\s*積[^\n]*\n([^\n]+)/;
  const tableMatch = text.match(tableHeaderRe);
  if (tableMatch) {
    const dataLine = normalizeNumber(tableMatch[1].trim());

    // 地番: "1937番31" / "1937-31" / "1937番" など
    const lotM = dataLine.match(
      /([0-9]+番[0-9]*(?:[-－][0-9]+)?|[0-9]+[-－][0-9]+)/,
    );
    if (lotM) lotNumber = lotM[1];

    // 地目: 法定地目リスト
    const catM = dataLine.match(
      /(宅地|山林|田|畑|雑種地|公衆用道路|原野|池沼|水道用地|用悪水路|ため池|墓地|境内地|運河用地|鉄道用地|学校用地|公園|保安林|牧場)/,
    );
    if (catM) landCategory = catM[1];

    // 地積: "150.00" / "150・00" / "67：00" (中点・全角コロンは normalizeNumber で変換済み)
    const areaM = dataLine.match(/([0-9]+\.[0-9]+)/);
    if (areaM) area = areaM[1];
  }

  // --- フォールバック: ラベルと値が同一行にある場合 ---
  if (!lotNumber) {
    const lotPatterns = [
      /地\s*番\s+([0-9０-９\-－番]+)/,
      /地番[：:\s]+([0-9０-９\-－番]+)/,
    ];
    for (const p of lotPatterns) {
      const m = text.match(p);
      if (m && m[1].trim() && m[1].trim().length < 20) {
        lotNumber = normalizeNumber(m[1].trim());
        break;
      }
    }
  }

  if (lotNumber) confidence += 0.05;

  // --- 家屋番号 ---
  const buildingMatch = text.match(
    /家屋番号[：:\s]+([^\n]+?)(?:\n|種\s*類|$)/,
  );
  const buildingNumber = buildingMatch ? buildingMatch[1].trim() : null;

  // --- 地目フォールバック ---
  if (!landCategory) {
    const landCatPatterns = [
      /地\s*目\s+([宅地山林田畑雑種地公衆用道路原野池沼水道用地]+)/,
      /地\s*目[：:\s]+([^\n\s]{2,10})/,
    ];
    for (const p of landCatPatterns) {
      const m = text.match(p);
      if (m) {
        landCategory = m[1].trim();
        break;
      }
    }
  }

  // --- 地積フォールバック ---
  // 例: "地 積 150 00 ㎡" / "地積 150.00㎡" / "地積 150・00"
  if (!area) {
    const areaPatterns = [
      /地\s*積\s+([\d０-９\.・：\s]+)\s*(?:㎡|平方メートル)/,
      /地\s*積[：:\s]+([\d０-９\.・：]+)/,
    ];
    for (const p of areaPatterns) {
      const m = text.match(p);
      if (m) {
        const raw = m[1].trim();
        // "150 00" → "150.00" / "150・00" → "150.00" / "67：00" → "67.00"
        area = normalizeNumber(
          raw.includes(".") || raw.includes("・") || raw.includes("：")
            ? raw
            : raw.replace(/\s+(\d{2})$/, ".$1"),
        );
        break;
      }
    }
  }

  // --- 所有者 ---
  const owners: RegistryOwnerInfo[] = [];

  // 権利部の所有者セクションを探す
  // 典型パターン: "所有者 住所 氏名" が改行区切りで現れる
  const ownerSection = text.match(
    /(?:所有権の登記|所有者|権利者)[^\n]*\n([\s\S]+?)(?:原因|受付年月日|附記|$)/,
  );

  if (ownerSection) {
    const lines = ownerSection[1].split("\n").map((l) => l.trim()).filter(Boolean);
    let currentAddress: string | null = null;
    let currentName: string | null = null;
    let currentShare: string | null = null;

    for (const line of lines) {
      // 持分
      const shareMatch = line.match(/持分\s*([0-9０-９]+分の[0-9０-９]+)/);
      if (shareMatch) {
        currentShare = normalizeNumber(shareMatch[1]);
        continue;
      }
      // 住所行 (都道府県・市区町村で始まる)
      if (
        /^(?:東京都|大阪府|京都府|北海道|.{2,3}県|.{2,3}市|.{2,3}区)/.test(
          line,
        )
      ) {
        if (currentName) {
          owners.push({
            name: joinSpacedKanji(currentName),
            address: currentAddress,
            share: currentShare,
          });
          currentName = null;
          currentShare = null;
        }
        currentAddress = joinSpacedKanji(line);
        continue;
      }
      // 氏名行: 漢字のみ or "カナ" を含む比較的短い行
      if (
        line.length >= 2 &&
        line.length <= 30 &&
        /^[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF ]+$/.test(line) &&
        !/(移記|抹消|登記|法務省令|附則|規定|平成|昭和|令和)/.test(line)
      ) {
        if (currentName && currentAddress) {
          owners.push({
            name: joinSpacedKanji(currentName),
            address: currentAddress,
            share: currentShare,
          });
          currentShare = null;
        }
        currentName = line;
        continue;
      }
    }
    // 最後のオーナーをフラッシュ
    if (currentName) {
      owners.push({
        name: joinSpacedKanji(currentName),
        address: currentAddress,
        share: currentShare,
      });
    }
  }

  // フォールバック: 単純な "所有者" 直後抽出
  if (owners.length === 0) {
    const simpleOwnerMatch = text.matchAll(
      /所有者[：:\s]*([\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF ]{2,20})/g,
    );
    for (const m of simpleOwnerMatch) {
      const name = joinSpacedKanji(m[1].trim());
      if (name && !owners.find((o) => o.name === name)) {
        owners.push({ name, address: null, share: null });
      }
    }
  }

  if (owners.length > 0) confidence += 0.1;

  if (confidence < 0.3) {
    warnings.push("テキストから十分な情報を抽出できませんでした");
  }
  if (!realEstateNumber) {
    warnings.push("不動産番号を抽出できませんでした");
  }

  return {
    realEstateNumber,
    address,
    lotNumber,
    buildingNumber,
    landCategory,
    area,
    owners,
    confidence: Math.min(1, confidence),
    warnings,
  };
}
