/**
 * 確定で、控えの行ごとに送付記録を「作る」か「再利用する」かを決める(設計 2026-10-03 §5.2)。
 * 再利用=確定前に配信停止が来て、その1通の記録を先に作ってあった行。作り直すと記録が2件になり、
 * 「何通目」が狂い、拒否が付いていない方の記録が残る。
 */
export function planConfirmLogs(
  items: Array<{ id: string; logId: string | null; logExists: boolean }>,
): { reuse: Array<{ itemId: string; logId: string }>; create: string[] } {
  const reuse: Array<{ itemId: string; logId: string }> = [];
  const create: string[] = [];
  for (const it of items) {
    if (it.logId && it.logExists) reuse.push({ itemId: it.id, logId: it.logId });
    else create.push(it.id);
  }
  return { reuse, create };
}
