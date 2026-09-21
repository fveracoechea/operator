export async function readTextOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function endsWithNewline(text: string): boolean {
  return text.length === 0 || text.endsWith("\n");
}
