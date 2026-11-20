const started = performance.now();

export function continuationProgress(phase: "start" | "complete", name: string) {
  const label = name.replaceAll(/[\r\n]/g, " ").slice(0, 256);
  console.error(
    `[continuation] ${new Date().toISOString()} +${(performance.now() - started).toFixed(1)}ms ${phase} ${label}`,
  );
}
