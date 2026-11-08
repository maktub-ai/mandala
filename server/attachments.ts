import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { DomainError } from "../shared/workspace-contracts";
import { mkdir, readFile, writeFile, open, realpath, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import type { Attachment, NativeAttachment } from "../shared/chat-input";
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export async function saveAttachment(home: string, conversationId: string, name: string, data: Buffer): Promise<Attachment> {
  if (!name || name.length > 255 || /[/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new Error("invalid attachment name");
  if (!data.length || data.length > MAX_ATTACHMENT_SIZE) throw new Error("Attachment must be between 1 byte and 20 MB");
  // Derive image types from their bytes; arbitrary uploads remain ordinary files.
  const imageType = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" :
    data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg" :
    ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString()) ? "image/gif" :
    data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
  const item: Attachment = { id: randomUUID(), name, size: data.length, mimeType: imageType ?? "application/octet-stream" };
  const root = join(home, "attachments", conversationId, item.id);
  await mkdir(join(root, "files"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "files", name), data, { mode: 0o600 });
  await writeFile(join(root, "metadata.json"), JSON.stringify(item), { mode: 0o600 });
  return item;
}
export async function loadAttachments(home: string, conversationId: string, ids: unknown): Promise<NativeAttachment[]> {
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid attachment references");
  return Promise.all(ids.map(async id => {
    const root = join(home, "attachments", conversationId, id);
    const item: Attachment = await readFile(join(root, "metadata.json"), "utf8").then(JSON.parse).catch(() => { throw new Error("invalid attachment references"); });
    return { ...item, path: join(root, "files", item.name) };
  }));
}
export function attachmentText(text: string, attachments: NativeAttachment[]) {
  return attachments.length ? [text, "User-provided attachments (reference data):", JSON.stringify(attachments.map(({ name, path }) => ({ name, path })))].filter(Boolean).join("\n\n") : text;
}

export async function readAttachmentBytes(home:string,item:NativeAttachment) {
  const base=resolve(home,'attachments'),root=await realpath(base);
  const expected=resolve(root,relative(base,item.path));
  const path=await realpath(item.path);
  if(!expected.startsWith(root+sep)||path!==expected)throw new DomainError('attachment_scope',403,'Attachment is outside this chat');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.size>MAX_ATTACHMENT_SIZE)throw new DomainError('attachment_size',413,'Attachment is unavailable or too large');
    const data=Buffer.alloc(before.size+1);let size=0;
    while(size<data.length){const {bytesRead}=await handle.read(data,size,data.length-size,size);if(!bytesRead)break;size+=bytesRead;}
    const after=await handle.stat(),currentPath=await realpath(item.path),current=await stat(currentPath);
    if(currentPath!==path||current.dev!==before.dev||current.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||size!==before.size)
      throw new DomainError('attachment_changed',409,'Attachment changed while loading; open it again');
    return data.subarray(0,size);
  } finally {await handle.close();}
}
