/** The root and every process under it, read from `ps -A -o pid=,ppid=` output. */
export function descendants(root: number, ps: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of ps.split("\n")) {
    // ps pads both columns to the widest number, so a short ppid follows several spaces.
    // A blank line has no ppid, and no process has a NaN parent.
    const [pid = Number.NaN, ppid = Number.NaN] = line.trim().split(/\s+/).map(Number);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  function under(pid: number): number[] {
    return [pid, ...(children.get(pid) ?? []).flatMap(under)];
  }
  return under(root);
}
