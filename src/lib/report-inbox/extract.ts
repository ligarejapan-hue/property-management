/**
 * 査定報告書(PDFの文字)から、どの物件の報告書かの手がかりを読む。純関数。
 *
 * 実物(SRE AI査定 CLOUD「不動産価格査定報告書」2026-10-08)の並び(pdf-parse の出力):
 *   1ページ目 … 「不動産価格査定報告書」の次に「(マンション名 305号室)」。その下の住所は**御社の住所**
 *   「物件詳細」の表 … 「名称 \t マンション名 305号室」「所有地 \t 東京都…4丁目12ー3」(見出しと値が1行・タブ区切り)
 *   ⚠目次にも「物件詳細」が出るので、見出しの語を目印にはしない(「名称」「所有地」の行を直接探す)。
 * ⚠pdf-parse は「田」「谷」「月」などを**部首の文字**(⽥ ⾕ ⽉)で返す=NFKC で普通の漢字に戻してから読む。
 *   制御文字(\u0001 など)も混じる。
 * ⚠**依頼者の氏名は読まない・返さない**(1ページ目の「◯◯様」)。物件を探す手がかりだけを返す。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */
import { splitRoomFromBuildingName } from "@/lib/paste-import/source-profiles";

export interface ReportClues {
  source: "sre" | "unknown";
  buildingName: string | null;
  roomNo: string | null;
  address: string | null;
}

function normalizeLine(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[ 　]+/g, " ")
    .trim();
}

/** 「見出し \t 値」または「見出し」の次の行が値。最初に見つかったものを返す。 */
function labeledValue(lines: string[], labels: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    for (const label of labels) {
      const line = lines[i];
      if (line === label) {
        const next = lines[i + 1];
        if (next && !labels.includes(next)) return next;
        continue;
      }
      const m = new RegExp(`^${label}\\s*\\t\\s*(.+)$`).exec(line);
      if (m && m[1].trim() !== "") return m[1].trim();
    }
  }
  return null;
}

export function extractReportClues(text: string): ReportClues {
  // タブは見出しと値の区切りなので残す(他の空白はまとめる)。
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.split("\t").map(normalizeLine).join("\t").replace(/^\t+|\t+$/g, ""))
    .filter((l) => l !== "");

  const isSre = lines.some((l) => l.includes("不動産価格査定報告書"));

  let name = labeledValue(lines, ["名称", "物件名", "マンション名"]);
  if (name === null && isSre) {
    // 1ページ目の「(マンション名 305号室)」。表題の直後の行だけを見る(御社の住所などを拾わない)。
    const t = lines.findIndex((l) => l.includes("不動産価格査定報告書"));
    const m = t >= 0 ? /^[（(](.+)[）)]$/.exec(lines[t + 1] ?? "") : null;
    if (m) name = m[1].trim();
  }
  const address = labeledValue(lines, ["所有地", "所在地", "物件所在地"]);

  let buildingName: string | null = null;
  let roomNo: string | null = null;
  if (name !== null && name !== "-") {
    const split = splitRoomFromBuildingName(name);
    buildingName = split.buildingName || null;
    roomNo = split.roomNo;
  }

  return {
    source: isSre ? "sre" : "unknown",
    buildingName,
    roomNo,
    address: address !== null && address !== "-" ? address : null,
  };
}
