/**
 * フォルダ名 → アプリの物件の候補(DB を引いて純関数 matchFolderToProperties に渡す)。
 * - 建物名のある物件は、正規化して比べるため全件(id・建物名・号室・所在地だけ)を1回読む。
 * - 建物名の無い物件(戸建・土地)は、フォルダ名に「○○市△△2丁目」の形があるときだけ所在地で絞って読む。
 */
import prisma from "@/lib/prisma";
import { matchFolderToProperties, parseFolderName, type FolderMatchCandidate, type MatchableProperty } from "./folder-match";

export type PropertyCandidate = FolderMatchCandidate & {
  buildingName: string | null;
  roomNo: string | null;
  address: string;
  /** すでに別のフォルダと紐づいている物件(候補には出すが「紐づけ済」と示す)。 */
  linkedFolderId: string | null;
};

const SELECT = { id: true, buildingName: true, roomNo: true, address: true } as const;

/** フォルダ名から所在地の検索語(「流山市鰭ヶ崎2丁目」のような、市区町村+丁目まで)。無ければ null。 */
export function addressSearchKey(folderName: string): string | null {
  const m = /([^\s　]+?[市区町村郡][^\s　]*?[0-9０-９]+丁目)/.exec(folderName.normalize("NFKC"));
  return m ? m[1] : null;
}

export async function loadNamedProperties(): Promise<MatchableProperty[]> {
  return prisma.property.findMany({ where: { buildingName: { not: null } }, select: SELECT });
}

export async function candidatesForFolderNames(
  folderNames: string[],
  linked: Map<string, string>, // propertyId → folderId
  named?: MatchableProperty[],
): Promise<Map<string, PropertyCandidate[]>> {
  const namedProps = named ?? (await loadNamedProperties());
  const byId = new Map<string, MatchableProperty>(namedProps.map((p) => [p.id, p]));
  const out = new Map<string, PropertyCandidate[]>();
  for (const name of folderNames) {
    const parsed = parseFolderName(name);
    const pool: MatchableProperty[] = [...namedProps];
    const key = parsed.roomNo === null ? addressSearchKey(name) : null;
    if (key) {
      const rows = await prisma.property.findMany({
        where: { buildingName: null, address: { contains: key } },
        select: SELECT,
        take: 20,
      });
      for (const r of rows) {
        pool.push(r);
        byId.set(r.id, r);
      }
    }
    const matched = matchFolderToProperties(parsed, pool).slice(0, 5);
    out.set(
      name,
      matched.map((c) => {
        const p = byId.get(c.propertyId)!;
        return { ...c, buildingName: p.buildingName, roomNo: p.roomNo, address: p.address, linkedFolderId: linked.get(c.propertyId) ?? null };
      }),
    );
  }
  return out;
}
