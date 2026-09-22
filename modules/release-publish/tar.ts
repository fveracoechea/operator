const BLOCK = 512;
const encoder = new TextEncoder();

function writeText(header: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = encoder.encode(value);
  header.set(bytes.subarray(0, width - 1), offset);
}

function writeOctal(header: Uint8Array, offset: number, width: number, value: number): void {
  writeText(header, offset, width, value.toString(8).padStart(width - 1, "0"));
}

/**
 * Splits one path across the ustar name and prefix fields.
 * A name that fits neither is refused, because a truncated one would publish a file under a
 * name nobody asked for.
 */
function splitName(path: string): { name: string; prefix: string } {
  if (path.length <= 100) {
    return { name: path, prefix: "" };
  }

  for (let cut = path.length - 101; cut < path.length; cut += 1) {
    if (path[cut] === "/" && path.length - cut - 1 <= 100 && cut <= 155) {
      return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
    }
  }

  throw new Error(`the path ${path} is too long for a tar entry`);
}

function header(request: { path: string; size: number; mode: number; mtime: number }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(request.path);

  writeText(block, 0, 100, name);
  writeOctal(block, 100, 8, request.mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, request.size);
  writeOctal(block, 136, 12, request.mtime);
  block.fill(0x20, 148, 156);
  block[156] = 0x30;
  writeText(block, 257, 6, "ustar");
  block[263] = 0x30;
  block[264] = 0x30;
  writeText(block, 329, 8, "0000000");
  writeText(block, 337, 8, "0000000");
  writeText(block, 345, 155, prefix);

  const checksum = block.reduce((total, byte) => total + byte, 0);
  writeOctal(block, 148, 7, checksum);
  block[154] = 0;
  block[155] = 0x20;

  return block;
}

export type TarEntry = { path: string; bytes: Uint8Array<ArrayBuffer>; executable?: boolean };

/**
 * Writes one gzipped tar of the exact bytes given, with no link and no directory entry.
 * The timestamps are fixed, so the same artifact always packs to the same bytes and a retry
 * sends what the approval was granted against.
 */
export function packTarball(
  entries: TarEntry[],
  options: { mtime?: number } = {},
): Uint8Array<ArrayBuffer> {
  const mtime = options.mtime ?? 0;
  const blocks: Uint8Array[] = [];

  // The order is by code point, the same order the artifact identity is taken in, so the bytes
  // do not depend on the locale the release job happens to run under.
  for (const entry of entries.toSorted((left, right) => (left.path < right.path ? -1 : 1))) {
    blocks.push(
      header({
        path: entry.path,
        size: entry.bytes.length,
        mode: entry.executable === true ? 0o755 : 0o644,
        mtime,
      }),
    );
    blocks.push(entry.bytes);
    const padding = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }

  // Two empty blocks end the archive, and the reader stops there.
  blocks.push(new Uint8Array(BLOCK * 2));

  const total = blocks.reduce((size, block) => size + block.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }

  // The copy gives the bytes a buffer of their own, so a caller may hand them to a request body.
  return new Uint8Array(Bun.gzipSync(tar));
}
