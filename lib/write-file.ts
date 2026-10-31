// Bun has no atomic rename API.
import { open, rename, unlink } from "node:fs/promises";

/** Replaces the file in one rename, so a reader never sees a partial file. */
export async function writeFile(file: string, bytes: Uint8Array, mode = 0o600) {
  const temporary = `${file}.operator-${crypto.randomUUID()}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await Bun.write(Bun.file(handle.fd), bytes);
    await handle.sync();
    await rename(temporary, file);
  } finally {
    await handle.close();
    if (await Bun.file(temporary).exists()) await unlink(temporary);
  }
}
