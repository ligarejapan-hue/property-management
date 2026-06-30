export const dmUndeliverableBadgeLabel = "宛先不明";

export function isDmUndeliverable(
  dmUndeliverableAt: string | null | undefined,
): boolean {
  return typeof dmUndeliverableAt === "string" && dmUndeliverableAt.length > 0;
}

type PermissionLike = { resource: string; action: string; granted: boolean };

// 売却DM作成の表示可否。csv_export + csv_export_personal + owner の read に加え、
// 有料AI生成の専用権限 sale_dm:generate(action=generate)も要求する。
// これが無いと作成ボタンを押しても server(campaigns POST)が 403 にするため、UI でも非表示にし
// 「押せるのに実行できない」操作を見せない。permissions=null(未取得・取得失敗)は fail-safe で false。
export function canCreateSaleDm(perms: PermissionLike[] | null): boolean {
  if (!perms) return false;
  const has = (resource: string) =>
    perms.some((p) => p.resource === resource && p.action === "read" && p.granted);
  const canGenerate = perms.some((p) => p.resource === "sale_dm" && p.action === "generate" && p.granted);
  return has("csv_export") && has("csv_export_personal") && has("owner") && canGenerate;
}

// 作成API の部分生成を操作者に伝える文面。確認文は「現在の絞り込み対象を生成」と言うため、
// (a) truncated=上限超で先頭一部のみ生成 (b) failed=一部の宛先で生成失敗(本文空) を見落とさせないよう、
// 作業画面へ遷移する前に通知する。全件生成・フィールド欠落(古い/mock レスポンス)は null(通知不要)。
export function buildSaleDmPartialNotice(res: {
  generated?: number;
  failed?: number;
  truncated?: boolean;
}): string | null {
  const lines: string[] = [];
  if (res.truncated) {
    lines.push(
      `対象が一度に生成できる上限を超えたため、先頭の ${res.generated ?? 0} 件のみ生成しました(残りは未生成です)。`,
    );
  }
  if ((res.failed ?? 0) > 0) {
    lines.push(
      `${res.failed} 件は生成に失敗し本文が空です(作業画面で再生成してください)。`,
    );
  }
  if (lines.length === 0) return null;
  return `一部の宛先は完全には生成されていません:\n${lines.join("\n")}`;
}
