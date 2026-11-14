import type { OkOf } from "unthrown";
import type { NextStep } from "../../lib/cli-result.ts";
import type { WorkSources } from "../work-sources/main.ts";

type SourceRows = OkOf<Awaited<ReturnType<typeof WorkSources.next>>>["sources"][number];
type NextRow = SourceRows["actions"][number] | SourceRows["waits"][number];

/** The row and its next step share one command, so they cannot disagree. */
export function withNext<T extends NextRow>(sourceId: string, row: T) {
  const next = rowNext(sourceId, row);
  const described: T & { next: NextStep; command?: string } = { ...row, next };
  if (next.command !== undefined) described.command = next.command;
  return described;
}

/** Leave simple identifiers readable; quote all other shell arguments without changing their bytes. */
function argument(value: string) {
  return /^[a-zA-Z0-9_:/.-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function rowNext(sourceId: string, row: NextRow): NextStep {
  const source = `--source ${argument(sourceId)}`;
  const target =
    "assignment" in row ? `${source} --assignment ${argument(row.assignment)}` : source;
  if (row.action === "answer_question")
    return { decider: "super-agent", question: row.question.question };
  if (row.action === "read_reply")
    return {
      command: `operator message close ${target} --key ${argument(row.message.key)}`,
      why: "Read the recorded reply and act on it before closing the message.",
    };
  const steering: NextStep = {
    decider: "super-agent",
    question: `What steering does the worker need for ${row.reason}?`,
  };
  const steps: Record<typeof row.action, NextStep> = {
    ready_assignment: {
      command: `operator dispatch ${target}`,
      why: "The assignment is ready to start.",
    },
    replace_worker: {
      command: `operator dispatch ${target}`,
      why: "Replace the stopped worker without deleting its work.",
    },
    retry_handoff: {
      command: `operator handoff ${target}`,
      why: "Resume the internal review handoff.",
    },
    retry_cleanup: {
      command:
        "report" in row && row.report !== undefined
          ? `operator report accept ${target}`
          : `operator cleanup ${target}`,
      why: "Continue the recorded cleanup.",
    },
    review_report: {
      decider: "super-agent",
      question: "Does the submitted report meet the assignment, or does it need follow-up?",
    },
    person_decision: {
      decider: "person",
      question:
        "question" in row ? row.question.question : "May the retained work or resource be removed?",
    },
    worker_attention: steering,
    owner_attention: steering,
    resume_worker: steering,
    prune_source: {
      command: "operator source prune",
      why: "The source retention period has elapsed.",
    },
    source_ended: { why: "No assignment work remains." },
    ended: { why: "No assignment work remains." },
    wait: {
      command: `operator next ${source} --wait`,
      why: "Wait for the recorded blockers to change.",
    },
  };
  return steps[row.action];
}
