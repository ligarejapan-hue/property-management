"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { apiErrorCode, fetchAgentDetail, updateAgent, type AgentDetail, type AgentHistoryItem } from "@/lib/api-client";
import { agentLabel } from "@/lib/agent-inquiry/desk-form";
import {
  agentAfterSave,
  agentEditError,
  agentEditPatch,
  agentFieldValue,
  agentStaleFields,
  editAgentField,
  rebaseAgentEdits,
  type AgentEditKey,
  type AgentEdits,
} from "@/lib/agent-inquiry/main-view";
import { notifyInquiryChanged } from "@/lib/agent-inquiry/desk-sync";
import { formatPhoneJp } from "@/lib/phone-format-jp";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentHistoryList, AgentInfoFields, agentSaveErrorMessage } from "@/components/agent-inquiry/agent-detail";

type LoadState = "loading" | "ok" | "forbidden" | "notfound" | "error";

function AgentDetailBody({ id }: { id: string }) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [history, setHistory] = useState<AgentHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // 書けるかどうかはサーバーが返す。分かるまでは出さない側。
  const [canWrite, setCanWrite] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  // 触った欄だけ(触っていない欄は最新の値を出す=読み直しても、他の人の直しを古い値で上書きしない)。
  const [edits, setEdits] = useState<AgentEdits>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // 読み込みの世代。新しい読み込みを始めたら、古い読み込み(履歴の続きも)の結果は捨てる。
  const genRef = useRef(0);
  const moreRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const r = await fetchAgentDetail(id);
      if (genRef.current !== gen) return;
      setAgent(r.agent);
      setHistory(r.inquiries);
      setCursor(r.nextCursor);
      setCanWrite(r.canWrite);
      setState("ok");
    } catch (e) {
      if (genRef.current !== gen) return;
      const code = apiErrorCode(e);
      // 通信の失敗では書けるかどうかを変えない(編集欄を消さない)。権限なしのときだけ落とす。
      if (code === "FORBIDDEN") setCanWrite(false);
      setState(code === "FORBIDDEN" ? "forbidden" : code === "NOT_FOUND" ? "notfound" : "error");
    }
  }, [id]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(first);
      genRef.current += 1;
    };
  }, [load]);

  /** 保存・しまう・戻すの共通の流れ。成功でも失敗でも読み直してから、次の操作を受け付ける。 */
  const send = async (body: Parameters<typeof updateAgent>[1], okText: string, onOk: () => void) => {
    if (!agent || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    let result: { tone: "ok" | "error"; text: string };
    try {
      const r = await updateAgent(agent.id, body);
      // 送った値と新しい版番号を手元へ写す=続く読み直しに失敗しても、保存前の値を見せない・
      // 古い版番号で次の保存を送らない。
      setAgent((a) => (a ? agentAfterSave(a, body, r.version) : a));
      onOk();
      result = { tone: "ok", text: okText };
      // 受付の窓の業者の検索(しまった業者は出ない・商号)が変わるので知らせる。
      notifyInquiryChanged();
    } catch (e) {
      result = { tone: "error", text: agentSaveErrorMessage(e) };
    }
    // 読み直しを待ってから手を離す=古い版番号のまま次の保存を送らない(版番号・書けるかどうか・
    // 保存できたか分からないときの本当の値が揃う)。
    await load();
    // 知らせは読み直しの後=「保存しました」と古い表示が同時に出ない。
    setNotice(result);
    savingRef.current = false;
    setSaving(false);
  };

  const save = () => {
    if (!agent) return;
    const err = agentEditError(agent, edits);
    if (err) {
      setNotice({ tone: "error", text: err });
      return;
    }
    // 自分が打っている欄を他の人が先に変えていたら、1回目は止めて相手の値を見せる(黙って上書きしない)。
    const stale = agentStaleFields(agent, edits);
    if (stale.length > 0) {
      setNotice({
        tone: "error",
        text: `他の人が先に変えています(${stale.map((s) => `${s.label}=「${s.current}」`).join("・")})。自分の内容で上書きするなら、もう一度保存を押してください。`,
      });
      setEdits(rebaseAgentEdits(agent, edits));
      return;
    }
    const patch = agentEditPatch(agent, edits);
    if (!patch) {
      setEdits({});
      setNotice({ tone: "ok", text: "変更はありません。" });
      return;
    }
    void send({ version: agent.version, ...patch }, "保存しました。", () => setEdits({}));
  };

  const loadMore = async () => {
    if (!cursor || moreRef.current) return;
    moreRef.current = true;
    setLoadingMore(true);
    const gen = genRef.current;
    try {
      const r = await fetchAgentDetail(id, cursor);
      // 待っている間に読み直した=履歴は1ページ目に戻っているので、古い続きを足さない。
      if (genRef.current !== gen) return;
      setHistory((prev) => [...prev, ...r.inquiries]);
      setCursor(r.nextCursor);
    } catch {
      if (genRef.current === gen) setNotice({ tone: "error", text: "反響の続きを読み込めませんでした。" });
    } finally {
      setLoadingMore(false);
      moreRef.current = false;
    }
  };

  if (state === "loading" && !agent) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">読み込み中…</p>;
  }
  if (state === "forbidden" || state === "notfound" || (state === "error" && !agent)) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="業者" back={{ href: "/agents", to: "業者の名簿" }} />
        <div className="rounded-md bg-white p-6 text-center text-sm dark:bg-gray-900">
          <p className="mb-2">
            {state === "forbidden"
              ? "反響の受付の権限がありません。管理者にお問い合わせください。"
              : state === "notfound"
                ? "業者が見つかりません。"
                : "読み込めませんでした。"}
          </p>
          {state === "error" && (
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              もう一度読む
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (!agent) return null;

  return (
    // 反響の履歴に問い合わせ者の名前(個人情報)が出るので画面保護の対象にする。
    <div data-pii-protected data-pii-surface="dashboard" className="mx-auto max-w-4xl">
      <PageHeader
        title={agentLabel(agent)}
        description={agent.isArchived ? "しまった業者です(受付の窓の検索には出ません)。" : undefined}
        back={{ href: "/agents", to: "業者の名簿" }}
      />
      {state === "error" && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
          <span>読み直せませんでした(下の表示は最新ではないかもしれません)。</span>
          <Button variant="secondary" size="sm" disabled={saving} onClick={() => void load()}>
            もう一度読む
          </Button>
        </div>
      )}
      <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">会社の情報</h2>
        <AgentInfoFields
          agent={agent}
          edits={edits}
          canWrite={canWrite}
          saving={saving}
          onEdit={(key, value) => setEdits((p) => editAgentField(agent, p, key, value))}
          onBlurPhone={(key: AgentEditKey) =>
            setEdits((p) =>
              p[key] === undefined ? p : editAgentField(agent, p, key, formatPhoneJp(agentFieldValue(agent, p, key)).value),
            )
          }
        />
        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mt-3 text-sm ${notice.tone === "error" ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-300"}`}
          >
            {notice.text}
          </p>
        )}
        {canWrite && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {agent.isArchived ? (
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => void send({ version: agent.version, isArchived: false }, "名簿に戻しました。", () => {})}
              >
                名簿に戻す
              </Button>
            ) : (
              <Button variant="secondary" disabled={saving} onClick={() => setConfirmArchive(true)}>
                しまう
              </Button>
            )}
            <Button disabled={saving} onClick={save}>
              {saving ? "保存中…" : "保存する"}
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">この業者からの反響(新しい順)</h2>
        <AgentHistoryList items={history} />
        {cursor != null && (
          <Button variant="secondary" className="mt-2 w-full" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "読み込み中…" : "もっと見る"}
          </Button>
        )}
      </section>

      {confirmArchive && (
        <ConfirmDialog
          title="この業者をしまいますか?"
          message="しまうと、受付の窓の業者の検索に出なくなります。これまでの反響は残り、「しまった業者」の一覧からいつでも戻せます。"
          confirmLabel="しまう"
          busy={saving}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            void send({ version: agent.version, isArchived: true }, "しまいました。", () => {});
          }}
        />
      )}
    </div>
  );
}

/** 業者の詳細(設計 2026-09-28 §2.3)。会社情報の編集・しまう/戻す・その業者からの反響。 */
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // 業者ごとに作り直す=前の業者の打ちかけ・履歴を持ち越さない。
  return <AgentDetailBody key={id} id={id} />;
}
