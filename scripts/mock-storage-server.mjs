/**
 * Mock Storage Server for testing STORAGE_BACKEND=server
 *
 * Simulates the storage server API contract on port 4000.
 * Stores files in tmp/mock-storage/ directory.
 *
 * Usage:
 *   node scripts/mock-storage-server.mjs
 *
 * Endpoints:
 *   PUT  /upload          - Upload file (multipart/form-data)
 *   DELETE /delete        - Delete file
 *   GET  /url?key=&bucket= - Get file URL
 *   GET  /:bucket/:key    - Serve file
 */

import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.resolve(__dirname, "..", "tmp", "mock-storage");
const PORT = 4000;
const API_KEY = "test-api-key";

await fs.mkdir(STORAGE_DIR, { recursive: true });

/**
 * Simple multipart parser - extracts fields and file from multipart/form-data
 */
function parseMultipart(body, boundary) {
  const parts = {};
  const chunks = body.split(`--${boundary}`);

  for (const chunk of chunks) {
    if (chunk.trim() === '' || chunk.trim() === '--') continue;

    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = chunk.slice(0, headerEnd);
    const content = chunk.slice(headerEnd + 4).replace(/\r\n$/, '');

    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      parts[name] = { filename: filenameMatch[1], data: Buffer.from(content, 'binary') };
    } else {
      parts[name] = content.trim();
    }
  }

  return parts;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Auth check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}` && !url.pathname.match(/^\/property-management\//)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    // PUT /upload
    if (req.method === "PUT" && url.pathname === "/upload") {
      const contentType = req.headers["content-type"] || "";
      const boundary = contentType.split("boundary=")[1];

      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      const body = Buffer.concat(bodyChunks).toString('binary');

      const parts = parseMultipart(body, boundary);
      const key = parts.key || `unknown/${Date.now()}`;
      const bucket = parts.bucket || "default";
      const file = parts.file;

      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No file provided" }));
        return;
      }

      const filePath = path.join(STORAGE_DIR, bucket, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.data);

      const fileUrl = `http://localhost:${PORT}/${bucket}/${key}`;
      console.log(`  UPLOAD: ${key} (${file.data.length} bytes) -> ${fileUrl}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: fileUrl,
        key: key,
        size: file.data.length,
        contentType: "application/octet-stream",
      }));
      return;
    }

    // DELETE /delete
    if (req.method === "DELETE" && url.pathname === "/delete") {
      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      const { key, bucket } = JSON.parse(Buffer.concat(bodyChunks).toString());

      const filePath = path.join(STORAGE_DIR, bucket || "default", key);
      try {
        await fs.unlink(filePath);
        console.log(`  DELETE: ${key}`);
      } catch {
        // ignore
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }

    // GET /url
    if (req.method === "GET" && url.pathname === "/url") {
      const key = url.searchParams.get("key");
      const bucket = url.searchParams.get("bucket") || "default";
      const fileUrl = `http://localhost:${PORT}/${bucket}/${key}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: fileUrl }));
      return;
    }

    // GET /:bucket/:key - serve file
    if (req.method === "GET") {
      const filePath = path.join(STORAGE_DIR, url.pathname.slice(1));
      try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".png": "image/png", ".webp": "image/webp",
          ".pdf": "application/pdf",
        };
        res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
        res.end(data);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Mock storage server running on http://localhost:${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
  console.log(`API Key: ${API_KEY}`);
  console.log("");
  console.log("To use with the app:");
  console.log("  STORAGE_BACKEND=server");
  console.log("  STORAGE_SERVER_URL=http://localhost:4000");
  console.log("  STORAGE_SERVER_API_KEY=test-api-key");
});
