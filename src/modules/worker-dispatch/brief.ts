import type { WorkSources } from "../work-sources/main.ts";
import type { Adoption } from "./adoption.ts";
import type { WorkerKinds } from "../worker-kinds/main.ts";

type Finding = { axis: string; severity: string; location: string; claim: string };

type BriefInput = {
  sourceId: string;
  sourceTrackerKey: string;
  assignment: string;
  trackerKey: string;
  completion: "pr" | "report";
  kind?: ReturnType<typeof WorkerKinds.resolve> | null;
  phase?: string;
  head?: string | null;
  note?: string | null;
  events?: string[];
  questions?: { key: string; question: string; answer: string; by: "person" | "super-agent" }[];
  profile: string | null;
  instructions: string;
  intent: string | null;
  workingDirectory: string;
  branch: string | null;
  reports: { directory: string; files: string[] };
  followUps: { directory: string; files: string[] };
  pullRequest: { number: number; url: string; readiness?: { head: string | null } | null } | null;
  dependencyReports: ReturnType<typeof WorkSources.dependencyReports>;
  stack: { assignment: string; number: number; branch: string } | null;
  internalReview: boolean;
  review: {
    state: "reviewing" | "ready" | "skipped";
    rounds: { number: number; head: string; findings: (Finding & { disposition?: string })[] }[];
    readyHead: string | null;
    comment?: string | null;
  } | null;
  promotion: { report: string; number: number } | null;
  adoption: Adoption | null;
};

/** Quoted record prose cannot introduce template sections. */
function quote(text: string) {
  return text
    .split(/\r\n?|\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function section(title: string, body: string) {
  return `## ${title}\n\n${body}`;
}

function headerFacts(input: BriefInput) {
  const kind = input.kind ?? null;
  const header = [
    "# Assignment brief",
    "",
    `- Source: \`${input.sourceId}\`, tracker \`${input.sourceTrackerKey}\`.`,
    `- Assignment: \`${input.assignment}\`, tracker \`${input.trackerKey}\`.`,
    `- Completion: \`${input.completion}\`.`,
  ];
  if (kind !== null) header.push(`- Worker kind: \`${kind.name}\`.`, `- Guide: \`${kind.guide}\`.`);
  for (const file of kind === null ? [] : kind.skillsToRead)
    header.push(`- Skill: \`${file}\`. Read when the guide calls for it and the file exists.`);
  header.push(
    `- Phase: \`${input.phase ?? "unrecorded"}\`.`,
    `- Resources: \`${input.branch === null ? "pane" : "worktree"}\`, \`${input.workingDirectory}\`. ${input.branch === null ? "Read-only; change no project files." : "Change project files only in this worktree."}`,
    `- Base: \`${input.stack?.branch ?? "default branch"}\`.`,
    `- Start profile: \`${input.profile ?? "device default"}\`.`,
    `- Device files: \`${input.reports.directory}\`, \`${input.followUps.directory}\`.`,
  );
  if (input.branch !== null) header.push(`- Branch: \`${input.branch}\`.`);
  if (input.completion === "pr")
    header.push(`- Internal review: \`${input.internalReview ? "on" : "off"}\`.`);
  return header.join("\n");
}

function reviewFacts(review: NonNullable<BriefInput["review"]>) {
  const facts = [`Review: \`${review.state}\`.`];
  if (review.readyHead !== null) facts.push(`Ready head: \`${review.readyHead}\`.`);
  const comment = review.comment ?? null;
  if (comment !== null) facts.push(`Summary: ${comment}`);
  if (review.state === "skipped")
    facts.push("Internal review was skipped on the person's instruction.");
  for (const round of review.rounds) {
    facts.push(`\n### Round ${round.number} at \`${round.head}\`\n`);
    for (const finding of round.findings) {
      facts.push(
        `- ${finding.axis}, ${finding.severity}, \`${finding.location}\`:\n${quote(finding.claim)}`,
      );
      if (finding.disposition !== undefined)
        facts.push(`Disposition:\n${quote(finding.disposition)}`);
    }
  }
  return facts;
}

function handoff(input: BriefInput) {
  const head = input.head ?? null;
  const pr = input.pullRequest ?? input.adoption;
  if (pr !== null || input.review !== null) {
    const facts: string[] = [];
    if (pr !== null) facts.push(`PR #${pr.number}: ${pr.url}`);
    if (head !== null) facts.push(`Head: \`${head}\`.`);
    if (
      input.review === null &&
      input.pullRequest?.readiness !== undefined &&
      input.pullRequest.readiness !== null
    )
      facts.push(
        input.pullRequest.readiness.head === null
          ? "Ready head: unknown (release migration)."
          : `Ready head: \`${input.pullRequest.readiness.head}\`.`,
      );
    if (input.review !== null) facts.push(...reviewFacts(input.review));
    return section("Handoff", facts.join("\n"));
  }
  return "";
}

function history(input: BriefInput) {
  const sections: string[] = [];
  if (input.dependencyReports.length > 0)
    sections.push(
      section(
        "Accepted dependency reports",
        input.dependencyReports
          .map((row) => {
            const facts = [
              `### \`${row.assignment}\` report ${row.report}`,
              `Reference: \`${row.reference}\``,
              quote(row.conclusion),
            ];
            if (row.unresolved.length > 0)
              facts.push(`Unresolved points:\n\n${row.unresolved.map(quote).join("\n\n")}`);
            if (row.files.length > 0)
              facts.push(
                `Supporting files:\n\n${row.files.map((file) => `- \`${file}\``).join("\n")}`,
              );
            return facts.join("\n\n");
          })
          .join("\n\n"),
      ),
    );
  if (input.promotion !== null)
    sections.push(
      section(
        "Promotion",
        `Report ${input.promotion.number} of \`${input.promotion.report}\`. The reused worktree can hold prototype changes; clean the branch before its first push.`,
      ),
    );
  if (input.stack !== null)
    sections.push(
      section(
        "Stack",
        `Parent: \`${input.stack.assignment}\`, PR #${input.stack.number}, branch \`${input.stack.branch}\`. The relay owns base changes; preserve unlanded work.`,
      ),
    );
  if (input.adoption !== null)
    sections.push(
      section(
        "Adopted PR",
        `PR #${input.adoption.number}: ${input.adoption.url}\nBranch: \`${input.adoption.branch}\`. State: \`${input.adoption.draft ? "draft" : "ready"}\`.\nRead reviews, comments, unresolved threads, and checks before changing code or waiting. Keep existing commits; open no second PR.`,
      ),
    );
  if (input.questions !== undefined && input.questions.length > 0)
    sections.push(
      section(
        "Questions answered for this assignment",
        input.questions
          .map(
            (row) =>
              `### \`${row.key}\`\n\nBy: \`${row.by}\`\n\n${quote(row.question)}\n\nAnswer:\n\n${quote(row.answer)}`,
          )
          .join("\n\n"),
      ),
    );
  if (input.reports.files.length > 0)
    sections.push(
      section(
        "Earlier reports",
        input.reports.files.map((file) => `- \`${input.reports.directory}/${file}\``).join("\n"),
      ),
    );
  if (input.followUps.files.length > 0)
    sections.push(
      section(
        "Follow-up instructions",
        input.followUps.files
          .map((file) => `- \`${input.followUps.directory}/${file}\``)
          .join("\n"),
      ),
    );
  return sections;
}

/** Facts and kind data select sections; the guide owns the worker's procedure. */
export function renderBrief(input: BriefInput) {
  const sections = [headerFacts(input), section("Task", input.instructions)];
  if (input.intent !== null) sections.push(section("Acceptance criteria", quote(input.intent)));
  sections.push(handoff(input));
  const note = input.note ?? null;
  if (
    note !== null &&
    (input.kind?.readsNote === true ||
      (input.kind?.readsNote === "promotion" && input.promotion !== null))
  )
    sections.push(section("Note", quote(note)));
  if (input.events !== undefined && input.events.length > 0)
    sections.push(section("Events", input.events.map(quote).join("\n\n")));
  sections.push(...history(input));
  return `${sections.filter((text) => text !== "").join("\n\n")}\n`;
}
