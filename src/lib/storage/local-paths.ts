/**
 * ローカルストレージのパス解決ヘルパー。
 *
 * - `LocalStorageAdapter` (書き込み側) と `/uploads/[...path]` route handler (読み出し側)
 *   が同一のルートを参照するために共有する。
 * - 既定値は `process.cwd()/public/uploads`（既存互換）。
 *   `LOCAL_UPLOAD_ROOT` 環境変数があれば、それを絶対パスとして優先する。
 *   本番運用でリポジトリ外（例: /var/lib/property-management/uploads）に保存先を
 *   逃がしたい場合に使う。
 */

import fs from "node:fs";
import path from "path";

/**
 * ローカルアップロード保存先のルート絶対パスを返す。
 *
 * - `LOCAL_UPLOAD_ROOT` が設定されていれば優先（trim 済みかつ非空）。
 * - 未設定または空文字なら `process.cwd()/public/uploads`（**開発時のみ**）。
 *
 * ⚠**本番(production)で未設定なら起動時に落とす**（2026-08-02 監査）。既定の
 * `public/uploads` は Next.js の静的配信対象で、認可を実装した `/uploads/[...path]`
 * route より**静的ファイルが優先される**ため、謄本PDF・現地写真が無認証で配信され得る。
 * 「設定を1行消したら個人情報が公開される」構造を、fail-closed（起動不能）に変える。
 * 本番は `LOCAL_UPLOAD_ROOT=/var/lib/property-management/uploads`（public 外）で運用中。
 *
 * 本関数は呼び出しごとに env を見るので、テストや本番起動後の変更にも追従する。
 */
export function getLocalUploadRoot(): string {
  const fromEnv = process.env.LOCAL_UPLOAD_ROOT;
  if (fromEnv && fromEnv.trim() !== "") {
    return path.resolve(fromEnv.trim());
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "LOCAL_UPLOAD_ROOT が未設定です。既定の public/uploads は静的配信されるため、" +
        "本番では public 配下以外の絶対パス（例 /var/lib/property-management/uploads）を必ず設定してください",
    );
  }
  return path.join(process.cwd(), "public", "uploads");
}

/**
 * 起動時の保存先検証（src/instrumentation.ts から呼ぶ・Codex #349 P1）。
 *
 * getLocalUploadRoot() の遅延 throw だけでは**起動を止められない**。
 * public 配下の既存ファイルは Next.js の静的配信で直接返るため、この関数を
 * 一度も通らずに写真・謄本PDFが無認証で配られ得る。よって起動時に落とす。
 *
 * 検査:
 *   1. STORAGE_BACKEND=local(既定) のときだけ対象
 *   2. 本番で LOCAL_UPLOAD_ROOT 未設定 → 起動不可（getLocalUploadRoot が throw）
 *   3. 設定されていても **public 配下を指していたら起動不可**（明示設定でも静的配信される）
 */
export function assertUploadRootSafeAtStartup(): void {
  const isProduction = process.env.NODE_ENV === "production";

  // (A) **backend に関係なく** public/uploads に実ファイルが残っていないか。
  //     Next.js の静的配信は storage adapter と無関係に動くため、過去に local
  //     運用していた頃のファイルが残っていると backend を server/s3 に変えても
  //     無認証で配られ続ける（Codex #349 R2 P1）。
  if (isProduction) {
    const legacy = listPublicUploadFiles();
    if (legacy.length > 0) {
      throw new Error(
        `public/uploads に ${legacy.length} 件のファイルが残っています（例: ${legacy[0]}）。` +
          "public 配下は静的配信され認可チェックを通らないため、" +
          "LOCAL_UPLOAD_ROOT の配下（例 /var/lib/property-management/uploads）へ移動してから起動してください",
      );
    }
  }

  // (B) local backend のときは保存先そのものの妥当性も見る。
  const backend = (process.env.STORAGE_BACKEND ?? "local").trim().toLowerCase();
  if (backend !== "local") return;

  const root = getLocalUploadRoot(); // 未設定の本番はここで throw
  const publicDir = path.resolve(process.cwd(), "public");
  const rel = path.relative(publicDir, root);
  const insidePublic =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (insidePublic && isProduction) {
    throw new Error(
      `LOCAL_UPLOAD_ROOT が public 配下(${root})を指しています。public 配下は静的配信され` +
        "認可チェックを通らないため、public の外（例 /var/lib/property-management/uploads）を指定してください",
    );
  }
}

/**
 * public/uploads 配下の実ファイル（.gitkeep 等の空プレースホルダを除く）を列挙する。
 * 起動時検証のためだけの補助。存在しない/読めない場合は空扱い（起動を止めない）。
 */
function listPublicUploadFiles(limit = 5): string[] {
  const dir = path.resolve(process.cwd(), "public", "uploads");
  const found: string[] = [];
  const walk = (current: string): void => {
    if (found.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 未作成なら何もしない
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const p = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name !== ".gitkeep") {
        found.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * 与えられた storage key を絶対パスに解決し、
 * UPLOAD ROOT 配下に厳密に収まることを検証する。
 *
 * - 絶対パスや `..` を含む key は path traversal として明示的に reject する。
 * - 解決後パスが root と等しい（= ルート自体を指す）場合も reject。
 *
 * 安全に解決できない場合は throw する（呼び出し側で catch して 4xx 等に変換）。
 */
export function resolveSafeUploadPath(key: string): string {
  const root = getLocalUploadRoot();
  // バックスラッシュを正規化してから path.normalize に渡す
  const normalized = path.normalize(key.replace(/\\/g, "/"));

  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid storage key (path traversal blocked): ${key}`);
  }

  const resolved = path.resolve(root, normalized);
  // resolve 後も root 配下であることを再確認（belt-and-suspenders）
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid storage key (escapes upload root): ${key}`);
  }
  return resolved;
}
