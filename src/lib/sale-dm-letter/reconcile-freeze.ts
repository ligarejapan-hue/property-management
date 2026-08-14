/**
 * 既存の型へ凍結印を入れる照合（設計 §2.4 @codex R16/R21）。
 *
 * ⚠**migration では埋めない**。`migrate deploy → restart` の窓では、凍結を知らない
 * 旧ルート（型の設定 PATCH / DELETE）がまだ動いており、印を先に立てると
 * **凍結済みの型を書き換え・削除**できてしまい、照合では復元できない。
 * 新しいコードが動き出してから（restart 後に）1回流すのが安全。
 *
 * 冪等: 印がまだ立っていない型だけを拾うので、何度流しても結果は変わらない。
 */

export interface ReconcileFreezeResult {
  /** 印を立てるべき型の件数（dry-run でもこの数は分かる）。 */
  candidates: number;
  /** 実際に立てた件数（dry-run では 0）。 */
  updated: number;
}

interface VariantClient {
  dmVariant: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    }) => Promise<
      Array<{
        id: string;
        recipients: Array<{ confirmedAt: Date | null; sentAt: Date | null }>;
      }>
    >;
    update: (args: {
      where: { id: string };
      data: { templateFrozenAt: Date };
    }) => Promise<unknown>;
  };
}

export async function reconcileTemplateFreeze(
  client: VariantClient,
  options: { apply: boolean; now?: Date } = { apply: false },
): Promise<ReconcileFreezeResult> {
  const now = options.now ?? new Date();

  // 印がまだ立っていない型のうち、配下に確定/送付済みの宛先があるものだけ。
  const targets = await client.dmVariant.findMany({
    where: {
      templateFrozenAt: null,
      recipients: { some: { status: { in: ["confirmed", "sent"] } } },
    },
    select: {
      id: true,
      recipients: {
        where: { status: { in: ["confirmed", "sent"] } },
        select: { confirmedAt: true, sentAt: true },
      },
    },
  });

  if (!options.apply) return { candidates: targets.length, updated: 0 };

  let updated = 0;
  for (const v of targets) {
    // 値は「その型で最初に確定/送付した時刻」。手がかりが無ければ実行時刻
    //（証拠（確定/送付済みの宛先）はあるので、印そのものは立てる）。
    const stamps = v.recipients
      .flatMap((r) => [r.confirmedAt, r.sentAt])
      .filter((d): d is Date => d != null);
    const at =
      stamps.length > 0
        ? stamps.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b))
        : now;
    await client.dmVariant.update({
      where: { id: v.id },
      data: { templateFrozenAt: at },
    });
    updated += 1;
  }
  return { candidates: targets.length, updated };
}
