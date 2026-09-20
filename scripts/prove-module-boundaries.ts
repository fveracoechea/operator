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

const probeIdentity = crypto.randomUUID();
const violations: Violation[] = [
  {
    name: "private module import",
    files: {
      [`module-boundary-probe-${probeIdentity}.test.ts`]:
        'require("./modules/operator-cli/run.ts");\n',
    },
    cleanupPath: `module-boundary-probe-${probeIdentity}.test.ts`,
    expectedDiagnostic: "imports private module file",
  },
  {
    name: "missing module interface",
    files: {
      [`modules/module-boundary-probe-missing-${probeIdentity}/private.ts`]: "export {};\n",
    },
    cleanupPath: `modules/module-boundary-probe-missing-${probeIdentity}`,
    expectedDiagnostic: "every module requires one public interface",
  },
  {
    name: "data-only module interface",
    files: {
      [`modules/module-boundary-probe-data-${probeIdentity}/main.ts`]:
        "export const DataInterface = { value: true };\n",
    },
    cleanupPath: `modules/module-boundary-probe-data-${probeIdentity}`,
    expectedDiagnostic: "properties are action methods",
  },
  {
    name: "barrel module interface",
    files: {
      [`modules/module-boundary-probe-barrel-${probeIdentity}/main.ts`]:
        'export const BarrelInterface = { run() {} };\nexport { helper } from "./helper.ts";\n',
      [`modules/module-boundary-probe-barrel-${probeIdentity}/helper.ts`]:
        "export function helper() {}\n",
    },
    cleanupPath: `modules/module-boundary-probe-barrel-${probeIdentity}`,
    expectedDiagnostic: "must export exactly one variable statement",
  },
  {
    name: "flat production module file",
    files: {
      [`modules/module-boundary-probe-${probeIdentity}.ts`]: "export {};\n",
    },
    cleanupPath: `modules/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "production files must be inside a feature module",
  },
  {
    name: "production code outside modules",
    files: {
      [`module-boundary-probe-${probeIdentity}.ts`]: "export {};\n",
    },
    cleanupPath: `module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "production TypeScript must live",
  },
  {
    name: "module dependency cycle",
    files: {
      [`modules/module-boundary-probe-cycle-${probeIdentity}/main.ts`]:
        'import "./worker.ts";\nexport const CycleProbe = { run() {} };\n',
      [`modules/module-boundary-probe-cycle-${probeIdentity}/worker.ts`]: 'import "./main.ts";\n',
    },
    cleanupPath: `modules/module-boundary-probe-cycle-${probeIdentity}`,
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
