// Bun has no recursive directory removal API or path manipulation API.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

type Violation = {
  name: string;
  files: Record<string, string>;
  cleanupPath: string;
  expectedDiagnostic: string;
};

async function runBoundaryCheck(): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const child = Bun.spawn(["bun", "run", "lint:modules"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function report(result: { stderr: string; stdout: string }): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

async function requireCleanGraph(message: string): Promise<void> {
  const result = await runBoundaryCheck();
  if (result.exitCode !== 0) {
    report(result);
    throw new Error(message);
  }
}

async function proveViolation(violation: Violation): Promise<void> {
  try {
    for (const [path, content] of Object.entries(violation.files)) {
      await Bun.write(resolve(path), content, { createPath: true });
    }

    const result = await runBoundaryCheck();
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode === 0 || !diagnostics.includes(violation.expectedDiagnostic)) {
      report(result);
      throw new Error(`${violation.name} was not rejected`);
    }
  } finally {
    await rm(resolve(violation.cleanupPath), { force: true, recursive: true });
  }
}

await requireCleanGraph("The clean module graph did not pass");

const violations: Violation[] = [
  {
    name: "private module import",
    files: {
      "module-boundary.probe.ts": 'require("./modules/operator-cli/run.ts");\n',
    },
    cleanupPath: "module-boundary.probe.ts",
    expectedDiagnostic: "imports private module file",
  },
  {
    name: "missing module interface",
    files: {
      "modules/missing-interface/private.ts": "export {};\n",
    },
    cleanupPath: "modules/missing-interface",
    expectedDiagnostic: "every module requires one public interface",
  },
  {
    name: "data-only module interface",
    files: {
      "modules/data-interface/main.ts": "export const DataInterface = { value: true };\n",
    },
    cleanupPath: "modules/data-interface",
    expectedDiagnostic: "properties are action methods",
  },
  {
    name: "flat production module file",
    files: {
      "modules/flat.probe.ts": "export {};\n",
    },
    cleanupPath: "modules/flat.probe.ts",
    expectedDiagnostic: "production files must be inside a feature module",
  },
  {
    name: "production code outside modules",
    files: {
      "services/outside.probe.ts": "export {};\n",
    },
    cleanupPath: "services",
    expectedDiagnostic: "production TypeScript must live",
  },
  {
    name: "module dependency cycle",
    files: {
      "modules/cycle-probe/main.ts":
        'import "./worker.ts";\nexport const CycleProbe = { run() {} };\n',
      "modules/cycle-probe/worker.ts": 'import "./main.ts";\n',
    },
    cleanupPath: "modules/cycle-probe",
    expectedDiagnostic: "no-module-cycles",
  },
];

for (const violation of violations) {
  await proveViolation(violation);
}

await requireCleanGraph("The restored module graph did not pass");
console.log(
  `module boundaries: clean -> rejected ${violations.length} deliberate violations -> clean`,
);
