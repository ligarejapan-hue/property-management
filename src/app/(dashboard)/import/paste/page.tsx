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

  // ---- 人が直した最終値 ----
  const [propertyValues, setPropertyValues] = useState<PropertyValues | null>(null);
  const [ownerValues, setOwnerValues] = useState<OwnerValues | null>(null);
  const [note, setNote] = useState("");
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
      setPropertyValues(defaultPropertyValues(data.draft));
      setOwnerValues(defaultOwnerValues(data.draft));
      setNote(data.draft.noteFromUnmapped);
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

  const handleRegister = useCallback(async () => {
    if (!draft || !propertyValues || !ownerValues) return;
    if (propertyValues.address.trim() === "") {
      setRegisterError("住所を入力してください");
      return;
    }
    setRegistering(true);
    setRegisterError(null);
    try {
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
          note: note || null,
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
        externalLinkKey: draft.externalLinkKey,
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
  }, [draft, propertyValues, ownerValues, note, ownerMode, linkedOwnerId, pdfFile, router]);

  return (
    <div className="space-y-6">
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
              onClick={() => {
                setDraft(null);
                setDuplicates(null);
                setSimilar([]);
                setOwnerCandidates([]);
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
            rawText={pdfFile ? `（PDF: ${pdfFile.name}）` : rawText}
            propertyValues={propertyValues}
            onPropertyFieldChange={handlePropertyFieldChange}
            ownerValues={ownerValues}
            onOwnerFieldChange={handleOwnerFieldChange}
            note={note}
            onNoteChange={setNote}
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
