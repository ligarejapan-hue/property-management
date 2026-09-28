"use client";

/**
 * 売却DMの作成画面(設計 2026-09-27 §2.3・2026-09-28 発注者決定)。
 *
 * 物件一覧の「売却DMを作成」で開く小さな窓。「DMの種類」の既定を選ぶか、「種類を使わない(今までどおり)」を選ぶ。
 * 選択肢は選択肢の口(fetchSaleDmScenarioOptions=有効な種類・文面は含まず ready だけ)から取る。
 * 初期選択 = 手紙が登録済み(ready)の最初の種類、無ければ「種類を使わない」。手紙が未登録の種類は選べない。
 * 選択肢を読めなかったときは黙って「種類を使わない」で作らせない(理由と「再読み込み」を出し、読めるまで作成は押せない)。
 *
 * 作成そのもの(API 呼び出し・冪等キー・作成後の案内・画面遷移)は呼び出し側(物件一覧)が持つ。
 * ここは選んだ値を onSubmit へ渡し、失敗の文言(API のメッセージそのまま)と、種類の登録が足りない理由のときだけ
 * 管理者に「DMの種類を開く」を出す(押しても入れない画面へは誘導しない=実績144の決まり)。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { fetchSaleDmScenarioOptions, apiErrorCode, USE_MOCK, type SaleDmScenarioOption } from "@/lib/api-client";
import { pickDefaultScenario, scenarioFixLinkFor } from "@/lib/sale-dm-letter/scenario-campaign-ui";

/** 「種類を使わない」を表す選択肢の値(種類の id は uuid なので重ならない)。 */
const NONE = "";

export function SaleDmCreateCampaignDialog({
  propertyCount,
  busy,
  onSubmit,
  onClose,
}: {
  propertyCount: number;
  busy: boolean;
  /** defaultScenarioId=null は種類を使わない(今までどおり)。失敗は throw(文言をこの窓に出す)。 */
  onSubmit: (defaultScenarioId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const isAdmin = USE_MOCK || (session?.user as { role?: string } | undefined)?.role === "admin";
  const [options, setOptions] = useState<SaleDmScenarioOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(NONE);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);

  // ⚠状態は応答が返ってから書く(effect の中で同期に setState しない)。
  const load = useCallback(
    () =>
      fetchSaleDmScenarioOptions().then(
        (opts) => {
          setLoadError(null);
          setOptions(opts);
          // 取り直すたびに初期選択へ戻さない(利用者が選んだ値が今も選べるなら保つ)。
          setSelected((prev) => {
            const still = opts.find((o) => o.id === prev && o.ready);
            return still ? prev : pickDefaultScenario(opts) ?? NONE;
          });
        },
        (e: unknown) => {
          // 選択肢は「無い」(null)のまま=作成は押せない。空の一覧にすると「種類を使わない」だけが残り、
          // 利用者が選んでいないのに種類なしの発送が作られてしまう。
          setOptions(null);
          setLoadError(e instanceof Error ? e.message : "DMの種類を読み込めませんでした");
          setSelected(NONE);
        },
      ),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setError(null);
    try {
      await onSubmit(selected === NONE ? null : selected);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "売却DMの作成に失敗しました", code: apiErrorCode(e) });
      // 種類が使えなくなった・未登録になった等は、選択肢を取り直して今の状態を見せる(まだ使える前提にしない)。
      await load();
    }
  };

  const reload = () => {
    setLoadError(null);
    void load();
  };

  const fixLink = error ? scenarioFixLinkFor(error.code) : null;

  return (
    <ModalShell
      size="md"
      title="売却DMを作成"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || options === null}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            作成
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-gray-700 dark:text-gray-200">
        <p>
          選択した {propertyCount} 件の物件で宛先の一覧を作ります。共有者が複数いる物件は宛先ごとに複数通になることがあります。
        </p>
        {/* label で包まない(読めなかったときの「再読み込み」ボタンが、見出しを押しただけで押されてしまうため)。 */}
        <div className="block">
          <span id="sale-dm-create-scenario-label" className="font-medium">DMの種類</span>
          {loadError ? (
            <span role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-300">
              <span>{loadError}</span>
              <Button variant="secondary" onClick={reload} disabled={busy}>
                再読み込み
              </Button>
            </span>
          ) : options === null ? (
            <span className="mt-1 flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中...
            </span>
          ) : (
            <select
              aria-labelledby="sale-dm-create-scenario-label"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.ready}>
                  {o.name}
                  {o.ready ? "" : "(手紙が未登録)"}
                </option>
              ))}
              <option value={NONE}>種類を使わない(今までどおり)</option>
            </select>
          )}
        </div>
        {options !== null && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {selected === NONE
              ? "今までどおり、型Aで作ります"
              : "受付帳取込の物件は相続、現地調査の物件は空き家、それ以外はここで選んだ種類になります。物件の『DMの種類』欄で直した物件はそちらが優先です。"}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300"
          >
            <p className="whitespace-pre-line">{error.message}</p>
            {isAdmin && fixLink && (
              <Link href={fixLink.href} className="mt-1 inline-block font-semibold underline underline-offset-2">
                {fixLink.label}
              </Link>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
