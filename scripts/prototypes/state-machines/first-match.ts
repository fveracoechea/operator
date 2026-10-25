export type Rule<Input, Output> = {
  name: string;
  decide(input: Input): Output | undefined;
};

export function firstMatch<Input, Output>(
  rules: readonly Rule<Input, Output>[],
  input: Input,
  fallback: Output,
): Output {
  for (const rule of rules) {
    const result = rule.decide(input);
    if (result !== undefined) return result;
  }
  return fallback;
}
