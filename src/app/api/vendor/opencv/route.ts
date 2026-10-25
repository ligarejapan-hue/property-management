import { readFile } from "node:fs/promises";
import path from "node:path";

// ---------- GET /api/vendor/opencv ----------
// 書類を撮る(第3段)で紙の四隅を見つける OpenCV.js(@techstark/opencv-js・Apache-2.0・約10MB)を配る。
// ⚠画面のバンドルに入れない(10MB を build に通すと重い・その画面を開いた人だけが読めばよい)。
//   スマホが一度読めば、版の付いた URL(?v=)のまま長く使い回す。
// ⚠ログインしている人だけ(proxy を通る)。中身は公開の部品で、個人情報は無い。


let cached: Buffer | null = null;

export async function GET() {
  try {
    cached ??= await readFile(path.join(process.cwd(), "node_modules", "@techstark", "opencv-js", "dist", "opencv.js"));
  } catch {
    return new Response("not available", { status: 503 });
  }
  return new Response(new Uint8Array(cached), {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
