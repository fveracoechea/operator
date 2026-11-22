type Round = { head?: string; findings: { severity: string }[] };
type Disposition = { round: number; finding: number; disposition: string; reason?: string };

/** One mandatory review policy serves delivery, stored evidence and next actions. */
export const CommitReview = {
  decide(rounds: Round[], dispositions: Disposition[], candidate?: string | null) {
    const latest = rounds.at(-1);
    if (latest === undefined) return "review_missing";
    const expected = rounds.flatMap((round, index) =>
      round.findings.map((_, findingIndex) => `${index + 1}.${findingIndex + 1}`),
    );
    const byKey = new Map(
      dispositions.map((row) => [`${row.round}.${row.finding}`, row.disposition]),
    );
    if (
      dispositions.length !== expected.length ||
      expected.some((key) => !byKey.has(key)) ||
      dispositions.some((row) => row.disposition === "declined" && !row.reason?.trim())
    )
      return "dispositions_incomplete";
    const blocker = latest.findings.some(
      (finding, index) =>
        finding.severity === "blocker" && byKey.get(`${rounds.length}.${index + 1}`) === "applied",
    );
    if (blocker) return rounds.length === 2 ? "review_limit" : "blocker_requires_review";
    return candidate !== undefined && latest.head !== candidate ? "candidate_changed" : null;
  },
};
