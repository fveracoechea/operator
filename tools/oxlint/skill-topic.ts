/** End a custom lint message with the skill topic that explains its fix. */
export function withSkillTopic(message: string, topic: string): string {
  return `${message} See ${topic}.`;
}
