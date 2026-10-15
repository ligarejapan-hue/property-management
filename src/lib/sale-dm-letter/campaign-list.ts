// 売却DMの発送一覧(画面すっきり化 第1回・2026-10-15)。
//
// 作った発送(キャンペーン)を、あとで開き直す入口が無かった(作成直後の画面遷移だけ)。
// ここは**自分が作った発送だけ**を新しい順に返す=個別の画面(GET campaigns/[id])と同じ
// 「作成者本人のみ」の線を引く。返すのは名前・状態・日時・件数だけで、宛先の氏名・住所・
// 本文(PII)は載せない。
//
// ⚠件数も field_staff は今の担当範囲(作成 or 担当)の宛先だけを数える。個別の画面の
//   件数(filterDraftsByFieldStaffScope 後)と食い違わせない=担当外の宛先の数を漏らさない。

export const CAMPAIGN_LIST_LIMIT = 100;

/**
 * 続きの読み出し位置(@codex #517: 100件より古い発送も開き直せるように)。
 * 並びは(作成日時, id)の新しい順。前ページの最後の行の値をそのまま渡すと、それより古い行から読む。
 */
export interface CampaignCursor {
  createdAt: Date;
  id: string;
}

/** `?before=<ISO日時>_<uuid>` を読む。形が違えば null(=先頭から)。 */
export function parseCampaignCursor(raw: string | null): CampaignCursor | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)_([0-9a-fA-F-]{36})$/.exec(raw);
  if (!m) return null;
  const createdAt = new Date(m[1]);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2].toLowerCase() };
}

export function formatCampaignCursor(c: { createdAt: string; id: string }): string {
  return `${c.createdAt}_${c.id}`;
}

export interface CampaignListPage {
  campaigns: CampaignListItem[];
  /** まだ古い発送があるときの次の位置(無ければ null)。 */
  nextBefore: string | null;
}

export interface CampaignListItem {
  id: string;
  name: string;
  status: "draft" | "ready" | "sent" | "closed";
  createdAt: string;
  /** 自分に見える宛先の数。 */
  recipients: number;
  /** そのうち送付済み(status=sent)の数。 */
  sent: number;
}

interface CampaignRow {
  id: string;
  name: string;
  status: CampaignListItem["status"];
  createdAt: Date;
}

interface CountRow {
  campaignId: string;
  status: string;
  _count: { _all: number };
}

export interface CampaignListDb {
  dmCampaign: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: [{ createdAt: "desc" }, { id: "desc" }];
      take: number;
      select: { id: true; name: true; status: true; createdAt: true };
    }): Promise<CampaignRow[]>;
  };
  dmRecipientDraft: {
    groupBy(args: {
      by: ["campaignId", "status"];
      where: Record<string, unknown>;
      _count: { _all: true };
    }): Promise<CountRow[]>;
  };
}

/** 担当範囲で宛先を絞る条件(field_staff だけ)。filterDraftsByFieldStaffScope と同じ線。 */
export function recipientScopeWhere(session: { id: string; role?: string | null }): Record<string, unknown> | null {
  if (session.role !== "field_staff") return null;
  return { property: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } };
}

export async function listOwnCampaigns(
  db: CampaignListDb,
  session: { id: string; role?: string | null },
  before: CampaignCursor | null = null,
): Promise<CampaignListPage> {
  // 1件多く読み、続きがあるかを知る。作成者本人の線(createdBy)は続きでも必ず掛ける。
  const rows = await db.dmCampaign.findMany({
    where: before
      ? {
          createdBy: session.id,
          OR: [
            { createdAt: { lt: before.createdAt } },
            { createdAt: before.createdAt, id: { lt: before.id } },
          ],
        }
      : { createdBy: session.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CAMPAIGN_LIST_LIMIT + 1,
    select: { id: true, name: true, status: true, createdAt: true },
  });
  const hasMore = rows.length > CAMPAIGN_LIST_LIMIT;
  const campaigns = hasMore ? rows.slice(0, CAMPAIGN_LIST_LIMIT) : rows;
  if (campaigns.length === 0) return { campaigns: [], nextBefore: null };
  const scope = recipientScopeWhere(session);
  const counts = await db.dmRecipientDraft.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((c) => c.id) }, ...(scope ?? {}) },
    _count: { _all: true },
  });
  const tally = new Map<string, { recipients: number; sent: number }>();
  for (const r of counts) {
    const t = tally.get(r.campaignId) ?? { recipients: 0, sent: 0 };
    t.recipients += r._count._all;
    if (r.status === "sent") t.sent += r._count._all;
    tally.set(r.campaignId, t);
  }
  const items = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    recipients: tally.get(c.id)?.recipients ?? 0,
    sent: tally.get(c.id)?.sent ?? 0,
  }));
  return { campaigns: items, nextBefore: hasMore ? formatCampaignCursor(items[items.length - 1]) : null };
}
