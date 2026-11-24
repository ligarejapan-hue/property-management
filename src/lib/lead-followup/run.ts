import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { writeAuditLog } from "@/lib/audit";
import { MAIL_CONFIG_ID, loadMailSendConfig, type MailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail, safeErrorCode } from "@/lib/mail/transport";
import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";
import { buildFollowupFooter, composeFollowupText, type FollowupSender } from "./footer";
import { buildFollowupUnsubscribeUrl } from "./unsubscribe-token";
import { followupLockKey } from "./unsubscribe-record";
import { loadFollowupSetupContext } from "./settings-store";
import {
  FOLLOWUP_PROPERTY_INTRODUCTION_ROUTES,
  FOLLOWUP_SERIES,
  followupStepsEnableProblems,
  type FollowupSeries,
  type FollowupStepsBySeries,
} from "./steps";
import { classifyInquiry, classifyProperty, decideFollowup, initialNewPosition, type CaseClass, type DecideRow } from "./decide";
import { dmExclusionReason, findTerminalExclusions, type TerminalExclusionTx } from "@/lib/dm-batch/terminal-exclusion";
import { lockOwnersForShare, lockPropertiesForShare, sortUniqueIds, type RawTx } from "@/lib/dm-batch/locks";

// 対象の導入ルートの決まり(と理由)は steps.ts(設定の画面からも読むため画面でも読める場所に置く)。
export { FOLLOWUP_PROPERTY_INTRODUCTION_ROUTES };

/**
 * 追客メールの1回分の実行(15分おきの timer から・設計 2026-11-16 §2・§3)。
 * 1. OFF なら進行中を全部止めて終わり(disabled)
 * 2. 送っている途中(sending)のまま30分を過ぎた行を止める(interrupted=届いたか分からないので送り直さない)
 * 3. 送るのに足りないもの(SMTP・会社の設定・外向きの URL・鍵・文面)があれば、行に触らず終わり
 * 4. 新しい対象を見つけて行を作る(対象の導入ルートの物件=FOLLOWUP_PROPERTY_INTRODUCTION_ROUTES・2026-11-24 一括査定から広げた・
 *    DM 送付不可と業者と同じ名前/自治体・国の所有者の物件は除く。受付メールが届いた査定申込。2026-11-19 発注者: ON にする前からいるお客様も対象。
 *    その場合は登録日・申込日から数えて、次に日が来る通から=initialNewPosition)
 * 5. 進行中の行を1つずつ見て、送る/飛ばす/待つ/保留へ移る/止める/終わり を決めて書く
 *
 * 守り:
 * - 送るのは日本時間 9:00〜20:00 の実行だけ・1回の上限(既定20通)・1アドレス1日1通(直近20時間)
 * - 1通ごとに アドレス単位の鍵 → 配信停止の確かめ → active→sending の取り合い。勝った1回だけが送る
 * - 送り終えた書き戻しは sending のときだけ(その間に止められた行を進行中に戻さない)
 * - 失敗したら止める(送り直さない)
 * - 監査・応答に宛先・件名・本文・SMTP の応答は入れない(定型コードだけ)
 */

const STALE_SENDING_MS = 30 * 60_000;
const DAILY_GAP_MS = 20 * 3_600_000;
const SEND_HOURS_JST = { from: 9, to: 20 };
const DEFAULT_MAX_SENDS = 20;
const DISCOVER_LIMIT = 100;
const EVALUATE_LIMIT = 2000;
const CHUNK = 200;
const MAX_STEPS_PER_ROW = 12;
/**
 * 本文を渡す前に失敗したことが確かなコード(名前が引けない・つながらない・ログインできない・暗号化できない)。
 * この失敗では止めずに次の回へ回す。
 * ⚠ECONNECTION は入れない: 相手が本文を受け取ったあとで接続が切れても ECONNECTION になる(届いているかもしれない)。
 *   ほかの失敗と同じく、届いたか分からない=その追客を止める(送り直さない・@codex #757 P1)。
 */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "EDNS", "ENOTFOUND", "EAI_AGAIN", "EAUTH", "ETLS"]);

/**
 * 物件の追客から外す理由(行を作るとき・進行中の行を見るとき・送る直前の読み直しで同じに見る)。
 * - dm_no_send: DM 送付不可の物件(手紙を送らないと決めた物件にはメールも送らない)
 * - owner_excluded: 今の所有者に、業者の名簿と同じ名前の人、または名前が自治体・国の人がいる
 *   (DM と同じ判定=dm-batch/agent-name-exclusion.ts の findOwnerNameExclusions。ご本人から知らせたアドレスとは
 *   言えない・営業のメールを送る相手ではない、という DM と同じ理由)。外字の名前はメールでは宛名を刷らないので外さない。
 * - dm_refused: DM の拒否・解除していない宛先不明の記録がある(セキュリティレビュー 2026-11-24)。拒否は送付不可に
 *   ならないこともあるので、DM の作成・印刷と同じ dm-batch/terminal-exclusion.ts の findTerminalExclusions で見る
 *   (代表の所有者・共有者・所有者に紐づかない物件の記録の3経路。「一度お断りをいただいた方へ、また連絡が行く」を防ぐ)。
 *   手紙の QR から来た査定申込は、その手紙の物件・所有者で同じに見る(広告の公開ページの申込は物件・所有者に結べないので見ない)。
 * 判定は DM と同じ dmExclusionReason の順(拒否・宛先不明 → 業者と同じ名前 → 自治体・国)。
 */
type FollowupExclusion = "dm_no_send" | "owner_excluded" | "dm_refused";

type ExclusionReader = Pick<Prisma.TransactionClient, "$queryRaw" | "propertyDmLog">;

type PropertyForExclusion = {
  id: string;
  dmStatus?: string | null;
  propertyOwners: Array<{ owner: { id?: string } }>;
};

type InquiryDraftLink = {
  propertyId: string;
  representativeOwnerId: string | null;
  draftOwners: Array<{ ownerId: string }>;
} | null;

/** 査定申込の手紙の物件・所有者(代表と共有者)を読むための select。 */
const INQUIRY_DRAFT_SELECT = {
  select: { propertyId: true, representativeOwnerId: true, draftOwners: { select: { ownerId: true } } },
};

function draftOwnerIds(d: NonNullable<InquiryDraftLink>): string[] {
  return [...(d.representativeOwnerId ? [d.representativeOwnerId] : []), ...d.draftOwners.map((o) => o.ownerId)];
}

/** DM の除外セット(DM の作成・印刷と同じ関数。DB の照会もそのまま)。 */
function dmExclusionSets(client: ExclusionReader, ownerIds: string[], propertyIds: string[]) {
  return findTerminalExclusions(client as unknown as TerminalExclusionTx, ownerIds, propertyIds);
}

/** 物件ごとの外す理由(無ければ入れない)。DM の除外セットは1回だけ引く。 */
async function propertyExclusions(client: ExclusionReader, props: PropertyForExclusion[]): Promise<Map<string, FollowupExclusion>> {
  const out = new Map<string, FollowupExclusion>();
  if (props.length === 0) return out;
  const ownersOf = (p: PropertyForExclusion) => p.propertyOwners.flatMap((o) => (o.owner.id ? [o.owner.id] : []));
  const sets = await dmExclusionSets(client, props.flatMap(ownersOf), props.map((p) => p.id));
  for (const p of props) {
    if (p.dmStatus === "no_send") {
      out.set(p.id, "dm_no_send");
      continue;
    }
    const reason = dmExclusionReason(sets, { propertyId: p.id, ownerIds: ownersOf(p) });
    if (reason === "terminal") out.set(p.id, "dm_refused");
    else if (reason === "agent_name" || reason === "public_name") out.set(p.id, "owner_excluded");
  }
  return out;
}

/** 手紙の QR から来た査定申込で、その手紙の物件・所有者に DM の拒否・宛先不明があるもの(dm_refused)。 */
async function inquiryExclusions(
  client: ExclusionReader,
  inqs: Array<{ id: string; draft?: InquiryDraftLink }>,
): Promise<Map<string, FollowupExclusion>> {
  const out = new Map<string, FollowupExclusion>();
  const linked = inqs.flatMap((q) => (q.draft ? [{ id: q.id, draft: q.draft }] : []));
  if (linked.length === 0) return out;
  const sets = await dmExclusionSets(
    client,
    linked.flatMap((q) => draftOwnerIds(q.draft)),
    linked.map((q) => q.draft.propertyId),
  );
  for (const q of linked) {
    if (dmExclusionReason(sets, { propertyId: q.draft.propertyId, ownerIds: draftOwnerIds(q.draft) }) === "terminal") {
      out.set(q.id, "dm_refused");
    }
  }
  return out;
}

const CLOSED_CASE_STATUSES = [
  "negotiating",
  "brokerage_obtained",
  "on_sale",
  "contract_planned",
  "contracted",
  "sold",
  "other_brokerage",
  "closed",
  "lead_exclusion_requested",
  "lead_excluded",
  "done",
] as const;

export type FollowupRunSummary = {
  enabled: boolean;
  ready: boolean;
  /** 送れない理由の数(中身は出さない=設定の画面で見る) */
  notReadyCount: number;
  started: number;
  startedStopped: number;
  /** 前からいるお客様で、新規の流れが全部過ぎていた(保留でもない)ので、送らずに完了として作った数 */
  startedCompleted: number;
  interrupted: number;
  disabledStopped: number;
  evaluated: number;
  /** 1行の判断で例外が出た数(その行は次の回にもう一度見る) */
  errors: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  completed: number;
  stopped: number;
};

export type FollowupRunOptions = {
  maxSends?: number;
  /** この時刻(ms)を過ぎたら新しい送信・新しい行の判断を始めない */
  deadline?: number;
  sendMail?: typeof sendPlainMail;
};

/** 宛先のアドレスを比べる形にする。形がおかしいものは null(送らない)。 */
export function normalizeFollowupEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 254 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(v)) return null;
  return v.toLowerCase();
}

export function isWithinSendHoursJst(now: Date): boolean {
  const h = (now.getUTCHours() + 9) % 24;
  return h >= SEND_HOURS_JST.from && h < SEND_HOURS_JST.to;
}

function maxSendsFromEnv(): number {
  const n = Number(process.env.LEAD_FOLLOWUP_MAX_SENDS_PER_RUN);
  return Number.isInteger(n) && n >= 0 && n <= 200 ? n : DEFAULT_MAX_SENDS;
}

async function lockEmail(tx: { $executeRaw: typeof prisma.$executeRaw }, email: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${followupLockKey(email)})::bigint)`;
}

type TxLike = {
  $queryRaw: typeof prisma.$queryRaw;
  mailConfig: { findUnique: typeof prisma.mailConfig.findUnique };
};

/**
 * 設定の行を押さえて、今も ON で、この実行が見た「ON にした時刻」のままかを確かめる(@codex #757 P2)。
 * 画面の保存(ON→OFF で進行中を止める)も同じ行を書き換えるので、ここで押さえると順番がそろう:
 * - 保存が先 → こちらは OFF(か別の ON の期間)を読んで何もしない
 * - こちらが先 → 保存はこの transaction の終わりを待ち、そのあとで進行中を止める=作った行も止まる
 */
async function lockEnabledPeriod(tx: TxLike, enabledAt: Date): Promise<boolean> {
  // 生の SQL は押さえるだけ(時刻を生の SQL で読むと、DB の部品の癖で時差がずれることがある)。値は Prisma で読む。
  await tx.$queryRaw`SELECT 1 FROM mail_config WHERE id = ${MAIL_CONFIG_ID} FOR UPDATE`;
  const r = await tx.mailConfig.findUnique({
    where: { id: MAIL_CONFIG_ID },
    select: { followupEnabled: true, followupEnabledAt: true },
  });
  return !!r && r.followupEnabled === true && !!r.followupEnabledAt && r.followupEnabledAt.getTime() === enabledAt.getTime();
}

async function loadSteps(): Promise<FollowupStepsBySeries> {
  const rows = await prisma.leadFollowupStep.findMany({
    orderBy: [{ series: "asc" }, { position: "asc" }],
    select: { series: true, delayDays: true, subject: true, body: true },
  });
  const steps: FollowupStepsBySeries = { new: [], hold: [] };
  for (const r of rows) {
    if ((FOLLOWUP_SERIES as readonly string[]).includes(r.series)) {
      steps[r.series as FollowupSeries].push({ delayDays: r.delayDays, subject: r.subject, body: r.body });
    }
  }
  return steps;
}

const OWNER_EMAILS_SELECT = {
  where: { endDate: null },
  orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  // id は業者と同じ名前・自治体や国の所有者の判定に使う(今の所有者の全員を見る)
  select: { owner: { select: { id: true, email: true } } },
};

/** 物件の最初の所有者のうち、メールがある1人のアドレス(元の書き方・比べる形)。 */
function firstOwnerEmail(owners: Array<{ owner: { email: string | null } }>): { raw: string; normalized: string } | null {
  for (const o of owners) {
    const normalized = normalizeFollowupEmail(o.owner.email);
    if (normalized && o.owner.email) return { raw: o.owner.email.trim(), normalized };
  }
  return null;
}

type StartTarget = { kind: "property"; id: string } | { kind: "inquiry"; id: string };

/** 行を作る。配信停止のアドレス・同じアドレスで進行中の追客があれば、止めた行として作る(毎回見直さないため)。 */
async function startFollowup(
  target: StartTarget,
  email: string | null,
  startedAt: Date,
  now: Date,
  enabledAt: Date,
  newNextPosition: number,
  /** 新規の流れが全部過ぎていて保留でもない=送るものが無い。進行中で作るとアドレスを塞ぐので完了で作る(@codex #762 P2) */
  nothingToSend: boolean,
  /** 追客から外す理由(DM の拒否・業者と同じ名前・自治体や国の所有者)。あれば止めた行として作る(毎回見直さないため) */
  excluded: FollowupExclusion | null = null,
): Promise<"active" | "stopped" | "completed" | "exists"> {
  return prisma.$transaction(async (tx) => {
    // 探している最中に OFF(や OFF→ON)にされていたら作らない。
    if (!(await lockEnabledPeriod(tx, enabledAt))) return "exists";
    let status = "active";
    let stopReason: string | null = null;
    if (excluded) {
      status = "stopped";
      stopReason = excluded;
    } else if (!email) {
      status = "stopped";
      stopReason = "no_address";
    } else {
      await lockEmail(tx, email);
      const unsub = await tx.mailUnsubscribe.findUnique({ where: { emailNormalized: email }, select: { id: true } });
      const active = unsub
        ? null
        : await tx.leadFollowup.findFirst({
            where: { emailNormalized: email, status: { in: ["active", "sending"] } },
            select: { id: true },
          });
      if (unsub) {
        status = "stopped";
        stopReason = "unsubscribed";
      } else if (nothingToSend) {
        status = "completed";
      } else if (active) {
        status = "stopped";
        stopReason = "duplicate_address";
      }
    }
    const created = await tx.leadFollowup.createMany({
      data: [
        {
          targetType: target.kind,
          ...(target.kind === "property" ? { propertyId: target.id } : { inquiryId: target.id }),
          emailNormalized: email,
          status,
          stopReason,
          newStartedAt: startedAt,
          newNextPosition,
          ...(status === "stopped" ? { stoppedAt: now } : {}),
        },
      ],
      // 担当が先に「追客を止める」で印を作っていた・別の実行が先に作った、は何もしない。
      skipDuplicates: true,
    });
    if (created.count === 0) return "exists";
    return status === "active" ? "active" : status === "completed" ? "completed" : "stopped";
  });
}

function countStart(r: "active" | "stopped" | "completed" | "exists", summary: FollowupRunSummary) {
  if (r === "active") summary.started += 1;
  else if (r === "stopped") summary.startedStopped += 1;
  else if (r === "completed") summary.startedCompleted += 1;
}

async function discover(
  enabledAt: Date,
  now: Date,
  deadline: number,
  steps: FollowupStepsBySeries,
  summary: FollowupRunSummary,
) {
  const properties = await prisma.property.findMany({
    where: {
      introductionRoute: { in: [...FOLLOWUP_PROPERTY_INTRODUCTION_ROUTES] },
      // DM 送付不可の物件は探さない(行も作らない=あとで送付可に戻せば対象になる)
      dmStatus: { not: "no_send" },
      leadFollowup: { is: null },
      caseStatus: { notIn: [...CLOSED_CASE_STATUSES] },
      // メールのある所有者がいる物件だけ(メールの無い物件で毎回の上限を埋めない)。
      propertyOwners: { some: { endDate: null, owner: { email: { not: null }, NOT: { email: "" } } } },
    },
    orderBy: { createdAt: "asc" },
    take: DISCOVER_LIMIT,
    select: { id: true, createdAt: true, caseStatus: true, dmStatus: true, propertyOwners: OWNER_EMAILS_SELECT },
  });
  // DM の拒否・業者と同じ名前・自治体や国の所有者がいる物件は SQL の条件にできない(DM と同じ判定を使う)ので、ここで見る。
  // 止めた行として作る=次の回に同じ物件で探す枠を埋めない。
  const excludedProps = await propertyExclusions(prisma, properties);
  for (const p of properties) {
    if (Date.now() > deadline) return;
    const email = firstOwnerEmail(p.propertyOwners);
    const pos = initialNewPosition(p.createdAt, enabledAt, now, steps);
    const r = await startFollowup(
      { kind: "property", id: p.id },
      email?.normalized ?? null,
      p.createdAt,
      now,
      enabledAt,
      pos,
      pos > steps.new.length && classifyProperty(p.caseStatus) !== "hold",
      excludedProps.get(p.id) ?? null,
    );
    countStart(r, summary);
  }

  const inquiries = await prisma.dmInquiry.findMany({
    where: {
      autoReplyStatus: "sent",
      handleStatus: { not: "done" },
      email: { not: null },
      leadFollowup: { is: null },
    },
    orderBy: { submittedAt: "asc" },
    take: DISCOVER_LIMIT,
    select: { id: true, submittedAt: true, email: true, draft: INQUIRY_DRAFT_SELECT },
  });
  const excludedInqs = await inquiryExclusions(prisma, inquiries);
  for (const q of inquiries) {
    if (Date.now() > deadline) return;
    const pos = initialNewPosition(q.submittedAt, enabledAt, now, steps);
    const r = await startFollowup(
      { kind: "inquiry", id: q.id },
      normalizeFollowupEmail(q.email),
      q.submittedAt,
      now,
      enabledAt,
      pos,
      // 査定申込には保留の流れが無い
      pos > steps.new.length,
      excludedInqs.get(q.id) ?? null,
    );
    countStart(r, summary);
  }
}

type ActiveRow = DecideRow & {
  id: string;
  propertyId: string | null;
  inquiryId: string | null;
  emailNormalized: string | null;
};

type TargetState = {
  cls: CaseClass;
  email: { raw: string; normalized: string } | null;
  /** 追客から外す理由(物件: DM 送付不可・DM の拒否・業者と同じ名前や自治体・国の所有者/申込: 手紙の物件・所有者に DM の拒否) */
  excluded: FollowupExclusion | null;
} | null;

type TargetReader = Pick<Prisma.TransactionClient, "property" | "dmInquiry" | "$queryRaw" | "propertyDmLog">;

/** 行の対象(物件・申込)の今の状態とアドレス。client は送る直前の読み直しでは transaction を渡す。 */
async function loadTargets(rows: ActiveRow[], client: TargetReader = prisma): Promise<Map<string, TargetState>> {
  const propIds = rows.flatMap((r) => (r.propertyId ? [r.propertyId] : []));
  const inqIds = rows.flatMap((r) => (r.inquiryId ? [r.inquiryId] : []));
  const [props, inqs] = await Promise.all([
    propIds.length
      ? client.property.findMany({
          where: { id: { in: propIds } },
          select: { id: true, caseStatus: true, dmStatus: true, propertyOwners: OWNER_EMAILS_SELECT },
        })
      : Promise.resolve([]),
    inqIds.length
      ? client.dmInquiry.findMany({
          where: { id: { in: inqIds } },
          select: { id: true, handleStatus: true, email: true, draft: INQUIRY_DRAFT_SELECT },
        })
      : Promise.resolve([]),
  ]);
  // 外す理由も同じ client で読む(送る直前の読み直しでは鍵の下の transaction=途中で送付不可・拒否になった物件で止まる)。
  const excludedProps = await propertyExclusions(client, props);
  const excludedInqs = await inquiryExclusions(client, inqs);
  const byProp = new Map(props.map((p) => [p.id, p]));
  const byInq = new Map(inqs.map((q) => [q.id, q]));
  const out = new Map<string, TargetState>();
  for (const r of rows) {
    if (r.targetType === "property" && r.propertyId) {
      const p = byProp.get(r.propertyId);
      out.set(
        r.id,
        p
          ? { cls: classifyProperty(p.caseStatus), email: firstOwnerEmail(p.propertyOwners), excluded: excludedProps.get(p.id) ?? null }
          : null,
      );
    } else if (r.targetType === "inquiry" && r.inquiryId) {
      const q = byInq.get(r.inquiryId);
      const normalized = normalizeFollowupEmail(q?.email);
      out.set(
        r.id,
        q
          ? { cls: classifyInquiry(q.handleStatus), email: normalized && q.email ? { raw: q.email.trim(), normalized } : null, excluded: excludedInqs.get(q.id) ?? null }
          : null,
      );
    } else {
      out.set(r.id, null);
    }
  }
  return out;
}

function guardWhere(row: ActiveRow) {
  return {
    id: row.id,
    status: "active",
    newNextPosition: row.newNextPosition,
    holdNextPosition: row.holdNextPosition,
  };
}

function advanceData(series: FollowupSeries, position: number) {
  return series === "new" ? { newNextPosition: position + 1 } : { holdNextPosition: position + 1 };
}

async function stopRow(row: ActiveRow, reason: string, now: Date): Promise<boolean> {
  const r = await prisma.leadFollowup.updateMany({
    where: { id: row.id, status: "active" },
    data: { status: "stopped", stopReason: reason, stoppedAt: now, claimedAt: null },
  });
  return r.count > 0;
}

type SendContext = {
  steps: FollowupStepsBySeries;
  sender: FollowupSender;
  baseUrl: string;
  key: Buffer;
  mailConfig: MailSendConfig;
  sendMail: typeof sendPlainMail;
  maxSends: number;
  deadline: number;
  /** 送信に失敗したら、その回はもう送らない(メールサーバーの不調で大勢を一度に止めないため) */
  halted: boolean;
  /** この実行が見た「ON にした時刻」(送る直前にまだこの期間かを確かめる) */
  enabledAt: Date;
};

type LockTx = Pick<Prisma.TransactionClient, "property" | "dmInquiry" | "$queryRaw">;

/** 押さえる所有者(今の所有者・手紙の代表と共有者)と物件。結べない申込(広告の公開ページ)は null。 */
async function readLockTargets(tx: LockTx, row: ActiveRow): Promise<{ ownerIds: string[]; propertyId: string } | null> {
  if (row.targetType === "property" && row.propertyId) {
    const p = await tx.property.findUnique({
      where: { id: row.propertyId },
      // 外す理由の判定(OWNER_EMAILS_SELECT)と同じ「今の所有者」
      select: { id: true, propertyOwners: { where: { endDate: null }, select: { ownerId: true } } },
    });
    return p ? { ownerIds: sortUniqueIds(p.propertyOwners.map((o) => o.ownerId)), propertyId: p.id } : null;
  }
  if (row.targetType === "inquiry" && row.inquiryId) {
    const q = await tx.dmInquiry.findUnique({ where: { id: row.inquiryId }, select: { draft: INQUIRY_DRAFT_SELECT } });
    return q?.draft ? { ownerIds: sortUniqueIds(draftOwnerIds(q.draft)), propertyId: q.draft.propertyId } : null;
  }
  return null;
}

/**
 * 送る直前に、対象の所有者と物件を FOR SHARE で押さえる(@codex #782 P2)。
 * findTerminalExclusions の決まり(terminal-exclusion.ts: 所有者と物件の親行を押さえたまま照会し、状態を移し終えるまで持つ)に従う。
 * DM の拒否を書く側(反響の保存 dm-logs/[logId]/reaction・手紙の配信停止 /u/[token])は 所有者 FOR UPDATE → 物件の親行 の順で
 * 押さえて書くので、ここで押さえれば「照会したあと、取り合い(sending)の前に拒否が入る」が起きない。
 *
 * 押さえる順番(この transaction 全体): 設定の行(mail_config FOR UPDATE)→ アドレスの鍵(advisory)→ 所有者(id 順 FOR SHARE)
 *   → 物件(FOR SHARE)→ 追客の行(lead_followups の更新)。
 * 待ち合いにならない理由:
 * - 所有者 → 物件 は DM の書き手の決まり(dm-batch/locks.ts「Owner → 物件親行 → 子行」)と同じ向き・同じ id 順の文。
 * - 設定の行とアドレスの鍵を取るのは追客だけ(行を作る startFollowup・配信停止の記録・設定の保存)で、どれも所有者・物件を押さえない。
 *   所有者・物件を押さえる側(DM の書き手・物件の編集)は設定の行もアドレスの鍵も取らない=逆向きの待ちが無い。
 * - 追客を手で止める API は 物件 → 追客の行 の順で、ここも 物件 → 追客の行 の順(押さえるより前に追客の行を書かない)。
 * 押さえる前に読んだ所有者の顔ぶれと、押さえたあとに読み直した顔ぶれが違えば(名寄せの付け替えなど)false=送らずに次の回へ。
 */
async function lockTargetOwnersAndProperty(tx: LockTx, row: ActiveRow): Promise<boolean> {
  const pre = await readLockTargets(tx, row);
  if (!pre) return true;
  await lockOwnersForShare(tx as unknown as RawTx, pre.ownerIds);
  await lockPropertiesForShare(tx as unknown as RawTx, [pre.propertyId]);
  const again = await readLockTargets(tx, row);
  return (
    !!again &&
    again.propertyId === pre.propertyId &&
    again.ownerIds.length === pre.ownerIds.length &&
    again.ownerIds.every((id, i) => id === pre.ownerIds[i])
  );
}

/** 1通を送る(鍵 → 配信停止の確かめ → 取り合い → 送る → 書き戻し)。 */
async function sendOne(
  row: ActiveRow,
  to: { raw: string; normalized: string },
  series: FollowupSeries,
  position: number,
  ctx: SendContext,
  now: Date,
  summary: FollowupRunSummary,
): Promise<void> {
  let prevLastSentAt: Date | null = null;
  const claim = await prisma.$transaction(async (tx) => {
    // 押さえる順番は 設定の行 → アドレスの鍵(行を作る startFollowup と同じ。逆だと重なった実行どうしで待ち合う・@codex #757 P2)。
    // 実行の途中で画面から OFF にされていたら送らない(OFF の保存は進行中を止めるが、この回が後から作った行もある)。
    if (!(await lockEnabledPeriod(tx, ctx.enabledAt))) return "disabled";
    await lockEmail(tx, to.normalized);
    // 所有者・物件を押さえてから外す理由を見る(@codex #782 P2)。押さえた状態は取り合い(sending)まで持つ。
    if (!(await lockTargetOwnersAndProperty(tx, row))) return "changed";
    // 対象の今の状態とアドレスを読み直す(先に読んだ状態は数分前のことがある。その間に担当が「対応済み」・
    // 商談中などにしていたら、ここで気づいて送らない=次の回の判断に任せる・@codex #757 P2)。
    const fresh = (await loadTargets([row], tx)).get(row.id) ?? null;
    if (fresh?.excluded) {
      // その間に DM 送付不可にされた・所有者が業者と同じ名前や自治体・国になった物件は、送らずにここで止める
      // (次の回に任せると、また送る直前まで進んでしまう)。
      const s = await tx.leadFollowup.updateMany({
        where: { id: row.id, status: "active" },
        data: { status: "stopped", stopReason: fresh.excluded, stoppedAt: now, claimedAt: null },
      });
      return s.count > 0 ? "excluded" : "lost";
    }
    if (!fresh || !fresh.email || fresh.email.normalized !== to.normalized) return "changed";
    const again = decideFollowup(row, fresh.cls, ctx.steps, now);
    if (again.kind !== "send" || again.series !== series || again.position !== position) return "changed";
    const unsub = await tx.mailUnsubscribe.findUnique({ where: { emailNormalized: to.normalized }, select: { id: true } });
    if (unsub) {
      const s = await tx.leadFollowup.updateMany({
        where: { id: row.id, status: "active" },
        data: { status: "stopped", stopReason: "unsubscribed", stoppedAt: now, claimedAt: null },
      });
      return s.count > 0 ? "unsubscribed" : "lost";
    }
    const recent = await tx.leadFollowup.findFirst({
      where: { emailNormalized: to.normalized, lastSentAt: { gt: new Date(now.getTime() - DAILY_GAP_MS) } },
      select: { id: true },
    });
    if (recent) return "recent";
    const prev = await tx.leadFollowup.findUnique({ where: { id: row.id }, select: { lastSentAt: true } });
    prevLastSentAt = prev?.lastSentAt ?? null;
    // 送った時刻は送り始める前に残す(届いたあと記録の前に落ちても、同じアドレスへの「20時間に1通」が効く・@codex #757 P2)。
    const c = await tx.leadFollowup.updateMany({
      where: guardWhere(row),
      data: { status: "sending", claimedAt: now, lastSentAt: now },
    });
    return c.count > 0 ? "claimed" : "lost";
  });
  if (claim === "unsubscribed" || claim === "excluded") {
    summary.stopped += 1;
    return;
  }
  if (claim === "recent") {
    summary.deferred += 1;
    return;
  }
  if (claim === "lost" || claim === "changed") return;
  if (claim === "disabled") {
    ctx.halted = true;
    summary.deferred += 1;
    return;
  }

  const step = ctx.steps[series][position - 1];
  const priorSent = await prisma.leadFollowupSend.count({ where: { followupId: row.id, result: "sent" } });
  const unsubscribeUrl = buildFollowupUnsubscribeUrl(row.id, ctx.baseUrl, ctx.key);
  const text = composeFollowupText(
    step.body,
    buildFollowupFooter({ sender: ctx.sender, unsubscribeUrl, first: priorSent === 0 }),
  );
  const res = await ctx.sendMail(ctx.mailConfig, { to: to.raw, subject: step.subject, text, listUnsubscribeUrl: unsubscribeUrl });
  const ok = res.ok;
  const code = res.ok ? null : (safeErrorCode({ code: res.code }) ?? "send_failed");
  if (!ok) ctx.halted = true;
  if (!ok && code && NOT_SENT_CODES.has(code)) {
    // 確実に送っていない: 取り合いの印を外して進行中に戻す(送った記録は残さない・次の回にもう一度)。
    // 送り始める前に入れた送った時刻も元に戻す(本当に送っていないので、次の回にもう一度送れるように)。
    await prisma.leadFollowup.updateMany({
      where: { id: row.id, status: "sending" },
      data: { status: "active", claimedAt: null, lastSentAt: prevLastSentAt },
    });
    summary.deferred += 1;
    await writeAuditLog({
      action: "lead_followup_send",
      targetTable: "lead_followups",
      targetId: row.id,
      detail: { result: "deferred", series, position, code },
    });
    return;
  }

  // 送った事実は必ず残す(行が途中で止められていても)。行の書き戻しは sending のときだけ。
  // 送った時刻(lastSentAt)は状態に関わらず残す=同じアドレスへの「20時間に1通」が、送信中に止められた行でも効く
  // (@codex #757 P2)。届いたか分からない失敗も、届いたかもしれないので同じに扱う。
  await prisma.$transaction(async (tx) => {
    await tx.leadFollowupSend.createMany({
      data: [{ followupId: row.id, series, position, result: ok ? "sent" : "failed", subject: step.subject, at: now }],
      skipDuplicates: true,
    });
    await tx.leadFollowup.updateMany({ where: { id: row.id }, data: { lastSentAt: now } });
    await tx.leadFollowup.updateMany({
      where: { id: row.id, status: "sending" },
      data: ok
        ? { status: "active", ...advanceData(series, position), claimedAt: null }
        : { status: "stopped", stopReason: "send_failed", stoppedAt: now, claimedAt: null },
    });
  });
  if (ok) summary.sent += 1;
  else summary.failed += 1;
  await writeAuditLog({
    action: "lead_followup_send",
    targetTable: "lead_followups",
    targetId: row.id,
    detail: ok ? { result: "sent", series, position } : { result: "failed", series, position, code },
  });
}

/** 戻り値: 何も変えずに待った(次の通の日がまだ)なら true。 */
async function evaluateRow(
  row: ActiveRow,
  target: TargetState,
  unsubscribed: boolean,
  ctx: SendContext,
  now: Date,
  summary: FollowupRunSummary,
): Promise<boolean> {
  summary.evaluated += 1;
  if (!target) {
    if (await stopRow(row, "target_deleted", now)) summary.stopped += 1;
    return false;
  }
  if (target.excluded) {
    if (await stopRow(row, target.excluded, now)) summary.stopped += 1;
    return false;
  }
  if (!target.email || target.email.normalized !== row.emailNormalized) {
    if (await stopRow(row, "no_address", now)) summary.stopped += 1;
    return false;
  }
  if (unsubscribed) {
    if (await stopRow(row, "unsubscribed", now)) summary.stopped += 1;
    return false;
  }
  let cur = row;
  for (let i = 0; i < MAX_STEPS_PER_ROW; i++) {
    const d = decideFollowup(cur, target.cls, ctx.steps, now);
    if (d.kind === "wait") return true;
    if (d.kind === "stop") {
      if (await stopRow(cur, d.reason, now)) summary.stopped += 1;
      return false;
    }
    if (d.kind === "complete") {
      const r = await prisma.leadFollowup.updateMany({ where: guardWhere(cur), data: { status: "completed", claimedAt: null } });
      if (r.count > 0) summary.completed += 1;
      return false;
    }
    if (d.kind === "update") {
      const r = await prisma.leadFollowup.updateMany({ where: guardWhere(cur), data: d.data });
      if (r.count === 0) return false;
      cur = { ...cur, ...d.data };
      continue;
    }
    if (d.kind === "skip") {
      const step = ctx.steps[d.series][d.position - 1];
      const advanced = await prisma.$transaction(async (tx) => {
        const r = await tx.leadFollowup.updateMany({ where: guardWhere(cur), data: advanceData(d.series, d.position) });
        if (r.count === 0) return false;
        await tx.leadFollowupSend.createMany({
          data: [{ followupId: cur.id, series: d.series, position: d.position, result: "skipped", subject: step.subject, at: now }],
          skipDuplicates: true,
        });
        return true;
      });
      if (!advanced) return false;
      summary.skipped += 1;
      cur = { ...cur, ...advanceData(d.series, d.position) };
      continue;
    }
    // send: 時間帯・上限・持ち時間に当たったら次の実行へ回す(行は変えない)
    if (ctx.halted || !isWithinSendHoursJst(now) || summary.sent + summary.failed >= ctx.maxSends || Date.now() > ctx.deadline) {
      summary.deferred += 1;
      return false;
    }
    await sendOne(cur, target.email, d.series, d.position, ctx, now, summary);
    return false;
  }
  return false;
}

export async function runLeadFollowups(now: Date, opts: FollowupRunOptions = {}): Promise<FollowupRunSummary> {
  const summary: FollowupRunSummary = {
    enabled: false,
    ready: false,
    notReadyCount: 0,
    started: 0,
    startedStopped: 0,
    startedCompleted: 0,
    interrupted: 0,
    disabledStopped: 0,
    evaluated: 0,
    errors: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    completed: 0,
    stopped: 0,
  };
  const deadline = opts.deadline ?? Date.now() + 150_000;

  const cfg = await prisma.mailConfig.findUnique({
    where: { id: MAIL_CONFIG_ID },
    select: { followupEnabled: true, followupEnabledAt: true },
  });
  if (!cfg?.followupEnabled || !cfg.followupEnabledAt) {
    // 画面の OFF の保存でも止めているが、念のためここでも止める(ON に戻しても再開しない)。
    const r = await prisma.leadFollowup.updateMany({
      where: { status: "active" },
      data: { status: "stopped", stopReason: "disabled", stoppedAt: now, claimedAt: null },
    });
    summary.disabledStopped = r.count;
    return summary;
  }
  summary.enabled = true;

  const stale = await prisma.leadFollowup.updateMany({
    where: { status: "sending", claimedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: "stopped", stopReason: "interrupted", stoppedAt: now, claimedAt: null },
  });
  summary.interrupted = stale.count;

  const [setup, steps, mailConfig] = await Promise.all([loadFollowupSetupContext(), loadSteps(), loadMailSendConfig()]);
  let key: Buffer | null = null;
  try {
    key = deriveUnsubscribeKey();
  } catch {
    key = null;
  }
  const problems = [...setup.problems, ...followupStepsEnableProblems(steps)];
  if (problems.length > 0 || !mailConfig || !key || !setup.unsubscribeBaseUrl) {
    summary.notReadyCount = Math.max(problems.length, 1);
    return summary;
  }
  summary.ready = true;

  await discover(cfg.followupEnabledAt, now, deadline, steps, summary);

  const ctx: SendContext = {
    steps,
    sender: setup.sender,
    baseUrl: setup.unsubscribeBaseUrl,
    key,
    mailConfig,
    sendMail: opts.sendMail ?? sendPlainMail,
    maxSends: opts.maxSends ?? maxSendsFromEnv(),
    deadline,
    halted: false,
    enabledAt: cfg.followupEnabledAt,
  };

  const rows: ActiveRow[] = (
    await prisma.leadFollowup.findMany({
      where: { status: "active" },
      // 長く見ていない行から(上限に当たっているときは、待つ行の時刻を進めて後ろへ回す=先頭の行だけを見続けない)。
      orderBy: { updatedAt: "asc" },
      take: EVALUATE_LIMIT,
      select: {
        id: true,
        targetType: true,
        propertyId: true,
        inquiryId: true,
        emailNormalized: true,
        newStartedAt: true,
        newNextPosition: true,
        holdStartedAt: true,
        holdNextPosition: true,
      },
    })
  ).map((r) => ({ ...r, targetType: r.targetType === "inquiry" ? "inquiry" : "property" }));

  const saturated = rows.length >= EVALUATE_LIMIT;
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (Date.now() > deadline) break;
    const chunk = rows.slice(i, i + CHUNK);
    const emails = [...new Set(chunk.flatMap((r) => (r.emailNormalized ? [r.emailNormalized] : [])))];
    const [targets, unsubs] = await Promise.all([
      loadTargets(chunk),
      emails.length
        ? prisma.mailUnsubscribe.findMany({ where: { emailNormalized: { in: emails } }, select: { emailNormalized: true } })
        : Promise.resolve([]),
    ]);
    const unsubSet = new Set(unsubs.map((u) => u.emailNormalized));
    for (const row of chunk) {
      if (Date.now() > deadline) break;
      try {
        const waited = await evaluateRow(
          row,
          targets.get(row.id) ?? null,
          !!row.emailNormalized && unsubSet.has(row.emailNormalized),
          ctx,
          now,
          summary,
        );
        if (waited && saturated) {
          await prisma.leadFollowup.updateMany({ where: { id: row.id, status: "active" }, data: { updatedAt: now } });
        }
      } catch (e) {
        // 1行の失敗で残りの行を止めない(中身は出さない)。
        summary.errors += 1;
        console.error(`[lead-followup] 行の判断に失敗 kind=${e instanceof Error ? e.name : typeof e}`);
      }
    }
  }
  return summary;
}
