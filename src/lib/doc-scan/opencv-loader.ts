/**
 * 書類を撮る — OpenCV.js をその画面を開いたときだけ読み込む(ブラウザ専用)。
 * 部品はサーバーの /api/vendor/opencv から配る(画面のバンドルには入れない)。
 */

/** 部品の版。上げたら package.json の @techstark/opencv-js も同じ版に(URL の ?v= で古いものを使い回さない)。 */
export const OPENCV_VERSION = "4.12.0-release.1";
export const OPENCV_URL = `/api/vendor/opencv?v=${OPENCV_VERSION}`;

/** detect.ts が使う範囲だけの型(OpenCV.js の型定義は大きいので持ち込まない)。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

/**
 * ⚠OpenCV.js の本体(emscripten の Module)は `then` を持つ「Promise もどき」で、そのまま
 *   resolve に渡すと Promise が then を呼び続けて終わらない。必ず箱({ cv })に入れて返す。
 */
export interface OpenCvBox {
  cv: CV;
}

let loading: Promise<OpenCvBox> | null = null;

function whenReady(raw: unknown): Promise<OpenCvBox> {
  const m = raw as { Mat?: unknown; calledRun?: boolean; onRuntimeInitialized?: () => void } | undefined;
  if (!m) return Promise.reject(new Error("opencv-missing"));
  if (m.Mat && m.calledRun !== false) return Promise.resolve({ cv: m });
  return new Promise((resolve) => {
    const prev = m.onRuntimeInitialized;
    m.onRuntimeInitialized = () => {
      prev?.();
      resolve({ cv: m });
    };
  });
}

/** 一度だけ読み込む。失敗したら次に呼ばれたときにやり直す。 */
export function loadOpenCv(): Promise<OpenCvBox> {
  if (loading) return loading;
  loading = new Promise<OpenCvBox>((resolve, reject) => {
    const w = window as unknown as { cv?: unknown };
    if (w.cv) {
      whenReady(w.cv).then(resolve, reject);
      return;
    }
    const script = document.createElement("script");
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = () => whenReady(w.cv).then(resolve, reject);
    script.onerror = () => reject(new Error("opencv-load-failed"));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}
