/**
 * Builds a zip without compression (most files people sync are already
 * compressed) and without workers, so the CSP stays strict. Loaded on demand.
 */
import { Zip, ZipPassThrough } from "fflate";

export interface ZipInput {
  name: string;
  read: () => Promise<Uint8Array>;
}

export async function zip(files: ZipInput[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let error: Error | null = null;
  const z = new Zip((err, chunk) => {
    if (err) error = err;
    else parts.push(chunk);
  });
  for (const f of files) {
    const entry = new ZipPassThrough(f.name);
    z.add(entry);
    entry.push(await f.read(), true);
    if (error) throw error;
  }
  z.end();
  if (error) throw error;
  return new Blob(parts as BlobPart[], { type: "application/zip" });
}
