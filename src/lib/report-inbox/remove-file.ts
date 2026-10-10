/**
 * 受け取り箱のファイルを消し、**もう読めないこと**を確かめる。
 * ⚠このサーバーのディスク版(LocalStorageAdapter)は削除の失敗を黙って飲み込むので、
 *   「消したつもりで残る」を読み直して見つける。消せていれば true。
 * ⚠「もう無いファイルを消す」は両方の保存先とも成功扱い=何度呼んでも安全。
 */
import type { StorageAdapter } from "@/lib/storage/types";

export async function removeFileAndVerify(storage: StorageAdapter, key: string | null): Promise<boolean> {
  if (key === null) return true;
  try {
    await storage.delete(key);
    return (await storage.read(key)) === null;
  } catch (e) {
    console.error("[report-inbox] delete failed", (e as { code?: unknown })?.code ?? "");
    return false;
  }
}
