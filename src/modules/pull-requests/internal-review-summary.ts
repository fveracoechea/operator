import { Err, Ok, fromPromise } from "unthrown";
import { z } from "zod";
import { qualify } from "./owner.ts";

const place = { round: z.number().int().positive(), finding: z.number().int().positive() };
const dispositionSchema = z.discriminatedUnion("disposition", [
  z.strictObject({ ...place, disposition: z.literal("applied") }),
  z.strictObject({
    ...place,
    disposition: z.literal("declined"),
    reason: z.string().trim().min(1),
  }),
]);
export type Disposition = z.infer<typeof dispositionSchema>;

function parseDisposition(line: string) {
  const match = /^- ([1-9]\d*)\.([1-9]\d*) (applied|declined: (.+))$/.exec(line);
  if (match === null) return null;
  const place = { round: Number(match[1]), finding: Number(match[2]) };
  const value =
    match[3] === "applied"
      ? { ...place, disposition: "applied" }
      : { ...place, disposition: "declined", reason: match[4] };
  const parsed = dispositionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The ready summary must identify a disposition for each recorded finding. */
function parseSummary(text: string) {
  function invalid(line: number) {
    return Err({
      reason: "internal_review_summary_invalid",
      detail: `Line ${line}: expected ## Overview with prose, then ## Dispositions with bullets '- <round>.<finding> applied' or '- <round>.<finding> declined: <reason>'. Nothing was changed.`,
      next: {
        command: "operator pr ready --file <path|->",
        why: "Correct the markdown summary and try ready again.",
      },
    });
  }
  let section: "" | "overview" | "dispositions" = "";
  const overview: string[] = [];
  const dispositions: Disposition[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") {
      overview.push("");
      continue;
    }
    if (section === "") {
      if (line !== "## Overview") return invalid(index + 1);
      section = "overview";
    } else if (section === "overview" && line === "## Dispositions") {
      if (overview.every((line) => line === "")) return invalid(index + 1);
      section = "dispositions";
    } else if (section === "overview" && !line.startsWith("#")) {
      overview.push(raw);
    } else {
      const parsed = parseDisposition(line);
      if (parsed === null) return invalid(index + 1);
      dispositions.push(parsed);
    }
  }
  return section === "dispositions"
    ? Ok({ overview: overview.join("\n").trim(), dispositions })
    : invalid(1);
}

export function readSummary(file: string) {
  return fromPromise(
    () => (file === "-" ? Bun.stdin.text() : Bun.file(file).text()),
    qualify,
  ).flatMap((text) => parseSummary(text).toAsync());
}
