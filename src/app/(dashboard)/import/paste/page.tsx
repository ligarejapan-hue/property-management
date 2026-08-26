"use client";

/**
 * 「貼り付けて物件化」画面（Task 9）。
 *
 * 反響メール・査定依頼フォームの内容をコピーして貼り付ける（または PDF を
 * アップロードする）と、そこから住所・所有者などを読み取って下書きを作る。
 * 人が確認・修正してから登録する（読み取り結果を無言で信用しない）。
 *
 * この画面自体は状態(state)を持つだけの薄い入れ物。表示は
 * `PasteImportReview`（表示専用部品）に委ねる。
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import ImportSwitcher from "@/components/import/import-switcher";
import {
  PasteImportReview,
  defaultPropertyValues,
  defaultOwnerValues,
  defaultOwnerMode,
  foldNoColumnFieldsIntoNote,
  type PasteDuplicatesResult,
  type SimilarPropertySummary,
  type OwnerCandidateSummary,
  type OwnerMode,
  type PropertyFieldKey,
  type PropertyValues,
  type OwnerFieldKey,
  type OwnerValues,
} from "@/components/import/paste-import-review";
import type { PasteDraft } from "@/lib/paste-import/types";

interface PasteApiResponse {
  draft: PasteDraft;
  duplicates: PasteDuplicatesResult;
  similar: SimilarPropertySummary[];
  ownerCandidates: OwnerCandidateSummary[];
  /**
   * PDF を投入したときだけ、そこから取り出した本文が入る（貼り付け経路では null）。
   * ⚠PDF の人は原文を手元に持っていないため、これが無いと確認画面の左側で
   *   何も突き合わせられない（以前は「（PDF: ファイル名）」しか出ていなかった）。
   */
  extractedText: string | null;
}

/** 見直しAPI(/api/import/paste/recheck)の応答。下書きAPIと同じ形の一部。 */
interface PasteRecheckResponse {
  duplicates: PasteDuplicatesResult;
  similar: SimilarPropertySummary[];
  ownerCandidates: OwnerCandidateSummary[];
}

interface CommitApiResponse {
  propertyId: string;
  ownerId: string | null;
}

/** 非2xx応答からエラーメッセージを取り出す（api-client.ts の toApiError と同じ姿勢）。 */
async function readApiErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `処理に失敗しました（${res.status}）`;
}

export default function PasteImportPage() {
  const router = useRouter();

  // ---- 入力(貼り付け or PDF) ----
  const [rawText, setRawText] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // ---- 読み取り結果(下書き) ----
  const [draft, setDraft] = useState<PasteDraft | null>(null);
  const [duplicates, setDuplicates] = useState<PasteDuplicatesResult | null>(null);
  const [similar, setSimilar] = useState<SimilarPropertySummary[]>([]);
  const [ownerCandidates, setOwnerCandidates] = useState<OwnerCandidateSummary[]>([]);
  /** 確認画面の左側に出す原文。PDF はサーバーが取り出した本文を使う。 */
  const [extractedText, setExtractedText] = useState<string | null>(null);

  // ---- 人が直した最終値 ----
  const [propertyValues, setPropertyValues] = useState<PropertyValues | null>(null);
  const [ownerValues, setOwnerValues] = useState<OwnerValues | null>(null);
  const [note, setNote] = useState("");
  /** 査定ナンバー等の外部キー。⚠人が確認・修正できる欄として持つ(設計書 §5.4)。 */
  const [externalLinkKey, setExternalLinkKey] = useState("");
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [ownerMode, setOwnerMode] = useState<OwnerMode>("none");
  const [linkedOwnerId, setLinkedOwnerId] = useState<string | null>(null);

  // ---- 登録 ----
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const handleRead = useCallback(async () => {
    setReading(true);
    setReadError(null);
    try {
      let res: Response;
      if (pdfFile) {
        const form = new FormData();
        form.append("file", pdfFile);
        res = await fetch("/api/import/paste", { method: "POST", body: form });
      } else {
        if (rawText.trim() === "") {
          throw new Error("貼り付けた文章がありません");
        }
        res = await fetch("/api/import/paste", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: rawText }),
        });
      }
      if (!res.ok) throw new Error(await readApiErrorMessage(res));
      const data = (await res.json()) as PasteApiResponse;

      setDraft(data.draft);
      setDuplicates(data.duplicates);
      setSimilar(data.similar);
      setOwnerCandidates(data.ownerCandidates);
      setExtractedText(data.extractedText);
      setPropertyValues(defaultPropertyValues(data.draft));
      setOwnerValues(defaultOwnerValues(data.draft));
      setNote(data.draft.noteFromUnmapped);
      setExternalLinkKey(data.draft.externalLinkKey ?? "");
      setRecheckError(null);
      setOwnerMode(defaultOwnerMode(data.draft));
      setLinkedOwnerId(null);
      setRegisterError(null);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "読み取りに失敗しました");
    } finally {
      setReading(false);
    }
  }, [pdfFile, rawText]);

  const handlePropertyFieldChange = useCallback((key: PropertyFieldKey, value: string) => {
    setPropertyValues((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const handleOwnerFieldChange = useCallback((key: OwnerFieldKey, value: string) => {
    setOwnerValues((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  /**
   * 人が直したあとの値で、重複の見立てをやり直す。
   *
   * ⚠**住所の重複は登録APIが意図的にブロックしない**(人が判断すべきなので)＝
   *   画面の警告が唯一の防御線。読み取り直後の判定のままにすると、直した結果が
   *   既存と一致しても警告が出ない(@codex PR#414 6巡目 ②③)。
   * ⚠所有者も同じ。読み取りが崩れた氏名を正しい氏名に直した瞬間こそ候補が要る。
   */
  const recheckDuplicates = useCallback(async (): Promise<PasteRecheckResponse | null> => {
    if (!propertyValues) return null;
    try {
      const res = await fetch("/api/import/paste/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: propertyValues.address,
          lotNumber: propertyValues.lotNumber,
          externalLinkKey,
          // ⚠**link(既存の所有者に紐付ける)のときも氏名で引く**
          //   (@codex PR#414 8巡目 ①)。空で送ると候補ゼロが返り、画面から
          //   選択肢が消えるのに linkedOwnerId だけ残る＝**画面に何も出ていない
          //   相手に紐付いたまま登録が通る**。候補を見つけたときと同じ値
          //   (人が直した氏名・現住所)で引き直し、選択が見えたままになるようにする。
          ownerName: ownerMode === "none" ? "" : (ownerValues?.name ?? ""),
          ownerCurrentAddress:
            ownerMode === "none" ? "" : (ownerValues?.currentAddress ?? ""),
        }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res));
      const data = (await res.json()) as PasteRecheckResponse;
      setDuplicates(data.duplicates);
      setSimilar(data.similar);
      setOwnerCandidates(data.ownerCandidates);

      // ⚠**見えない紐付けを残さない**。選んでいた相手が候補から消えたら、
      //   選択そのものを外して理由を出す(登録は下のガードで止まる)。
      if (
        linkedOwnerId !== null &&
        !data.ownerCandidates.some((c) => c.id === linkedOwnerId)
      ) {
        setLinkedOwnerId(null);
        setRecheckError(
          "選んでいた所有者が候補から外れました。所有者の扱いを選び直してください。",
        );
        return data;
      }

      setRecheckError(null);
      return data;
    } catch (e) {
      // ⚠黙って古い判定のままにしない。効いていないことを画面で伝える。
      setRecheckError(
        `重複の確認ができませんでした（${
          e instanceof Error ? e.message : "通信に失敗しました"
        }）。表示中の重複警告は直す前の内容にもとづくものです。`,
      );
      return null;
    }
  }, [propertyValues, ownerValues, ownerMode, externalLinkKey, linkedOwnerId]);

  const handleRegister = useCallback(async () => {
    if (!draft || !propertyValues || !ownerValues) return;
    if (propertyValues.address.trim() === "") {
      setRegisterError("住所を入力してください");
      return;
    }
    // ⚠「新しい所有者として登録する」のまま氏名が空なら送らない。以前はここで
    //   無言に owner: null へ落ち、**所有者なしで登録が成功**していた
    //   (電話・メール・住所も一緒に捨てられる)。利用者の選択を読み替えない。
    if (ownerMode === "new" && ownerValues.name.trim() === "") {
      setRegisterError(
        "所有者の氏名を入力してください。所有者を作らない場合は「所有者なしで登録する」を選んでください。",
      );
      return;
    }
    // ⚠link のまま相手が選ばれていない状態では登録させない
    //   (見えない紐付けを作らない・@codex PR#414 8巡目 ①)。
    if (ownerMode === "link" && !linkedOwnerId) {
      setRegisterError(
        "紐付ける所有者が選ばれていません。候補から選ぶか、「新しい所有者として登録する」「所有者なしで登録する」を選んでください。",
      );
      return;
    }
    setRegistering(true);
    setRegisterError(null);
    try {
      // ⚠登録の直前にもう一度見直す(欄を直した直後にそのまま押される経路がある)。
      //   ⚠**結果を全部見る**(@codex PR#414 7巡目 ②)。blocked だけを見ていた頃は、
      //   直前の編集で似た物件や所有者候補が新しく見つかっても人に見せずに
      //   登録していた＝見直しを足した目的が半分死んでいた。
      const beforeSimilar = similar.map((x) => x.id).sort().join(",");
      const beforeOwners = ownerCandidates.map((x) => x.id).sort().join(",");
      const latest = await recheckDuplicates();

      // ⚠**確認できなかったときに通してはいけない**(確認しないより悪い＝
      //   確認したつもりになる)。やり直せるようにして止める。
      if (latest === null) {
        setRegisterError(
          "重複の確認ができませんでした。通信の状態を確かめて、もう一度お試しください。",
        );
        return;
      }

      if (latest.duplicates.blocked) {
        setRegisterError("この案件は登録済みです");
        return;
      }

      // ⚠再判定の結果、選んでいた相手が候補から消えていたら**紐付けごと外す**。
      //   確認できない相手に紐付けたまま登録させない。
      if (
        ownerMode === "link" &&
        (linkedOwnerId === null ||
          !latest.ownerCandidates.some((c) => c.id === linkedOwnerId))
      ) {
        setLinkedOwnerId(null);
        setRegisterError(
          "選んでいた所有者が候補から外れました。所有者の扱いを選び直してください。",
        );
        return;
      }

      // 直前の編集で新しい一致が見つかったら、**人に見せてから**確定させる。
      // 画面は recheckDuplicates が既に更新済み。もう一度押せば登録できる。
      const afterSimilar = latest.similar.map((x) => x.id).sort().join(",");
      const afterOwners = latest.ownerCandidates.map((x) => x.id).sort().join(",");
      if (afterSimilar !== beforeSimilar || afterOwners !== beforeOwners) {
        setRegisterError(
          "入力の変更により、似ている物件／所有者が見つかりました。ご確認のうえ、もう一度「この内容で登録」を押してください。",
        );
        return;
      }
      // ⚠土地面積・築年は Property に対応する列が無い(commit API の契約にも無い)。
      //   画面では編集可能な欄として出しているため、値を無言で捨てず備考へ行として
      //   足す(既存の備考は消さない)。詳細は paste-import-review.tsx の
      //   FIELD_NO_COLUMN_HINT のコメント参照。
      const finalNote = foldNoColumnFieldsIntoNote(note, {
        landArea: propertyValues.landArea,
        builtYear: propertyValues.builtYear,
      });
      const body = {
        property: {
          address: propertyValues.address,
          lotNumber: propertyValues.lotNumber || null,
          propertyType: propertyValues.propertyType || "unknown",
          buildingName: propertyValues.buildingName || null,
          roomNo: propertyValues.roomNo || null,
          exclusiveArea: propertyValues.exclusiveArea || null,
          layoutType: propertyValues.layoutType || null,
          occupancyStatus: propertyValues.occupancyStatus || null,
          note: finalNote || null,
        },
        owner:
          ownerMode === "new" && ownerValues.name.trim() !== ""
            ? {
                name: ownerValues.name,
                nameKana: ownerValues.nameKana || null,
                phone: ownerValues.phone || null,
                email: ownerValues.email || null,
                currentAddress: ownerValues.currentAddress || null,
              }
            : null,
        // ⚠人が直した値をそのまま使う。空にしたら外部キー無しとして登録する
        //   (＝住所での重複判定に委ねられる)。
        externalLinkKey: externalLinkKey.trim() || null,
        linkExistingOwnerId: ownerMode === "link" ? linkedOwnerId : null,
      };

      let res: Response;
      if (pdfFile) {
        // 取込元の PDF をそのまま物件の添付として残す。
        const form = new FormData();
        form.append("data", JSON.stringify(body));
        form.append("file", pdfFile);
        res = await fetch("/api/import/paste/commit", { method: "POST", body: form });
      } else {
        res = await fetch("/api/import/paste/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) throw new Error(await readApiErrorMessage(res));
      const result = (await res.json()) as CommitApiResponse;
      router.push(`/properties/${result.propertyId}`);
    } catch (e) {
      setRegisterError(e instanceof Error ? e.message : "登録に失敗しました");
    } finally {
      setRegistering(false);
    }
  }, [
    draft, propertyValues, ownerValues, note, ownerMode, linkedOwnerId, pdfFile, router,
    externalLinkKey, recheckDuplicates, similar, ownerCandidates,
  ]);

  return (
    // ⚠**画面の最上位**に PII 保護の印を付ける(@codex PR#414 3巡目)。
    //   ScreenProtectionGuard はこの印が付いた要素の**内側でしか**コピー・
    //   右クリック・印刷を抑止・監査しない。この画面は貼った原文(資料まるごと)と
    //   所有者の氏名・住所・電話・メールが同じ画面に並ぶ＝この機能でいちばん
    //   個人情報が濃い画面なので、貼り付け欄・原文の表示・確認画面のフォームが
    //   **すべて内側に入る**この位置に付ける(一部だけ内側だと外は無防備)。
    //   兄弟の取込画面3つ(import / import/registry-dm / import/jobs/[jobId])と同じ形。
    <div data-pii-protected data-pii-surface="import" className="space-y-6">
      <ImportSwitcher />
      <PageHeader
        title="貼り付けて物件化"
        description="反響メール・査定依頼フォームの内容をコピーして貼り付ける（または PDF をアップロードする）と、住所や所有者を読み取って下書きを作ります。内容を確認してから登録してください。"
      />

      {!draft && (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div>
            <label htmlFor="paste-raw-text" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
              貼り付け
            </label>
            <textarea
              id="paste-raw-text"
              rows={12}
              className="w-full rounded-md border border-gray-300 bg-white p-3 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              placeholder="反響メールや査定依頼フォームの内容をここに貼り付けてください"
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                if (e.target.value) setPdfFile(null);
              }}
              disabled={reading}
            />
          </div>

          <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            または
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>

          <div>
            <label htmlFor="paste-pdf-file" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">
              PDFをアップロード
            </label>
            <input
              id="paste-pdf-file"
              type="file"
              accept="application/pdf"
              className="block text-sm text-gray-700 dark:text-gray-300"
              disabled={reading}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setPdfFile(f);
                if (f) setRawText("");
              }}
            />
            {pdfFile && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                選択中: {pdfFile.name}
              </p>
            )}
          </div>

          {readError && (
            <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {readError}
            </div>
          )}

          <div>
            <Button onClick={handleRead} disabled={reading || (!rawText.trim() && !pdfFile)}>
              {reading ? "読み取っています…" : "読み取る"}
            </Button>
          </div>
        </section>
      )}

      {draft && propertyValues && ownerValues && (
        <>
          <div>
            <Button
              variant="secondary"
              size="sm"
              // 登録処理中は貼り直しもさせない(進行中の登録の足元を崩さない)。
              disabled={registering}
              onClick={() => {
                setDraft(null);
                setDuplicates(null);
                setSimilar([]);
                setOwnerCandidates([]);
                setExtractedText(null);
                setExternalLinkKey("");
                setRecheckError(null);
                setPropertyValues(null);
                setOwnerValues(null);
                setRegisterError(null);
              }}
            >
              ← 貼り直す
            </Button>
          </div>

          <PasteImportReview
            draft={draft}
            rawText={extractedText ?? rawText}
            propertyValues={propertyValues}
            onPropertyFieldChange={handlePropertyFieldChange}
            ownerValues={ownerValues}
            onOwnerFieldChange={handleOwnerFieldChange}
            note={note}
            onNoteChange={setNote}
            externalLinkKey={externalLinkKey}
            onExternalLinkKeyChange={setExternalLinkKey}
            onDuplicateInputBlur={() => { void recheckDuplicates(); }}
            recheckError={recheckError}
            duplicates={duplicates ?? undefined}
            similar={similar}
            ownerCandidates={ownerCandidates}
            ownerMode={ownerMode}
            onOwnerModeChange={setOwnerMode}
            linkedOwnerId={linkedOwnerId}
            onLinkedOwnerChange={setLinkedOwnerId}
            onRegister={handleRegister}
            registering={registering}
            registerError={registerError}
          />
        </>
      )}
    </div>
  );
}
