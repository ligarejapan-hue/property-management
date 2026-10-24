/**
 * Google ドライブ連携(第2段): フォルダ名からアプリの物件の候補を出す純関数。
 * ⚠根拠(建物名の一致・号室の一致・町名の一致)が無い候補は出さない(誤リンク事故の教訓)。
 * 候補はあくまで候補=紐づけるのは人(管理者)。
 */

export type ParsedFolderName = { buildingName: string; roomNo: string | null };

export type MatchableProperty = {
  id: string;
  buildingName: string | null;
  roomNo: string | null;
  address: string;
};

export type MatchReason = "name_room" | "name" | "address";
export type FolderMatchCandidate = { propertyId: string; reason: MatchReason };

/** 全角→半角・空白除去・長音/中黒の揺れ・半角カナ→全角カナ・小文字化。比較専用(表示には使わない)。 */
export function normalizeNameForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[‐-‒–—―ー－-]/g, "ー")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

const ROOM_RE = /[\s　]*([0-9０-９]{1,4})(?:号室|号|室)?[\s　]*$/;

/** 「ハマイハイライズ 305」「西荻リリエンハイム　407号室」→ 建物名と号室。末尾の数字が無ければ号室なし。 */
export function parseFolderName(name: string): ParsedFolderName {
  const trimmed = name.replace(/[\s　]+/g, " ").trim();
  if (trimmed === "") return { buildingName: "", roomNo: null };
  const m = ROOM_RE.exec(trimmed);
  if (m) {
    // 号室と見なすのは「空白で区切られた末尾の数字」か「号室/号/室 で終わる」とき。
    // 「パークハウス2」のように続けて書かれた数字は建物名の一部(号室にしない)。
    const separated = m.index > 0 && /[\s　]/.test(trimmed[m.index]);
    const suffixed = /(号室|号|室)$/.test(trimmed);
    if (separated || suffixed) {
      const building = trimmed.slice(0, m.index).trim();
      if (building !== "") return { buildingName: building, roomNo: String(Number(m[1].normalize("NFKC"))) };
    }
  }
  return { buildingName: trimmed, roomNo: null };
}

/** 所在地から町名らしい部分(市区町村+町名+丁目まで)を取り出す。 */
function townOf(address: string): string {
  const a = address.normalize("NFKC").replace(/\s+/g, "");
  const m = /^(?:.+?[都道府県])?(.+?[市区町村郡].*?(?:[0-9]+丁目|[^0-9]+))/.exec(a);
  return m ? normalizeNameForMatch(m[1]) : "";
}

function normalizedRoom(roomNo: string | null): string | null {
  if (!roomNo) return null;
  const digits = roomNo.normalize("NFKC").replace(/[^0-9]/g, "");
  return digits === "" ? null : String(Number(digits));
}

export function matchFolderToProperties(parsed: ParsedFolderName, properties: MatchableProperty[]): FolderMatchCandidate[] {
  const folderName = normalizeNameForMatch(parsed.buildingName);
  if (folderName.length < 2) return [];
  const out: FolderMatchCandidate[] = [];
  for (const p of properties) {
    const pName = normalizeNameForMatch(p.buildingName ?? "");
    if (pName !== "" && pName === folderName) {
      const pr = normalizedRoom(p.roomNo);
      out.push({ propertyId: p.id, reason: parsed.roomNo !== null && pr !== null && pr === parsed.roomNo ? "name_room" : "name" });
      continue;
    }
    if (pName === "" && parsed.roomNo === null) {
      // 建物名の無い物件(戸建・土地)は、フォルダ名が所在地の町名(丁目まで)を含むときだけ。
      const town = townOf(p.address);
      if (town.length >= 4 && folderName.includes(town)) out.push({ propertyId: p.id, reason: "address" });
    }
  }
  const rank: Record<MatchReason, number> = { name_room: 0, name: 1, address: 2 };
  return out.sort((a, b) => rank[a.reason] - rank[b.reason]);
}
