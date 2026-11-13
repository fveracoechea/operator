import type { NextStep } from "../../lib/cli-result.ts";

type NextRow = {
  action: string;
  reason?: string;
  assignment?: string;
  question?: { key: string; question?: string };
  message?: { key: string };
  report?: object;
};

/** The row and its next step share one command, so they cannot disagree. */
export function withNext<T extends NextRow>(sourceId: string, row: T) {
  const next = rowNext(sourceId, row);
  const described: T & { next: NextStep; command?: string } = { ...row, next };
  if (next.command !== undefined) described.command = next.command;
  return described;
}

function rowNext(sourceId: string, row: NextRow): NextStep {
  const source = `--source ${sourceId}`;
  const target = `${source} --assignment ${row.assignment}`;
  const steps: Record<string, NextStep> = {
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
        row.report === undefined
          ? `operator cleanup ${target}`
          : `operator report accept ${target}`,
      why: "Continue the recorded cleanup.",
    },
    review_report: {
      decider: "super-agent",
      question: "Does the submitted report meet the assignment, or does it need follow-up?",
    },
    answer_question: {
      decider: "super-agent",
      question: row.question?.question ?? "How should the worker proceed?",
    },
    person_decision: {
      decider: "person",
      question: row.question?.question ?? "May the retained work or resource be removed?",
    },
    read_reply: {
      command: `operator message close ${target} --key ${row.message?.key}`,
      why: "Read the recorded reply and act on it before closing the message.",
    },
    prune_source: {
      command: `operator source prune ${source}`,
      why: "The source retention period has elapsed.",
    },
    source_ended: { why: "No assignment work remains." },
    ended: { why: "No assignment work remains." },
    wait: {
      command: `operator next ${source} --wait`,
      why: "Wait for the recorded blockers to change.",
    },
  };
  return (
    steps[row.action] ?? {
      decider: "super-agent",
      question: `What steering does the worker need for ${row.reason}?`,
    }
  );
}
