type Values = {
  assignment: boolean | undefined;
  plan: boolean | undefined;
  device: boolean | undefined;
};

/** The most specific value wins, and internal review is on when no level sets it. ADR-0020. */
export function internalReview(values: Values) {
  return values.assignment ?? values.plan ?? values.device ?? true;
}
