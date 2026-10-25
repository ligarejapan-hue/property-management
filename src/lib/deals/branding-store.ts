import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { DEAL_SETTINGS_ID } from "./settings";
import { dealImageMimeFromKey, imageDataUri } from "./branding";

export interface DealBranding {
  /** 書類に埋め込むロゴ・角印(data: の URL)。登録が無い・ファイルが見つからないときは null。 */
  logo: string | null;
  seal: string | null;
}

async function readImage(key: string | null | undefined): Promise<string | null> {
  const mime = key ? dealImageMimeFromKey(key) : null;
  if (!key || !mime) return null;
  try {
    const file = await getStorage().read(key);
    return file ? imageDataUri(mime, file.body) : null;
  } catch {
    return null;
  }
}

/** 書類を作るときのロゴ・角印。読めなければ無しで作る(発行は止めない)。 */
export async function loadDealBranding(): Promise<DealBranding> {
  const row = await prisma.dealSettings.findUnique({ where: { id: DEAL_SETTINGS_ID }, select: { logoKey: true, sealKey: true } });
  const [logo, seal] = await Promise.all([readImage(row?.logoKey), readImage(row?.sealKey)]);
  return { logo, seal };
}
