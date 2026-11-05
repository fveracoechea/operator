// A worker reaches its SuperAgent only through recorded state, so worker text never names a
// message to it or Herdr as its channel. ADR-0022.
const patterns = [
  /\b(tell|message|notify|inform|ping)\s+(your|the|its)\s+(supervising\s+)?superagent\b/i,
  /\bsuperagent\b[^.]*\b(through|via|over|in)\s+herdr\b/i,
];

/** Each line, numbered from 1, of a worker instruction that tells the worker to message its SuperAgent. */
export function superAgentMessages(text: string) {
  return text
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => patterns.some((pattern) => pattern.test(text)));
}
