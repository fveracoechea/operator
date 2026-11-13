/** End a custom lint message with the repository documentation that explains its fix. */
export function withSkillTopic(message: string, topic: string): string {
  return `${message} See docs/agents/${topic.replace(/^unit-testing\//, "testing/")}.`;
}
