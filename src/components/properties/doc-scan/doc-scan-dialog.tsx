"use client";

/**
 * 書類を撮る(第3段・2026-10-25 発注者決定=スマホの中で紙を見つける方式)。
 *
 * 流れ: カメラ(紙の枠を重ねて出す)→ 撮る → 紙の範囲(角を指で直せる・仕上がりを選ぶ)
 *   → 次を撮る … → 撮った一覧(並べ替え・削除)→「PDFにして添付に入れる」/「書類ではない」(写真タブへ)。
 * ⚠紙を見つける・形を直すのは端末の中(OpenCV.js)。送るのは直したあとの JPEG だけ(EXIF なし)。
 * ⚠写真・動画は縦横比のまま表示する(object-contain・height auto)。
 * ⚠カメラはこの画面を閉じたら必ず止める(スマホの「カメラ使用中」を残さない)。
 * カメラが使えない(許可しない・古い端末)ときは、OS のカメラで1枚ずつ撮る形に切り替える。
 * ⚠ボタンは全画面のカメラ用の見た目(黒地)なので、手書きのボタンに data-motion="off"(押して沈ませない=撮る瞬間に画面を揺らさない)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeRandomId } from "@/lib/random-id";
import { defaultQuad, scaleQuad, type Quad } from "@/lib/doc-scan/geometry";
import { MAX_SCAN_PAGES, addPage, movePage, removePage } from "@/lib/doc-scan/pages";
import { loadOpenCv, type CV } from "@/lib/doc-scan/opencv-loader";
import { detectQuad, warpDocument, type ScanFinish } from "@/lib/doc-scan/detect";
import { canvasToJpeg, cropToQuadBounds, drawScaled, jpegWithin } from "@/lib/doc-scan/canvas";
import { MAX_SCAN_PAGE_BYTES } from "@/lib/doc-scan/upload";
import { scanGuide } from "@/lib/doc-scan/guide";
import CornerEditor from "./corner-editor";

/** 撮った1枚。original=写真タブへ回すときに使う元の写真/scanned=紙の形に直したもの。 */
export interface ScannedPage {
  id: string;
  original: Blob;
  scanned: Blob;
  thumbUrl: string;
}

interface Shot {
  canvas: HTMLCanvasElement;
  url: string;
  quad: Quad;
  /** 紙を自動で見つけられたか(見つからなければ画面の内側の枠から人が合わせる)。 */
  found: boolean;
}

/** 撮った写真の長い辺の上限(角を合わせる元になる)。 */
const SHOT_MAX_EDGE = 2600;
/** 写真タブへ回すときの長い辺(写真タブの上限 8MB に余裕で収まる)。 */
const ORIGINAL_MAX_EDGE = 2000;
/** 撮影中に枠を探す小さな画像の長い辺(軽く・速く)。 */
const PREVIEW_MAX_EDGE = 480;
/** 撮影中に枠を探す間隔。 */
const PREVIEW_INTERVAL_MS = 300;

type Phase = "camera" | "adjust" | "list" | "saving";

interface DocScanDialogProps {
  onClose: () => void;
  /** PDF にして添付に入れる。成功したら閉じる(結果の知らせは呼び出し側)。 */
  onSavePdf: (pages: readonly ScannedPage[]) => Promise<void>;
  /** 書類ではなかった=元の写真を写真タブへ入れる。 */
  onSavePhotos: (pages: readonly ScannedPage[]) => Promise<void>;
}

export default function DocScanDialog({ onClose, onSavePdf, onSavePhotos }: DocScanDialogProps) {
  const [phase, setPhase] = useState<Phase>("camera");
  const [pages, setPages] = useState<readonly ScannedPage[]>([]);
  const [shot, setShot] = useState<Shot | null>(null);
  const [finish, setFinish] = useState<ScanFinish>("clean");
  const [cv, setCv] = useState<CV | null>(null);
  const [cvFailed, setCvFailed] = useState(false);
  // getUserMedia が無い(古い端末・HTTP で開いた)ときは、はじめから OS のカメラで撮る形にする。
  const [cameraFailed, setCameraFailed] = useState(() => !navigator.mediaDevices?.getUserMedia);
  const [liveQuad, setLiveQuad] = useState<Quad | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pagesRef = useRef(pages);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  // 部品(OpenCV.js・約10MB)は、この画面を開いたときに読み込む。読めなくても撮影はでき、角は人が合わせる。
  useEffect(() => {
    let alive = true;
    loadOpenCv().then(
      (box) => alive && setCv(() => box.cv),
      () => alive && setCvFailed(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  // 閉じるときに、撮った一覧の下見用 URL を返す。
  useEffect(
    () => () => {
      for (const p of pagesRef.current) URL.revokeObjectURL(p.thumbUrl);
    },
    [],
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** 映像の枠が出たら、動いているカメラをつなぐ(角を直す画面から戻ったときも)。 */
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    // 映像が映るまで「撮る」を押せなくする(戻った直後に押して何も起きない、を防ぐ)。
    if (!el) setVideoReady(false);
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
  }, []);

  // カメラは「撮る」「紙の範囲」の間だけ動かす(撮り直しのたびに許可を聞き直させない)。撮った一覧では止める。
  const cameraWanted = (phase === "camera" || phase === "adjust") && !cameraFailed;
  useEffect(() => {
    if (!cameraWanted) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        attachVideo(videoRef.current);
      })
      .catch(() => {
        if (!cancelled) setCameraFailed(true);
      });
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraWanted, attachVideo, stopCamera]);

  // 撮影中は、少しずつ紙の枠を探して重ねて出す。
  useEffect(() => {
    if (phase !== "camera" || !cv) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      const small = drawScaled(video, video.videoWidth, video.videoHeight, PREVIEW_MAX_EDGE);
      try {
        const q = detectQuad(cv, small);
        setLiveQuad(q ? scaleQuad(q, video.videoWidth / small.width) : null);
      } catch {
        setLiveQuad(null);
      }
    }, PREVIEW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, cv]);

  /** 撮った写真(canvas)から紙の範囲の画面へ。 */
  const openAdjust = useCallback(
    async (canvas: HTMLCanvasElement) => {
      let quad: Quad | null = null;
      if (cv) {
        try {
          const small = drawScaled(canvas, canvas.width, canvas.height, 640);
          const q = detectQuad(cv, small);
          quad = q ? scaleQuad(q, canvas.width / small.width) : null;
        } catch {
          quad = null;
        }
      }
      const url = URL.createObjectURL(await canvasToJpeg(canvas, 0.9));
      setShot({ canvas, url, quad: quad ?? defaultQuad(canvas), found: quad !== null });
      setPhase("adjust");
    },
    [cv],
  );

  const handleShutter = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || busy) return;
    setBusy(true);
    try {
      await openAdjust(drawScaled(video, video.videoWidth, video.videoHeight, SHOT_MAX_EDGE));
    } finally {
      setBusy(false);
    }
  };

  /** カメラが使えない端末: OS のカメラで撮った1枚を読み込む(向きの記録どおりに起こす)。 */
  const handlePickedFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        await openAdjust(drawScaled(bitmap, bitmap.width, bitmap.height, SHOT_MAX_EDGE));
      } finally {
        bitmap.close();
      }
    } catch {
      setError("写真を読み込めませんでした。もう一度撮ってください");
    } finally {
      setBusy(false);
    }
  };

  const discardShot = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
  };

  const handleUseShot = async () => {
    if (!shot || busy) return;
    setBusy(true);
    try {
      const scannedCanvas = cv
        ? warpDocument(cv, shot.canvas, shot.quad, finish)
        : cropToQuadBounds(shot.canvas, shot.quad, ORIGINAL_MAX_EDGE);
      const [scanned, original] = await Promise.all([
        jpegWithin(scannedCanvas, MAX_SCAN_PAGE_BYTES),
        canvasToJpeg(drawScaled(shot.canvas, shot.canvas.width, shot.canvas.height, ORIGINAL_MAX_EDGE), 0.85),
      ]);
      const page: ScannedPage = { id: safeRandomId(), original, scanned, thumbUrl: URL.createObjectURL(scanned) };
      const next = addPage(pages, page);
      if (!next.ok) {
        URL.revokeObjectURL(page.thumbUrl);
        setError(`1回に${MAX_SCAN_PAGES}枚までです。いったん保存してから続けてください`);
        setPhase("list");
      } else {
        setPages(next.pages);
        setPhase(next.pages.length >= MAX_SCAN_PAGES ? "list" : "camera");
      }
      discardShot();
    } catch {
      setError("紙の形に直せませんでした。撮り直してください");
    } finally {
      setBusy(false);
    }
  };

  const handleRetake = () => {
    discardShot();
    setPhase("camera");
  };

  const handleRemove = (id: string) => {
    const target = pages.find((p) => p.id === id);
    if (target) URL.revokeObjectURL(target.thumbUrl);
    setPages(removePage(pages, id));
  };

  const runSave = async (save: (pages: readonly ScannedPage[]) => Promise<void>) => {
    if (pages.length === 0) return;
    setError(null);
    setPhase("saving");
    try {
      await save(pages);
      stopCamera();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setPhase("list");
    }
  };

  const handleQuit = () => {
    if (pages.length > 0 && !confirmQuit) {
      setConfirmQuit(true);
      return;
    }
    stopCamera();
    discardShot();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="書類を撮る"
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-50"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <span className="text-base font-bold">
          {phase === "adjust" ? `紙の範囲(${pages.length + 1}枚目)` : phase === "list" || phase === "saving" ? `撮った書類(${pages.length}枚)` : "書類を撮る"}
        </span>
        <button data-motion="off"
          type="button"
          onClick={handleQuit}
          disabled={phase === "saving"}
          className="flex h-11 items-center gap-1 rounded-lg border border-slate-600 px-3 text-sm disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          やめる
        </button>
      </div>

      {confirmQuit && (
        <div className="mx-4 mb-3 flex flex-col gap-2 rounded-lg border border-amber-400 bg-amber-950/60 p-3 text-sm">
          <span>撮った{pages.length}枚は保存されずに消えます。やめますか？</span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="flex-1 border border-slate-500 text-slate-50 hover:bg-slate-800" onClick={() => setConfirmQuit(false)}>
              続ける
            </Button>
            <Button type="button" variant="danger" className="flex-1" onClick={handleQuit}>
              やめる
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mx-4 mb-3 rounded-lg border border-red-400 bg-red-950/60 p-3 text-sm">
          {error}
        </div>
      )}

      {phase === "camera" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          {!cameraFailed ? (
            <div className="relative min-h-0 flex-1">
              <video
                ref={attachVideo}
                playsInline
                muted
                autoPlay
                aria-label="カメラの映像"
                className="h-full w-full object-contain"
                onPlaying={() => setVideoReady(true)}
                onLoadedMetadata={(e) =>
                  setVideoSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })
                }
              />
              {liveQuad && videoSize && (
                <svg
                  viewBox={`0 0 ${videoSize.width} ${videoSize.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden="true"
                >
                  <polygon
                    points={liveQuad.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="rgba(99,102,241,0.15)"
                    stroke="#818cf8"
                    strokeWidth={Math.max(videoSize.width, videoSize.height) * 0.006}
                  />
                </svg>
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-slate-300">
              <span>この画面ではカメラを開けませんでした。スマホのカメラで1枚ずつ撮ってください。</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  void handlePickedFile(file);
                }}
              />
              <Button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <Camera className="mr-2 h-5 w-5" aria-hidden="true" />
                カメラで撮る
              </Button>
            </div>
          )}
          <span className="text-xs text-slate-300">
            {cvFailed
              ? "紙を自動で見つける部品を読み込めませんでした。撮ったあとに角を指で合わせてください。"
              : !cv
                ? "紙を自動で見つける準備をしています…"
                : liveQuad
                  ? "紙を見つけました。撮ってください。"
                  : "紙の全体が入るように写してください。"}
          </span>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              className="h-12 flex-1 border border-slate-600 text-slate-50 hover:bg-slate-800"
              onClick={() => setPhase("list")}
              disabled={pages.length === 0}
            >
              撮り終わる({pages.length}枚)
            </Button>
            {!cameraFailed && (
              <button data-motion="off"
                type="button"
                onClick={() => void handleShutter()}
                disabled={busy || !videoReady}
                aria-label="撮る"
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-white bg-indigo-600 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /> : <Camera className="h-7 w-7" aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>
      )}

      {phase === "adjust" && shot && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <CornerEditor
            imageUrl={shot.url}
            width={shot.canvas.width}
            height={shot.canvas.height}
            quad={shot.quad}
            onChange={(quad) => setShot({ ...shot, quad })}
          />
          <span className="text-sm leading-relaxed text-slate-200">
            {scanGuide(shot.found, cv !== null, cvFailed)}
          </span>
          <div role="group" aria-label="仕上がり" className="flex gap-1 rounded-lg bg-slate-800 p-1">
            {(
              [
                ["clean", "読みやすく(白黒)"],
                ["color", "カラーのまま"],
              ] as const
            ).map(([value, label]) => (
              <button data-motion="off"
                key={value}
                type="button"
                aria-pressed={finish === value}
                onClick={() => setFinish(value)}
                className={`h-10 flex-1 rounded-md text-sm ${finish === value ? "bg-slate-50 font-bold text-slate-900" : "text-slate-300"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-auto flex gap-3">
            <Button type="button" variant="ghost" className="h-12 flex-1 border border-slate-600 text-slate-50 hover:bg-slate-800" onClick={handleRetake}>
              撮り直す
            </Button>
            <Button type="button" className="h-12 flex-[2] bg-indigo-600 hover:bg-indigo-700" onClick={() => void handleUseShot()} disabled={busy || (!cv && !cvFailed)}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {!cv && !cvFailed ? "準備中…" : "この範囲で使う"}
            </Button>
          </div>
        </div>
      )}

      {(phase === "list" || phase === "saving") && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          <ul className="grid grid-cols-3 gap-3">
            {pages.map((p, i) => (
              <li key={p.id} className="flex flex-col items-center gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- 端末の中だけの blob: の画像 */}
                <img src={p.thumbUrl} alt={`${i + 1}枚目`} className="h-auto w-full max-w-full rounded border border-slate-600 bg-white" />
                <span className="text-xs text-slate-300">{i + 1}枚目</span>
                <div className="flex gap-1">
                  <button type="button" data-motion="off" aria-label={`${i + 1}枚目を前へ`} disabled={i === 0 || phase === "saving"} onClick={() => setPages(movePage(pages, p.id, -1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-600 disabled:opacity-40">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" data-motion="off" aria-label={`${i + 1}枚目を消す`} disabled={phase === "saving"} onClick={() => handleRemove(p.id)} className="flex h-9 w-9 items-center justify-center rounded-md border border-red-400 text-red-300 disabled:opacity-40">
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button type="button" data-motion="off" aria-label={`${i + 1}枚目を後ろへ`} disabled={i === pages.length - 1 || phase === "saving"} onClick={() => setPages(movePage(pages, p.id, 1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-600 disabled:opacity-40">
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="ghost"
            className="h-12 border border-indigo-400 text-indigo-200 hover:bg-slate-800"
            onClick={() => setPhase("camera")}
            disabled={phase === "saving" || pages.length >= MAX_SCAN_PAGES}
          >
            続けて撮る
          </Button>
          <span className="text-xs leading-relaxed text-slate-300">
            1回に{MAX_SCAN_PAGES}枚まで。紙の形に直してから送ります。位置情報などの記録は送りません。
          </span>
          <div className="mt-auto flex flex-col gap-2">
            <Button
              type="button"
              className="h-14 bg-indigo-600 text-base font-bold hover:bg-indigo-700"
              onClick={() => void runSave(onSavePdf)}
              disabled={phase === "saving" || pages.length === 0}
            >
              {phase === "saving" && <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />}
              {phase === "saving" ? "PDFにして文字を読んでいます…" : "PDFにして添付に入れる"}
            </Button>
            <button data-motion="off"
              type="button"
              className="h-11 text-sm text-indigo-200 disabled:opacity-50"
              onClick={() => void runSave(onSavePhotos)}
              disabled={phase === "saving" || pages.length === 0}
            >
              書類ではない(現地の写真として写真タブへ)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
