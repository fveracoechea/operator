import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";

/**
 * The words one synthetic brief is written with and read back by.
 * The probe writes them and the launched agent answers them, so the only thing a probe proves
 * about an agent is what the agent itself reported through this one shape.
 */
const REPORT_SENTENCE = "Write your report as JSON to ";

export type ProbeStep = "loading" | "question" | "result" | "review" | "interruption";

export function briefFor(request: {
  probeId: string;
  step: ProbeStep;
  reportPath: string;
  instructions: string[];
}): string {
  return [
    `Operator live probe ${request.probeId}, step ${request.step}.`,
    "You are a synthetic Operative. Do no project work, and change no file outside this checkout.",
    ...request.instructions,
    `${REPORT_SENTENCE}${request.reportPath}`,
  ].join("\n");
}

const iso = z.iso.datetime();
const name = z.string().min(1);

const loadingReport = z.strictObject({
  step: z.literal("loading"),
  host: name,
  instructions: z.array(name).min(1),
  skills: z.array(name).min(1),
});

const questionReport = z.strictObject({
  step: z.literal("question"),
  questionId: name,
  acknowledgedAt: iso,
  answer: name,
});

const resultReport = z.strictObject({
  step: z.literal("result"),
  submissionId: name,
  artifacts: z.array(name).min(1),
});

const reviewReport = z.strictObject({
  step: z.literal("review"),
  host: name,
  // Both axes are reported by one reviewer, and neither is merged into the other.
  axes: z
    .array(
      z.strictObject({
        axis: z.enum(["standards", "spec"]),
        startedAt: iso,
        finishedAt: iso,
      }),
    )
    .length(2),
});

const interruptionReport = z.strictObject({
  step: z.literal("interruption"),
  wrote: name,
});

const reportSchemas = {
  loading: loadingReport,
  question: questionReport,
  result: resultReport,
  review: reviewReport,
  interruption: interruptionReport,
};

export type ReportOf<Step extends ProbeStep> = z.infer<(typeof reportSchemas)[Step]>;

export type ReadReport<Step extends ProbeStep> =
  | { status: "read"; report: ReportOf<Step>; identity: string; text: string }
  | { status: "unreadable"; detail: string };

function why(error: z.ZodError): string {
  return error.issues
    .map((issue) => [issue.path.join("."), issue.message].filter(Boolean).join(": "))
    .join("; ");
}

function readWith<Value>(
  schema: z.ZodType<Value>,
  value: unknown,
  text: string,
):
  | { status: "read"; report: Value; identity: string; text: string }
  | { status: "unreadable"; detail: string } {
  const result = schema.safeParse(value);
  return result.success
    ? { status: "read", report: result.data, identity: ContentIdentity.ofText(text), text }
    : { status: "unreadable", detail: why(result.error) };
}

/** One reader per step, so a step carries its own report type instead of every step's. */
const readers: { [Step in ProbeStep]: (value: unknown, text: string) => ReadReport<Step> } = {
  loading: (value, text) => readWith(loadingReport, value, text),
  question: (value, text) => readWith(questionReport, value, text),
  result: (value, text) => readWith(resultReport, value, text),
  review: (value, text) => readWith(reviewReport, value, text),
  interruption: (value, text) => readWith(interruptionReport, value, text),
};

/** Reads one agent report, refusing anything this release cannot trust as that step's answer. */
export function readReport<Step extends ProbeStep>(step: Step, text: string): ReadReport<Step> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { status: "unreadable", detail: `the report is not JSON: ${String(error)}` };
  }

  return readers[step](parsed, text);
}

/** True when the two axis reports overlapped in time, which is what parallel means here. */
export function ranInParallel(axes: ReportOf<"review">["axes"]): boolean {
  const [first, second] = axes;
  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    Date.parse(first.startedAt) < Date.parse(second.finishedAt) &&
    Date.parse(second.startedAt) < Date.parse(first.finishedAt)
  );
}
