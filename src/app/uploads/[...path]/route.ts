import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await params;
  if (!parts || parts.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  const rel = parts.join("/");
  const target = path.normalize(path.join(UPLOAD_ROOT, rel));

  // パストラバーサル防御: 解決後パスが UPLOAD_ROOT 配下に収まっていること
  if (!target.startsWith(UPLOAD_ROOT + path.sep) && target !== UPLOAD_ROOT) {
    return new Response("Forbidden", { status: 403 });
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not Found", { status: 404 });
  }

  const buf = await fs.readFile(target);
  const ext = path.extname(target).toLowerCase();
  const ct = MIME[ext] ?? "application/octet-stream";

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
