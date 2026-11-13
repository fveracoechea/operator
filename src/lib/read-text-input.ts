/** A dash selects stdin; every other value names a UTF-8 file. */
export function readTextInput(file: string) {
  return (file === "-" ? Bun.stdin : Bun.file(file)).text();
}
