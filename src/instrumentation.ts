/**
 * Next.js の起動時フック（server 起動のたびに1回）。
 *
 * ⚠ここでの検証は**起動を止める**ためにある（Codex #349 P1）。遅延評価の
 * ガードでは、静的配信（public 配下）のように該当関数を通らない経路を止められず、
 * 「設定が抜けたまま個人情報が公開され続ける」状態を許してしまう。
 */
export async function register(): Promise<void> {
  // Edge ランタイムでは node の fs/path を使う検証を走らせない。
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertUploadRootSafeAtStartup } = await import(
    "@/lib/storage/local-paths"
  );
  assertUploadRootSafeAtStartup();
}
