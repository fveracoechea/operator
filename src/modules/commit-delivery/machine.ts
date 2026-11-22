type Round = { head: string; findings: { severity: string }[] };
type Disposition = { round: number; finding: number; disposition: string; reason?: string };

/** Applied blockers need a later clean review, including at the two-round boundary. */
export function reviewGate(rounds: Round[], dispositions: Disposition[], candidate: string) {
  const latest = rounds.at(-1);
  if (latest === undefined) return "review_missing";
  const expected = rounds.flatMap((round, index) =>
    round.findings.map((finding, findingIndex) => ({
      round: index + 1,
      finding: findingIndex + 1,
      severity: finding.severity,
    })),
  );
  const byKey = new Map(
    dispositions.map((row) => [`${row.round}.${row.finding}`, row.disposition]),
  );
  if (
    dispositions.length !== expected.length ||
    expected.some((row) => !byKey.has(`${row.round}.${row.finding}`))
  )
    return "dispositions_incomplete";
  const blocker = latest.findings.some(
    (finding, index) =>
      finding.severity === "blocker" && byKey.get(`${rounds.length}.${index + 1}`) === "applied",
  );
  if (blocker) return rounds.length === 2 ? "review_limit" : "blocker_requires_review";
  return latest.head === candidate ? null : "candidate_changed";
}
