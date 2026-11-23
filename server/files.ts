// Files and pictures attached to chat messages.
//
// Upload: POST /api/uploads with the raw bytes as the body, the file name in X-File-Name (URI-encoded)
// and its type in Content-Type. Download: GET /api/files/:id. Ids are long and random, so a file is
// reachable only by someone who has seen the message (an <img> cannot send the login header).
// Only pictures and PDFs are shown in the browser; everything else is downloaded, never rendered,
// so an uploaded HTML or SVG file cannot run as part of this site.

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { join } from "node:path";
import type { Attachment } from "../agents/protocol";
import { HttpError } from "./auth";
import { store } from "./store";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PER_MESSAGE = 6;
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

export async function uploadFile(name: string, req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BYTES) throw new HttpError(413, "Files can be up to 8 MB.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new HttpError(400, "The file is empty.");
  let fileName = "file";
  try {
    fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
  } catch {
    // keep the default
  }
  fileName = fileName.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 120) || "file";
  const type = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  const id = randomBytes(18).toString("hex");
  writeFileSync(join(store.uploadsDir, id), Buffer.concat(chunks));
  store.db.files[id] = { id, name: fileName, type, size, uploadedBy: name, createdAt: new Date().toISOString() };
  store.save();
  return toAttachment(id);
}

export function serveFile(id: string, res: http.ServerResponse) {
  const record = /^[a-f0-9]{36}$/.test(id) ? store.db.files[id] : undefined;
  const path = record ? join(store.uploadsDir, id) : "";
  if (!record || !existsSync(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  const inline = INLINE.has(record.type);
  res.writeHead(200, {
    "Content-Type": inline ? record.type : "application/octet-stream",
    "Content-Length": String(record.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=86400",
  });
  createReadStream(path).pipe(res);
}

function toAttachment(id: string): Attachment {
  const record = store.db.files[id];
  return { id, name: record.name, type: record.type, size: record.size, url: `/api/files/${id}` };
}

/** Attachments sent with a message: ids of files this member uploaded. */
export function readAttachments(name: string, value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length > MAX_PER_MESSAGE) throw new HttpError(400, `Attach up to ${MAX_PER_MESSAGE} files at a time.`);
  return value.map((raw) => {
    const id = typeof raw === "string" ? raw : typeof raw === "object" && raw ? String((raw as { id?: unknown }).id) : "";
    const record = store.db.files[id];
    if (!record || record.uploadedBy !== name) throw new HttpError(400, "That attachment was not found. Upload it again.");
    return toAttachment(id);
  });
}
