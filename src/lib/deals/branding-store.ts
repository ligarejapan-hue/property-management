import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { DEAL_SETTINGS_ID } from "./settings";
import { dealImageMimeFromKey, imageDataUri } from "./branding";

export interface DealBranding {
  /** 書類に埋め込むロゴ(data: の URL)。登録が無い・ファイルが見つからないときは null。 */
  logo: string | null;
}

/** 書類を作るときのロゴ。読めなければロゴなしで作る(発行は止めない)。 */
export async function loadDealBranding(): Promise<DealBranding> {
  const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID }, select: { logoKey: true } });
  const key = row?.logoKey;
  const mime = key ? dealImageMimeFromKey(key) : null;
  if (!key || !mime) return { logo: null };
  try {
    const file = await getStorage().read(key);
    return { logo: file ? imageDataUri(mime, file.body) : null };
  } catch {
    return { logo: null };
  }
}
