"use client";

import { useCallback, useRef, useState } from "react";
import {
  useRegistryPreflight,
  RegistryPreflightWarningLines,
  RegistryTargetNote,
} from "@/components/properties/registry-preflight-warnings";
import RegistryChibanPopup from "@/components/properties/registry-chiban-popup";
import { isSearchableTarget } from "@/lib/registry-fetch/registry-target";
import { resolveRecoverEntry } from "@/lib/registry-fetch/recover-entry";
import { decideAfterSearch } from "@/lib/registry-fetch/after-search";
import { MapPinned, Loader2, AlertTriangle } from "lucide-react";
import {
  searchRegistryCandidates,
  obtainRegistryByCandidate,
  recoverRegistryByCandidate,
  recoverRegistryFromProperty,
  apiErrorCode,
  type RegistrySearchCandidate,
} from "@/lib/api-client";
import RegistryLivePanel from "@/components/properties/registry-live-panel";
import { safeRandomId } from "@/lib/random-id";

interface RegistryLocationSearchButtonProps {
  propertyId: string;
  /** registry:auto_fetch 権限。無ければ何も描画しない（非 admin には非表示・server 側でも 403）。 */
  canAutoFetch: boolean;
  /** /api/me/permissions の capabilities.registryAutoFetch。本番 provider が設定済みか。 */
  providerConfigured: boolean;
  /**
   * capabilities.registryPurchase(段階②・2026-08-01)。**有料取得の専用オプトイン**
   * (REGISTRY_FETCH_PURCHASE_ENABLED)が立っているか。false のとき検索(無料)は使えるが
   * 取得ボタンは準備中表示にする(@codex #345 P1: 無料検索の校正だけで課金操作を露出させない。
   * server 側も 501 で enforce)。
   */
  purchaseEnabled: boolean;
  /**
   * 【回収】購入済みの取り込みが使えるか(capabilities.registryAutoFetch)。
   * ⚠**所在検索とは別条件**(@codex #394 R16 P2)。所在検索の校正が外れていても
   * 買った書類は取り込めなければならない(取得期限があるため)。
   */
  recoverConfigured?: boolean;
  /** 物件の所在（ポップアップで画面にコピーしてもらう。⚠外部へは渡さない）。 */
  propertyAddress: string;
  /** 物件に登録されている地番(候補なしの回収でどちらを探すか選ばせるため)。 */
  propertyLotNumber?: string | null;
  /** 物件に登録されている家屋番号(同上)。 */
  propertyBuildingNumber?: string | null;
  /**
   * 地番の保存に必要な現在の版番号。
   * ⚠保存後は**この画面が持ち帰った版番号**を使う（親の取り直しを待たない）。
   */
  propertyVersion: number;
  /** property:write。無ければポップアップは入力欄を出さず案内だけにする。 */
  canWriteProperty: boolean;
  /** 建物の道（家屋番号が要る案内）も見せるか。土地だと分かっている種別以外は true。 */
  offerBuildingPath: boolean;
  /** 地番を保存したので物件を取り直す（version と分類を新しくする）。 */
  onPropertyRefresh: () => void;
  /**
   * 取得・取り込みが**成功した**合図。画面を作り直さずに、添付ファイル一覧と
   * 謄本の状態だけを静かに最新化してもらう。
   * ⚠onPropertyRefresh では代用できない（あちらはページを「読み込み中」に差し替え、
   *   このボタンごと作り直す＝実況の見返しが即座に消える。@codex #380 R3 P2）。
   * ⚠任意（?）にしない：配線を忘れても型・テスト・build が通ってしまい、
   *   本番でだけ「成功したのに画面が古いまま」が復活する（2026-08-20 の再演）。
   */
  onRegistryResultApplied: () => void | Promise<boolean | void>;
}

type State =
  | "idle"
  | "confirmSearch"
  | "searching"
  | "results"
  | "confirmObtain"
  | "obtaining"
  // 【回収】購入済みの書類を取り込んでいる最中(課金なし)。
  | "recovering"
  | "done"
  // 利用者が自分で中止した (@codex #357 P2)。失敗ではないので "error" と分ける。
  | "cancelled"
  | "error";

// 謄本「所在検索」導線（PR-2b-3）。番号無し物件を所在/地番/家屋番号で候補検索し、候補を選んで取得する。
//  - 非 admin（registry:auto_fetch 無し）には何も描画しない。
//  - provider 未設定（providerConfigured=false）の現状は disabled + 理由文のみ（本番は 501 fail-closed）。
//  - 検索・取得とも有料になり得るため、実行前に明示確認（confirmed）を出してから POST する（cond①）。
//  - 候補（所在/地番/家屋番号）は認可ユーザー向けに表示するのみ。console/log には出さない（cond②）。
//    不動産番号は応答に含まれない（cond③: 取得時に server 側で candidateRef を再解決）。
//  - 501/409/502 等の非 2xx は成功扱いしない。所有者 PII は一切表示・参照しない。
export default function RegistryLocationSearchButton({
  propertyId,
  canAutoFetch,
  providerConfigured,
  purchaseEnabled,
  recoverConfigured = false,
  propertyAddress,
  propertyLotNumber,
  propertyBuildingNumber,
  propertyVersion,
  canWriteProperty,
  offerBuildingPath,
  onPropertyRefresh,
  onRegistryResultApplied,
}: RegistryLocationSearchButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [candidates, setCandidates] = useState<RegistrySearchCandidate[]>([]);
  const [notSearchableReason, setNotSearchableReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<RegistrySearchCandidate | null>(null);
  // 請求種別（所有者事項=既定・安い方 / 全部事項=高い方）。取得の確認画面で選ぶ。
  const [certificateType, setCertificateType] = useState<"owner" | "all">("owner");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 完了表示の文言を分けるため、直前に実行したのが取得(有料)か回収(課金なし)かを覚える。
  const [lastAction, setLastAction] = useState<"obtain" | "recover">("obtain");
  // 候補なしの回収で、物件が両方持つときにどちらを取り込むか(@codex #394 R13 P1)。
  // ⚠既定は土地(地番)。この運用では地番で買うのが基本のため。画面で変更できる。
  const [recoverKind, setRecoverKind] = useState<"land" | "building">("land");
  // 実況パネル用の参照 (client 発行・非PII)。検索のたびに発行し直す。
  // HTTP 本番でも動く safeRandomId を使う (crypto.randomUUID 禁止)。
  const [liveRef, setLiveRef] = useState<string | null>(null);
  // 課金直前(取得確認)に事前確認(取得済み/添付あり/所有者あり)を表示する(発注者要望 2026-08-08)。
  // 地番を保存したら分類が変わるので、preflight を取り直す合図。
  const [preflightReload, setPreflightReload] = useState(0);
  // ⚠地番を保存したら物件も取り直したいが、**その場では呼べない**
  //   （@codex #373 R10 P2）。親の再取得は物件詳細ページを読み込み中の画面へ
  //   切り替えるので、このボタンごと作り直され、せっかく進んだ確認の流れが消える。
  //   分類は preflight を取り直せば新しくなるので、親の取り直しは
  //   流れを閉じるとき（reset）にまとめて行う。
  const propertyRefreshPendingRef = useRef(false);
  // 保存後の版番号（親から届く propertyVersion より新しい）。
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  // 回収の入口を押してから、物件の取り直しが返るまで(押せない・押したことが分かる)。
  const [preparingRecover, setPreparingRecover] = useState(false);
  /**
   * 回収の準備(取り直し待ち)の世代。⚠待っている間に「閉じる」等で流れが畳まれたら、
   * 続きを実行しない(畳んだのに確認画面が開くと**勝手に開いた**ようにしか見えない。
   * @codex #398 R6 P2)。畳む側(clearFlow)が進め、待った側が照合する。
   */
  const recoverPrepRef = useRef(0);
  /**
   * 検索中に中止が**受け付けられた**か。⚠候補1件で自動的に有料取得へ進む運用にしたため、
   * 「中止を押した直後に検索結果が返る」隙間で課金され得る。サーバーの中止判定に加えて
   * 画面側でも覚えておき、二重に止める（課金の後は取り消せない）。
   */
  const searchCancelledRef = useRef(false);
  // 失敗の帯が現れた瞬間に、そこまで画面を送って見落としを防ぐ。
  // ⚠**知らせるのは失敗のときだけ**(発注者指示 2026-08-20)。成功は画面の更新で足りる。
  // ⚠useEffect ではなく callback ref: 実物の要素を掴んだ瞬間に 1 回だけ動かす
  //   (effect 内の同期処理は eslint react-hooks 系の規約でも避ける形)。
  const errorBannerRef = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, []);
  // ⚠confirmSearch でも動かす。「何を取りに行くか」が分からないうちは
  //   検索も取得も始めさせない（設計 §3.1.1・fail closed）。
  //   ⚠番号が無い物件ではここでポップアップを出す（確認パネルの**前**）。
  const preflight = useRegistryPreflight(
    [propertyId],
    state === "confirmSearch" || state === "confirmObtain",
    preflightReload,
  );
  const target = preflight.targetsById.get(propertyId) ?? null;

  // 非 admin には導線自体を出さない（サーバ側でも 403 で二重防御）。
  if (!canAutoFetch) return null;

  const providerDisabled = !providerConfigured;
  // ⚠両方登録されている物件は、放っておくと家屋番号が優先される(=土地の購入を
  //   取り込めない/建物のPDFを取り込んでしまう)。選ばせる(@codex #394 R13 P1)。
  const hasBothIdentifiers =
    !!(propertyLotNumber ?? "").trim() && !!(propertyBuildingNumber ?? "").trim();

  /**
   * 検索の途中状態を畳むだけ。⚠**親の取り直しは流さない**。
   * 流すと詳細ページが読み込み中に差し替わり、この部品ごと作り直されるため、
   * 直後の setState が捨てられる(@codex #398 R3 P2)。
   */
  const clearFlow = () => {
    // 待っている回収の準備を無効にする(畳んだ後に続きが動かないように)。
    recoverPrepRef.current += 1;
    setState("idle");
    setCandidates([]);
    setNotSearchableReason(null);
    setSelected(null);
    setErrorMsg(null);
    // 実況パネルも閉じる (server 側のスクショは TTL で自動消滅)。
    setLiveRef(null);
  };

  const reset = () => {
    clearFlow();
    // ⚠溜めておいた物件の取り直しをここで流す。流れは閉じたので、
    //   親が読み込み中の画面へ切り替わっても失うものが無い。
    if (propertyRefreshPendingRef.current) {
      propertyRefreshPendingRef.current = false;
      setSavedVersion(null);
      onPropertyRefresh();
    }
  };

  /**
   * 【回収】購入済みの謄本を取り込む入口。⚠**定義は1か所**にして、行き止まりの各所へ
   * 同じものを差し込む(場所ごとに書き写すと、片方だけ直してずれる)。
   * 候補を持たない経路なので、物件自身の地番/家屋番号から探す確認画面へ進む。
   */
  const recoverEntryLink = recoverConfigured ? (
    <button
      type="button"
      disabled={preparingRecover}
      onClick={async () => {
        // ⚠reset() は使わない。溜まっている親の取り直しを流すと詳細ページが
        //   読み込み中に差し替わり、**この部品ごと消えて**直後の setState が
        //   捨てられる(=押しても確認画面が開かない。@codex #398 R3 P2)。
        // ⚠失敗直後は取得の予約で**版番号が上がっている**ため、取り直さないと
        //   再挑戦が「物件情報が変わりました」で弾かれる(@codex #394 R27 P2)。
        //   画面を作り直さない**静かな取り直し**を使い、古い版を捨てる。
        // ⚠**取り直しの完了を待ってから**開く(@codex #398 R4 P2)。待たないと、
        //   利用者が先にボタンを押せてしまい**古い版のまま送って再び弾かれる**。
        const prepGen = ++recoverPrepRef.current;
        setSavedVersion(null);
        setPreparingRecover(true);
        let refreshed: boolean | void;
        try {
          refreshed = await onRegistryResultApplied();
        } finally {
          setPreparingRecover(false);
        }
        // ⚠取り直しは失敗を握りつぶす(画面を壊さないため)。**取り直せていない**まま
        //   確認画面を開くと、古い版番号で再挑戦して弾かれる(@codex #398 R5 P2)。
        //   返さない実装(void)は従来どおり通す。false のときだけ止める。
        // ⚠待っている間に閉じられていたら、ここで終わる(勝手に開かない)。
        if (prepGen !== recoverPrepRef.current) return;
        if (refreshed === false) {
          setErrorMsg(
            "最新の物件情報を取得できませんでした。通信を確認して、もう一度お試しください。",
          );
          setState("error");
          return;
        }
        clearFlow();
        setSelected(null);
        setState("confirmObtain");
      }}
      className="w-fit text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-60"
    >
      {preparingRecover
        ? "最新の情報を取り直しています…"
        : "取得済みの謄本を取り込む（課金なし）"}
    </button>
  ) : null;

  // ⚠**共通部品(registry-preflight-warnings)の同じ判定と、文言をそろえる**。
  //   以前ここだけ「通常の『謄本を自動取得』をご利用ください」と案内していたが、
  //   その導線は 2026-08-15 に撤去した（番号取得は実サイトへ未配線＝必ず失敗する）。
  //   **消えたボタンへ誘導しない**（同じ文言を2か所に書くと、片方だけ直してずれる）。
  const reasonText = (reason: string): string =>
    reason === "has_real_estate_number"
      ? "不動産番号があるため、所在検索の対象外です。⚠現在この経路では取得できません（番号での取得は準備中）。"
      : reason === "insufficient_location"
        ? "所在（住所）が未登録のため検索できません。物件情報に所在を登録してください。"
        : "この物件は所在検索の対象外です。";

  const runSearch = async () => {
    setState("searching");
    setErrorMsg(null);
    // ⚠検索のたびに中止の記憶を落とす（前回の中止を持ち越さない）。
    searchCancelledRef.current = false;
    // 実況パネルの参照を発行して検索 POST に同封する。実行中の自動操作を
    // 本人がスクショ紙芝居で追える (サーバー側はメモリ内 TTL・完了後破棄)。
    const ref = safeRandomId();
    setLiveRef(ref);
    try {
      const res = await searchRegistryCandidates(propertyId, ref);
      if (!res.searchable) {
        setCandidates([]);
        setNotSearchableReason(res.reason);
        setState("results");
        return;
      }
      setCandidates(res.candidates);
      // 検索のあと何をするかは純関数で決める（お金が動く分岐を画面に書き写さない）。
      const decision = decideAfterSearch({
        candidates: res.candidates,
        cancelRequested: searchCancelledRef.current,
        purchaseEnabled,
      });
      if (decision.action === "cancelled") {
        // ⚠中止が受け付けられていた。候補があっても**課金へ進まない**。
        setErrorMsg("検索を中止しました。課金は発生していません。");
        setState("cancelled");
        return;
      }
      if (decision.action === "too_many") {
        // ⚠取り違えて別の筆を買わないため、複数件は取得しない（発注者指示 2026-08-21）。
        setErrorMsg(
          `候補が複数見つかりました（${decision.count}件）。取り違えを防ぐため取得しません。物件の地番を絞り込んでからやり直してください。`,
        );
        setState("error");
        return;
      }
      if (decision.action === "obtain") {
        // 候補1件＝「選ぶ」「確認」を挟まずそのまま有料取得へ（発注者指示 2026-08-21）。
        setSelected(decision.candidate);
        await runObtain(decision.candidate);
        return;
      }
      setNotSearchableReason(res.candidates.length === 0 ? "no_candidates" : null);
      setState("results");
    } catch (e) {
      // ⚠**自分で押した中止を「失敗」として出さない**(@codex #357 P2)。
      // 中止は 409 で返るが、通信の失敗と同じ経路を通ると赤いエラー表示になり、
      // 「止めたのに何か問題が起きた」と誤解させる。課金が無いことも伝わらない。
      if (apiErrorCode(e) === "REGISTRY_SEARCH_CANCELLED") {
        searchCancelledRef.current = true;
        setErrorMsg(e instanceof Error ? e.message : null);
        setState("cancelled");
        return;
      }
      setErrorMsg(e instanceof Error ? e.message : "所在検索に失敗しました");
      setState("error");
    }
  };

  // 段階②(2026-07-31): 候補(地番)の有料取得。server 側が候補をキャッシュから再解決し、
  // 二重課金台帳→直列化→請求→PDF→物件添付まで行う。confirmed:true は api-client が付ける。
  /**
   * @param candidate 候補を**引数で**受け取る。⚠候補1件の自動進行では setSelected の
   *   反映を待てないため、state を読むと空のまま何も起きない。
   */
  const runObtain = async (candidate?: RegistrySearchCandidate) => {
    const target = candidate ?? selected;
    if (!target) return;
    // ボタンの disabled だけに頼らない(迂回への二重防御)。
    // 回収(runRecover)にはこのガードを入れない=課金しないのでスイッチと無関係。
    if (!purchaseEnabled) return;
    setLastAction("obtain");
    setState("obtaining");
    setErrorMsg(null);
    // 実況(2026-08-15)。取得のたびに新しい参照を発行し、検索と同じパネルで
    // 「いまサイトのどの画面で何をしているか」を追えるようにする。
    // 前回2回の実課金テストが**手がかり1行だけ**で原因を特定できなかった反省。
    // ⚠有料取得は中止不可なので、パネルに「中止」は出ない(server が窓を開けない)。
    const obtainLiveRef = safeRandomId();
    setLiveRef(obtainLiveRef);
    try {
      // 成功レスポンス本文は参照しない（非 PII だが UI に持ち込まない）。取得結果は
      // 「閉じる」時の物件再取得(onPropertyRefresh)で既存の権限ガード付きタブに反映する。
      await obtainRegistryByCandidate(
        propertyId,
        target.candidateRef,
        certificateType,
        obtainLiveRef,
      );
      setState("done");
      // 画面を作り直さずに、添付ファイル一覧と謄本の状態だけを静かに最新化する
      // (2026-08-20: 成功したのに一覧が増えず『取り込めていない』と誤解された)。
      // ⚠発注者指示(2026-08-20)=**知らせるのは失敗のときだけ**。成功時に
      //   **新しい通知は足さない**(トースト・自動タブ切替・自動スクロールを付けない)
      //   =結果が画面に出れば足りる。⚠**従来からの一行の完了表示(role="status")は残す**
      //   (「閉じる（物件情報を更新）」の導線と一体のため。設計提示時に明示して承認済み)。
      onRegistryResultApplied();
      // ⚠その場で親の再取得を呼ばない(@codex #380 R3 P2)。再取得は詳細ページを
      //   読み込み中の画面へ差し替え、このボタンごと作り直される=**取得成功の実況
      //   (最後のスクショと3分の見返し)が即座に消える**。地番保存(#373 R10 P2)と
      //   同じく、流れを閉じるとき(reset)にまとめて流す。
      propertyRefreshPendingRef.current = true;
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "謄本の取得に失敗しました");
      setState("error");
    }
  };

  // 【回収】既に購入済みの謄本を、再課金なしで取り込む(2026-08-19)。
  // 背景: 請求は成立したのにPDFの取り込みに失敗すると、二重課金ガードが効いて
  // 取り直せない=**払ったのに手元に残らない**。期限内なら課金せず回収できる。
  // ⚠この経路は有料取得のスイッチが入っていなくても使える(課金操作をしないため)。
  /**
   * @param fromProperty 候補を使わず**物件自身の地番**で取り込む
   *   (所在検索が対象外になった物件でも救えるようにするため)。
   */
  const runRecover = async (fromProperty = false) => {
    // ⚠**候補が無い=押しても無反応、にしない**(@codex #394 R10 P1)。
    //   検索できない物件からの入口は候補を持たないので、以前の早期 return では
    //   確認パネルのボタンが**何もしない**状態だった。判断は純関数に出す。
    const entry = resolveRecoverEntry({
      fromProperty,
      hasSelection: !!selected,
      // 土地と建物の両方があるときは、候補(建物優先)ではなく人が選んだ種類で探す。
      hasBothIdentifiers,
    });
    setLastAction("recover");
    setState("recovering");
    setErrorMsg(null);
    const recoverLiveRef = safeRandomId();
    setLiveRef(recoverLiveRef);
    try {
      if (entry === "property") {
        await recoverRegistryFromProperty(
          propertyId,
          certificateType,
          recoverLiveRef,
          // 両方持つ物件のときだけ意味を持つ(片方しか無ければサーバーが解決)。
          hasBothIdentifiers ? recoverKind : undefined,
          // ⚠**画面が見せていた内容**を一緒に送る(@codex #394 R20 P1)。確認の後に
          //   誰かが地番を編集していたら、server 側で 409 にして取り違えを防ぐ。
          {
            version: savedVersion ?? propertyVersion,
            address: propertyAddress,
            identifier: hasBothIdentifiers
              ? recoverKind === "land"
                ? propertyLotNumber
                : propertyBuildingNumber
              : ((propertyBuildingNumber ?? "").trim()
                  ? propertyBuildingNumber
                  : propertyLotNumber),
          },
        );
      } else {
        await recoverRegistryByCandidate(
          propertyId,
          selected!.candidateRef,
          certificateType,
          recoverLiveRef,
        );
      }
      setState("done");
      // 取得と同じく、画面を作り直さずに結果だけを反映する(新しい通知は足さない)。
      onRegistryResultApplied();
      propertyRefreshPendingRef.current = true;
    } catch (e) {
      setErrorMsg(
        e instanceof Error
          ? e.message
          : "取得済みの謄本を取り込めませんでした（課金は発生していません）",
      );
      setState("error");
      // ⚠**失敗後は物件を取り直す**(@codex #394 R27 P2)。取得の予約(ロック)が
      //   版番号を上げるため、古い版のままもう一度押すと、サーバーが
      //   「物件情報が変わりました」で**永久に**弾いてしまう。閉じたときに
      //   まとめて取り直す(成功時と同じ流儀)。
      propertyRefreshPendingRef.current = true;
    }
  };

  // ⚠done では検索ボタンを出さない(@codex #380 R4 P2)。done 中は物件の再取得が
  //   保留されており(propertyRefreshPendingRef)、このボタンの handler は reset() で
  //   それを流してから confirmSearch に入る=親が読み込み中に差し替わって
  //   **始めたばかりの確認の流れごと捨てられる**。done で出すのは「閉じる」だけにし、
  //   閉じて(=再取得して)から改めて検索してもらう。
  const showButton = state === "idle";

  return (
    <div className="mb-4 flex flex-col gap-1">
      {showButton && (
        <button
          type="button"
          onClick={() => {
            if (providerDisabled) return;
            reset();
            setState("confirmSearch");
          }}
          disabled={providerDisabled}
          className={
            "flex w-fit items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white " +
            "bg-indigo-600 hover:bg-indigo-700 " +
            "disabled:cursor-not-allowed disabled:opacity-60"
          }
        >
          <MapPinned className="h-3.5 w-3.5" />
          所在で謄本を検索
        </button>
      )}

      {/* 【回収】購入済みの取り込みは**「所在で謄本を検索」の流れの中**で行う(発注者指示 2026-08-21)。
          候補を選ぶと確認画面に「取得する（有料）／取得済みを取り込む（課金なし）」の2択が出る。
          ⚠**検索が使えないとき**と**流れが行き止まりになったとき**は、ここへ戻れないと
            買った書類に手が届かない(謄本には取得期限がある)。同じ入口を差し込む
            (@codex #394 R16 P2 / #398 R2 P1)。 */}
      {showButton && providerDisabled && recoverEntryLink}

      {/* ⚠**使える機能まで『利用できません』と言わない**(@codex #394 R17 P2)。
          所在検索が使えなくても、取り込み(回収)は別条件で使える。期限のある
          書類なので、ここで諦めさせると実害になる。 */}
      {providerDisabled && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {recoverConfigured
            ? "所在での検索は現在利用できません（取得済みの謄本の取り込みはご利用いただけます）。"
            : "謄本取得プロバイダが未設定のため現在利用できません。"}
        </p>
      )}

      {state === "done" && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <p className="text-green-600 dark:text-green-400" role="status">
            {lastAction === "recover"
              ? "取得済みの謄本を取り込みました（今回の料金は発生していません）。"
              : "謄本を取得しました。下の実況で仕上がりを確認できます。"}
          </p>
          {/* ⚠**ページを作り直す**取り直しは閉じたときだけ(@codex #380 R3 P2)。その場で
              呼ぶと詳細ページが読み込み中の画面に差し替わり、実況の見返しが即座に消える。
              成功直後の反映は onRegistryResultApplied（画面を作り直さない静かな更新）が担う。 */}
          <button
            type="button"
            onClick={reset}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            閉じる（物件情報を更新）
          </button>
        </div>
      )}

      {state === "cancelled" && (
        <div className="flex flex-col gap-1 text-[11px]">
          <p className="text-gray-600 dark:text-gray-300" role="status">
            {errorMsg ?? "取得を中止しました。課金は発生していません。"}
          </p>
          {recoverEntryLink}
          <button type="button" onClick={reset} className="w-fit text-indigo-600 dark:text-indigo-400 hover:underline">
            閉じる
          </button>
        </div>
      )}

      {state === "error" && errorMsg && (
        <div
          ref={errorBannerRef}
          className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-950/40"
        >
          <p
            className="flex items-start gap-1.5 text-xs font-medium text-red-700 dark:text-red-300"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </p>
          {recoverEntryLink}
          <button
            type="button"
            onClick={reset}
            className="w-fit text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            閉じる
          </button>
        </div>
      )}

      {/* ⚠番号が無い物件では、確認パネルの**前に**地番を入れてもらう（設計 §3.1）。
          保存したら物件を取り直し、分類が変わって通常の確認パネルになる。 */}
      {state === "confirmSearch" && target?.kind === "none" && (
        <RegistryChibanPopup
          propertyId={propertyId}
          propertyAddress={propertyAddress}
          propertyVersion={savedVersion ?? propertyVersion}
          registryLoginUrl={preflight.loginUrl}
          canWriteProperty={canWriteProperty}
          offerBuildingPath={offerBuildingPath}
          onSaved={(nextVersion) => {
            // ⚠ここで検索を投げない。分類を取り直して、料金の確認へ進むだけ。
            // ⚠親の取り直し（onPropertyRefresh）はここでは呼ばない。呼ぶと詳細ページが
            //   読み込み中の画面に切り替わり、このボタンごと作り直されて
            //   確認パネルへ進めない（@codex #373 R10 P2）。閉じるときにまとめて流す。
            if (nextVersion != null) setSavedVersion(nextVersion);
            propertyRefreshPendingRef.current = true;
            setPreflightReload((n) => n + 1);
          }}
          onClose={reset}
        />
      )}

      {state === "confirmSearch" && target?.kind !== "none" && (
        <div className="flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 p-2 text-xs">
          <p className="font-medium text-indigo-800 dark:text-indigo-300">所在で謄本候補を検索しますか？</p>
          <p className="text-indigo-700 dark:text-indigo-300">
            登記情報の検索は有料処理になり得ます。実行には明示的な確認が必要です。
          </p>
          <RegistryTargetNote state={preflight} propertyId={propertyId} />
          {/* ⚠**種類は検索の前に選ぶ**（発注者指示 2026-08-21）。候補が1件なら
              そのまま取得まで進むため、あとから選ぶ画面が無い。既定は安い方
              （所有者事項）。全部事項が必要なときの道を塞がないため、ここに置く。 */}
          {(!target || isSearchableTarget(target.kind)) && (
            <fieldset className="mt-1 flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 p-1.5">
              <legend className="px-1 text-indigo-800 dark:text-indigo-300">取得する種類</legend>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="certificateTypeBeforeSearch"
                  checked={certificateType === "owner"}
                  onChange={() => setCertificateType("owner")}
                />
                所有者事項（所有者の確認向け・料金が安い）
              </label>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="certificateTypeBeforeSearch"
                  checked={certificateType === "all"}
                  onChange={() => setCertificateType("all")}
                />
                全部事項（権利関係まで・料金が高い）
              </label>
            </fieldset>
          )}
          {/* ⚠**候補が1件なら、そのまま取得（課金）まで進む**。止められるのは検索中だけ。 */}
          {(!target || isSearchableTarget(target.kind)) && purchaseEnabled && (
            <p className="text-amber-700 dark:text-amber-400">
              ⚠候補が1件だけ見つかった場合は、そのまま取得（有料）まで進みます。
              やめるときは検索中に「中止」を押してください（課金の後は取り消せません）。
              候補が複数のときは取得せずに止まります。
            </p>
          )}
          <div className="mt-1 flex gap-1">
            {/* ⚠サーバーが必ず弾く分類（住所が無い・番号が読めない・不動産番号がある）
                では、実行の導線自体を出さない。出すと「押したのに毎回断られる」だけ。
                ⚠分類がまだ読めていない間（pending / targetsUnavailable）は、
                出したうえで押せなくする（fail closed・確認中であることが伝わる）。 */}
            {(!target || isSearchableTarget(target.kind)) && (
              <button
                type="button"
                onClick={runSearch}
                disabled={preflight.pending || preflight.targetsUnavailable}
                className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700"
              >
                {preflight.pending ? "確認中..." : "検索する"}
              </button>
            )}
            {/* ⚠検索できない物件にも**回収**の入口を出す(@codex #394 R6 P1)。
                取込が途中まで進むと不動産番号が入って所在検索の対象外になり、
                候補経由の入口だけだと**買った書類に二度と手が届かない**。
                この経路は物件自身の地番で探すので候補が要らず、課金もしない。 */}
            {target && !isSearchableTarget(target.kind) && (
              <button
                type="button"
                onClick={() => {
                  // ⚠**種類(所有者事項/全部事項)を選ばせてから**走らせる
                  //   (@codex #394 R9 P1)。既定のまま固定すると、全部事項で
                  //   買ったものが永久に取り込めない(同定が種類まで見るため)。
                  setSelected(null);
                  setState("confirmObtain");
                }}
                className="rounded border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-gray-900 px-2 py-1 font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10"
              >
                取得済みを取り込む（課金なし）
              </button>
            )}
            <button type="button" onClick={reset} className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
              {target && !isSearchableTarget(target.kind) ? "閉じる" : "キャンセル"}
            </button>
          </div>
        </div>
      )}

      {(state === "searching" || state === "obtaining" || state === "recovering") && (
        <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {state === "searching"
            ? "検索中..."
            : state === "recovering"
              ? "取り込み中...（課金はしません）"
              : "取得中..."}
        </span>
      )}

      {/* 実況パネル: 検索実行中の自動操作をスクショ紙芝居で中継する。
          検索完了 (results/error) 後も維持し、最後の画面を見返せるようにする
          (@codex P2: searching 限定だと POST 完了と同時に unmount され「(完了)」
          表示も 3 分の見返しも実際には見えない)。「閉じる」(reset) で消える。
          server 側のスクショは TTL で自動消滅する。 */}
      {liveRef &&
        (state === "searching" ||
          state === "results" ||
          // 有料取得の間と後も残す(2026-08-15)。取得は数十秒〜数分かかるうえ、
          // 失敗時に「どの画面のどの段で止まったか」を本人が見返せることが
          // この実況の主目的(実課金テスト2回が手がかり1行で終わった反省)。
          state === "obtaining" ||
          // 回収(課金なし)の間も同じパネルで進行を見せる。
          state === "recovering" ||
          state === "done" ||
          // 中止のときも残す (@codex #357 P2)。どこまで進んで止まったかを
          // 本人が確かめられないと「本当に止まったのか」が分からない。
          state === "cancelled" ||
          state === "error") && (
          <RegistryLivePanel
            // ⚠liveRef ごとに**作り直す**(@codex #380 P2)。検索の3分の見返し期限が
            //   切れた後に「取得」を押すと、同じ部品が使い回されて内部状態
            //   (steps/done/expired/ポーリング停止)が残り、有料取得が走っているのに
            //   「表示期限が切れました」のまま固まる。key で remount して全部リセット。
            key={liveRef}
            propertyId={propertyId}
            liveRef={liveRef}
            searchSettled={
              state !== "searching" &&
              state !== "obtaining" &&
              state !== "recovering"
            }
            // ⚠「中止」は無料の検索中だけ。有料取得(obtaining)で出すと、課金中に
            //   「課金は発生しません」という嘘の説明つきボタンが出る(server は
            //   受け付けないが表示が矛盾する)。
            cancelable={state === "searching"}
            // ⚠中止が受け付けられたら覚えておく。直後に検索結果が返っても
            //   有料取得へ進ませない（課金の後は取り消せない）。
            onCancelAccepted={() => {
              searchCancelledRef.current = true;
            }}
          />
        )}

      {state === "results" && (
        <div className="flex flex-col gap-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-xs">
          {notSearchableReason ? (
            <p className="text-gray-600 dark:text-gray-300">
              {notSearchableReason === "no_candidates"
                ? "該当する謄本候補が見つかりませんでした。"
                : reasonText(notSearchableReason)}
            </p>
          ) : (
            <>
              <p className="font-medium text-gray-700 dark:text-gray-200">
                候補（{candidates.length}件）が見つかりました
              </p>
              {/* 段階②(2026-07-31): 候補を選んで有料の請求→PDF取得まで実行できる。
                  ⚠有料取得は専用オプトイン(purchaseEnabled)が立つまで準備中表示(@codex #345 P1)。 */}
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {purchaseEnabled
                  ? "取得は有料です（謄本1通ごとに登記情報提供サービスの利用料がかかります）。"
                  : "候補からの謄本取得（有料）は現在準備中です。"}
              </p>
              <ul className="flex flex-col gap-1">
                {candidates.map((c) => (
                  <li
                    key={c.candidateRef}
                    className="flex items-center justify-between gap-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-2 py-1"
                  >
                    <span className="min-w-0 text-gray-700 dark:text-gray-200">
                      <span className="block truncate">{c.address ?? "（所在不明）"}</span>
                      <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                        {[c.lotNumber && `地番 ${c.lotNumber}`, c.buildingNumber && `家屋番号 ${c.buildingNumber}`]
                          .filter(Boolean)
                          .join(" / ") || "（地番・家屋番号なし）"}
                      </span>
                    </span>
                    {/* ⚠有料スイッチが入っていなくても押せる。次の画面で
                        「取得(有料)」と「取得済みを取り込む(課金なし)」を選ぶため。
                        取得の方は次の画面で押せなくなる(準備中)。 */}
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(c);
                        setState("confirmObtain");
                      }}
                      className="shrink-0 rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700"
                    >
                      選ぶ
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* ⚠候補が0件でも行き止まりにしない。買った書類が残っているかもしれない。 */}
          {candidates.length === 0 && recoverEntryLink}
          <button type="button" onClick={reset} className="w-fit text-gray-500 dark:text-gray-400 hover:underline">
            閉じる
          </button>
        </div>
      )}

      {state === "confirmObtain" && (
        <div className="flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 p-2 text-xs">
          <p className="font-medium text-indigo-800 dark:text-indigo-300">
            {selected
              ? "この候補で何をしますか？"
              : "取得済みの謄本を取り込みますか？（課金なし）"}
          </p>
          <RegistryPreflightWarningLines state={preflight} propertyId={propertyId} />
          {selected ? (
            <>
              <p className="truncate text-indigo-700 dark:text-indigo-300">{selected.address ?? "（所在不明）"}</p>
              <p className="truncate text-indigo-700 dark:text-indigo-300">
                {[
                  selected.lotNumber && `地番 ${selected.lotNumber}`,
                  selected.buildingNumber && `家屋番号 ${selected.buildingNumber}`,
                ]
                  .filter(Boolean)
                  .join(" / ")}
              </p>
            </>
          ) : (
            <>
              <p className="text-indigo-700 dark:text-indigo-300">
                この物件に登録されている所在・地番で、購入済みの謄本を探します。
              </p>
            </>
          )}
          {/* ⚠土地/建物の選択は**候補の有無にかかわらず**出す(@codex #398 R1 P1)。
              所在検索は家屋番号(建物)を優先して候補を返すため、ここが無いと
              **買った土地の謄本に永久に手が届かない**(謄本には取得期限がある)。 */}
          {hasBothIdentifiers && (
            <fieldset className="mt-1 flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 p-1.5">
              <legend className="px-1 text-indigo-800 dark:text-indigo-300">
                どちらを取り込みますか？（取り込みのみ）
              </legend>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="recoverKind"
                  checked={recoverKind === "land"}
                  onChange={() => setRecoverKind("land")}
                />
                土地（地番 {propertyLotNumber}）
              </label>
              <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                <input
                  type="radio"
                  name="recoverKind"
                  checked={recoverKind === "building"}
                  onChange={() => setRecoverKind("building")}
                />
                建物（家屋番号 {propertyBuildingNumber}）
              </label>
            </fieldset>
          )}
          <fieldset className="mt-1 flex flex-col gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 p-1.5">
            <legend className="px-1 text-indigo-800 dark:text-indigo-300">取得する種類</legend>
            <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
              <input
                type="radio"
                name="certificateType"
                checked={certificateType === "owner"}
                onChange={() => setCertificateType("owner")}
              />
              所有者事項（所有者の確認向け・料金が安い）
            </label>
            <label className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
              <input
                type="radio"
                name="certificateType"
                checked={certificateType === "all"}
                onChange={() => setCertificateType("all")}
              />
              全部事項（権利関係まで・料金が高い）
            </label>
          </fieldset>
          {selected && (
          <p className="text-indigo-700 dark:text-indigo-300">
            取得すると謄本1通分の利用料が発生します（
            {certificateType === "all" ? "全部事項・料金が高い方" : "所有者事項"}
            ）。取得後は物件に自動で添付されます。
            {certificateType === "all" && (
              <span className="mt-0.5 block text-[11px] text-indigo-600 dark:text-indigo-400">
                ※全部事項は過去の所有者も載るため、所有者一覧への自動反映は行わず、PDFの添付のみになります。
              </span>
            )}
          </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {/* 有料取得は候補を選んだときだけ(候補なしの入口は回収専用)。 */}
            {selected && (
            <button
              type="button"
              // ⚠**関数を直接渡さない**。引数を取るようになったため、クリックイベントが
              //   候補として渡ってしまう（tsc が検出）。
              onClick={() => runObtain()}
              disabled={
                !purchaseEnabled ||
                preflight.pending ||
                preflight.targetsUnavailable
              }
              title={
                !purchaseEnabled
                  ? "有料取得は準備中です"
                  : preflight.pending
                    ? "事前確認中です"
                    : undefined
              }
              className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {preflight.pending ? "確認中..." : "取得する（有料）"}
            </button>
            )}
            {/* 【回収】既に買った書類の取り込み。⚠有料スイッチと無関係に使える
                (課金操作をしないため)。押しても新たな料金は発生しない。 */}
            <button
              type="button"
              onClick={() => runRecover(!selected)}
              disabled={preflight.pending || preflight.targetsUnavailable}
              title={preflight.pending ? "事前確認中です" : undefined}
              className="rounded border border-indigo-300 dark:border-indigo-500/40 bg-white dark:bg-gray-900 px-2 py-1 font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              取得済みを取り込む（課金なし）
            </button>
            <button
              type="button"
              onClick={() => {
                if (!selected) {
                  reset();
                  return;
                }
                setSelected(null);
                setState("results");
              }}
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              戻る
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-400">
            ※「取得済みを取り込む」は、以前この地番で購入した謄本が登記情報提供サービスに
            残っている場合だけ使えます（購入から一定期間内）。新たな料金はかかりません。
            見つからないときは何も起きません。
          </p>
        </div>
      )}
    </div>
  );
}
