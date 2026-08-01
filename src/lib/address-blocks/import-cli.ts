/**
 * 取込 CLI (scripts/import-address-blocks.ts) の引数解釈(純関数・テスト対象)。
 *
 * ⚠安全側の設計: 「--version の値の書き忘れ」で次のフラグ(--dry-run 等)を値として
 * 吸い込むと、**試し実行のつもりが本番への実書込み**になり得る(社内レビュー指摘)。
 * `-` で始まる値・未知のフラグは即エラー(null)にして実行させない。
 */

export interface ImportCliOptions {
  version: string;
  dryRun: boolean;
  paths: string[];
}

/** 解釈失敗(usage 表示して終了すべき)は null。 */
export function parseImportArgs(argv: string[]): ImportCliOptions | null {
  const paths: string[] = [];
  let version = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") {
      const v = argv[++i] ?? "";
      // 値の欠落で次のフラグを吸い込まない(例: --version --dry-run <dir> が
      // 「版名=--dry-run の実書込み」になる事故を防ぐ)。
      if (v === "" || v.startsWith("-")) return null;
      version = v;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      return null;
    } else if (a.startsWith("-")) {
      // 未知のフラグをパス扱いしない(タイポで意図しない実行をさせない)。
      return null;
    } else {
      paths.push(a);
    }
  }
  if (!version || paths.length === 0) return null;
  return { version, dryRun, paths };
}
