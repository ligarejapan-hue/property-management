import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { MAIL_CONFIG_ID, isMailConfigComplete } from "@/lib/mail/mail-config";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";
import {
  FOLLOWUP_SERIES,
  defaultFollowupSlots,
  followupStepsEnableProblems,
  type FollowupSeries,
  type FollowupStepsBySeries,
} from "./steps";
import {
  buildFollowupFooter,
  followupSenderProblems,
  normalizeFollowupSender,
  type FollowupSender,
} from "./footer";

/**
 * 追客メールの設定(ON/OFF・2本の流れの文面)の読み書き(設計 2026-11-16 §4・§6)。
 * - 設定を一度も保存していない(版0)ときは、発注者のイメージの日数の枠(件名・本文は空)を返す(DB には入れない)。保存後の0件は空のまま。
 * - 保存は版番号(mail_config.followup_version)が合うときだけ・文面は全部を置き換える(1回の transaction)。
 * - ON にする保存は、送るために足りないもの(SMTP・会社の設定・外向きの URL・鍵・文面の空欄)が無いときだけ。
 */

export type FollowupSettingsView = {
  enabled: boolean;
  enabledAt: string | null;
  version: number;
  steps: FollowupStepsBySeries;
  /** 設定が未保存(版0)で、画面には日数の枠だけを出している */
  usingDefaultSlots: boolean;
  /** ON にするために足りないもの(文面以外)。空=ON にできる(文面の空欄は保存時に別に確かめる) */
  setupProblems: string[];
  /** 末尾に自動で付く文の見本(最初の1通) */
  footerPreview: string;
};

export class FollowupVersionConflictError extends Error {
  constructor() {
    super("ほかの人が先に追客の設定を保存しました");
  }
}

export class FollowupEnableBlockedError extends Error {
  constructor(public readonly problems: string[]) {
    super(`追客を ON にできません: ${problems.join("・")}`);
  }
}

export type SetupContext = { sender: FollowupSender; unsubscribeBaseUrl: string | null; problems: string[] };

async function loadSetupContext(mailRow: Parameters<typeof isMailConfigComplete>[0]): Promise<SetupContext> {
  const company = await prisma.companyProfile
    .findUnique({ where: { id: "singleton" }, select: { nameJa: true, address: true, tel: true, email: true } })
    .catch(() => null);
  const sender = normalizeFollowupSender({
    companyName: company?.nameJa,
    address: company?.address,
    tel: company?.tel,
    email: company?.email,
  });
  // 外向きの URL は紙の DM と同じ「追跡の土台 URL」だけ(社内向けのアプリの URL はお客様が開けない)。
  const unsubscribeBaseUrl = (await loadSaleDmPublicPageConfig()).trackingBaseUrl ?? null;
  const problems: string[] = [];
  if (!isMailConfigComplete(mailRow)) problems.push("メールの送信設定(サーバー・ユーザー名・パスワード・送信元)が済んでいません");
  problems.push(...followupSenderProblems(sender, unsubscribeBaseUrl));
  try {
    deriveUnsubscribeKey();
  } catch {
    problems.push("配信停止のリンクに署名する鍵(NEXTAUTH_SECRET)がありません");
  }
  return { sender, unsubscribeBaseUrl, problems };
}

/** 送信の処理(run.ts)用: 送る直前の送信者・外向きの URL・足りないもの。 */
export async function loadFollowupSetupContext(): Promise<SetupContext> {
  const row = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID }, select: MAIL_ROW_SELECT });
  return loadSetupContext(row);
}

function previewFooter(ctx: SetupContext): string {
  const base = ctx.unsubscribeBaseUrl ? ctx.unsubscribeBaseUrl.replace(/\/+$/, "") : "https://(外向きのURL)";
  return buildFollowupFooter({ sender: ctx.sender, unsubscribeUrl: `${base}/u/f…(お客様ごとのリンク)`, first: true });
}

/**
 * neverSaved=版番号が0(一度も保存していない)。そのときだけ日数の枠を出す。
 * 一度でも保存したあとの0件は「全部消して保存した」結果なので、空のまま返す(枠を出し直さない)。
 */
async function loadSteps(neverSaved: boolean): Promise<{ steps: FollowupStepsBySeries; usingDefaultSlots: boolean }> {
  const rows = await prisma.leadFollowupStep.findMany({
    orderBy: [{ series: "asc" }, { position: "asc" }],
    select: { series: true, delayDays: true, subject: true, body: true },
  });
  if (rows.length === 0 && neverSaved) return { steps: defaultFollowupSlots(), usingDefaultSlots: true };
  const steps: FollowupStepsBySeries = { new: [], hold: [] };
  for (const r of rows) {
    if ((FOLLOWUP_SERIES as readonly string[]).includes(r.series)) {
      steps[r.series as FollowupSeries].push({ delayDays: r.delayDays, subject: r.subject, body: r.body });
    }
  }
  return { steps, usingDefaultSlots: false };
}

const MAIL_ROW_SELECT = {
  smtpHost: true,
  smtpPort: true,
  smtpUser: true,
  smtpPassEnc: true,
  fromAddress: true,
  followupEnabled: true,
  followupEnabledAt: true,
  followupVersion: true,
} as const;

export async function loadFollowupSettings(): Promise<FollowupSettingsView> {
  const row = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID }, select: MAIL_ROW_SELECT });
  const ctx = await loadSetupContext(row);
  const { steps, usingDefaultSlots } = await loadSteps((row?.followupVersion ?? 0) === 0);
  return {
    enabled: row?.followupEnabled === true,
    enabledAt: row?.followupEnabledAt ? row.followupEnabledAt.toISOString() : null,
    version: row?.followupVersion ?? 0,
    steps,
    usingDefaultSlots,
    setupProblems: ctx.problems,
    footerPreview: previewFooter(ctx),
  };
}

/** steps は followupStepsSchema を通したもの。 */
export async function saveFollowupSettings(input: {
  version: number;
  enabled: boolean;
  steps: FollowupStepsBySeries;
  userId: string;
  now?: Date;
}): Promise<FollowupSettingsView> {
  const now = input.now ?? new Date();
  // 古い画面からの保存は、ON にできるかより先に「読み直して」を返す(案内の意味をそろえる・本当の判定は tx 内)。
  const pre = await prisma.mailConfig.findUnique({ where: { id: MAIL_CONFIG_ID }, select: MAIL_ROW_SELECT });
  if ((pre?.followupVersion ?? 0) !== input.version) throw new FollowupVersionConflictError();
  if (input.enabled) {
    const row = pre;
    const ctx = await loadSetupContext(row);
    const problems = [...ctx.problems, ...followupStepsEnableProblems(input.steps)];
    if (problems.length > 0) throw new FollowupEnableBlockedError(problems);
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.mailConfig.findUnique({
      where: { id: MAIL_CONFIG_ID },
      select: { followupEnabled: true, followupEnabledAt: true, followupVersion: true },
    });
    const current = row?.followupVersion ?? 0;
    if (input.version !== current) throw new FollowupVersionConflictError();
    // OFF→ON にした時刻を残す(この時刻より前の登録・申込は対象にしない)。ON のまま保存しても変えない。
    const enabledAt = input.enabled
      ? row?.followupEnabled
        ? (row.followupEnabledAt ?? now)
        : now
      : (row?.followupEnabledAt ?? null);
    if (!row) {
      try {
        await tx.mailConfig.create({
          data: {
            id: MAIL_CONFIG_ID,
            followupEnabled: input.enabled,
            followupEnabledAt: enabledAt,
            followupVersion: 1,
            updatedById: input.userId,
          },
        });
      } catch (e) {
        // 同時に2人が初めて保存した(行の作成がぶつかった)ときだけ版の衝突。ほかの失敗はそのまま投げる。
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new FollowupVersionConflictError();
        }
        throw e;
      }
    } else {
      const updated = await tx.mailConfig.updateMany({
        where: { id: MAIL_CONFIG_ID, followupVersion: current },
        data: {
          followupEnabled: input.enabled,
          followupEnabledAt: enabledAt,
          followupVersion: { increment: 1 },
          updatedById: input.userId,
        },
      });
      if (updated.count === 0) throw new FollowupVersionConflictError();
    }
    // ON→OFF: 全員への追客をすぐ止める(ON に戻しても再開しない・設計 §3.3 disabled)。
    // 送っている途中(sending)の行も止める=送り終えた書き戻しは sending のときだけなので、進行中には戻らない。
    if (!input.enabled && row?.followupEnabled) {
      await tx.leadFollowup.updateMany({
        where: { status: { in: ["active", "sending"] } },
        data: { status: "stopped", stopReason: "disabled", stoppedAt: now, claimedAt: null },
      });
    }
    await tx.leadFollowupStep.deleteMany({});
    const data = FOLLOWUP_SERIES.flatMap((series) =>
      input.steps[series].map((s, i) => ({
        series,
        position: i + 1,
        delayDays: s.delayDays,
        subject: s.subject,
        body: s.body,
        updatedById: input.userId,
      })),
    );
    if (data.length > 0) await tx.leadFollowupStep.createMany({ data });
  });

  return loadFollowupSettings();
}
