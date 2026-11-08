import type { IncomingMessage } from 'node:http';

export async function readJsonBody(req: IncomingMessage, options: {
  maxBytes: number;
  contentTypeError: string;
  sizeError: string;
  jsonError?: string;
}): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error(options.contentTypeError);
  const chunks: Buffer[] = [];
  let size = 0;
  // Returning early must leave the response socket available for the caller's error.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > options.maxBytes) {
      req.resume();
      throw new Error(options.sizeError);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}');
  } catch (error) {
    if (options.jsonError) throw new Error(options.jsonError);
    throw error;
  }
}
