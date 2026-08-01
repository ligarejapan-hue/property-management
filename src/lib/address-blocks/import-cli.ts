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
  /** 取込対象の都道府県内で、今回の版以外の残存行(市区町村の改称・合併の名残)を削除する。
   * ⚠都道府県一括の CSV を取り込むときだけ使うこと(一部市区町村だけの取込で使うと
   * 同県の他市区町村の正当なデータまで消える)。 */
  pruneStale: boolean;
  /** 不正行率が閾値(1%)を超えても取込を強行する(既定は停止=壊れたCSVで全置換しない)。 */
  allowSkipped: boolean;
  /** 新データが既存点数の半分未満へ縮んでも置換を強行する(既定は停止=途中で切れたCSVを検知)。 */
  allowShrink: boolean;
  paths: string[];
}

/** 解釈失敗(usage 表示して終了すべき)は null。 */
export function parseImportArgs(argv: string[]): ImportCliOptions | null {
  const paths: string[] = [];
  let version = "";
  let dryRun = false;
  let pruneStale = false;
  let allowSkipped = false;
  let allowShrink = false;
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
    } else if (a === "--prune-stale") {
      pruneStale = true;
    } else if (a === "--allow-skipped") {
      allowSkipped = true;
    } else if (a === "--allow-shrink") {
      allowShrink = true;
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
  return { version, dryRun, pruneStale, allowSkipped, allowShrink, paths };
}
