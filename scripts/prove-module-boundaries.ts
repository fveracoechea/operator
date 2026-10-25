// Bun has no recursive copy, directory removal, or temporary directory API, and no path
// manipulation API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Violation = {
  name: string;
  files: Record<string, string>;
  cleanupPath: string;
  expectedDiagnostic: string;
};

/** Everything `lint:modules` reads. The copy holds this and nothing else. */
const COPIED = [
  "cli.ts",
  "modules",
  "lib",
  "scripts",
  "dependency-cruiser.config.cjs",
  "package.json",
  "tsconfig.json",
];

/**
 * Builds the checkout this proof writes its deliberate violations into.
 * A violation left in the real checkout, even for a moment, is read by every other check that
 * runs beside this one, so the proof owns a copy outside the repository instead.
 */
async function makeCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "operator-module-boundaries-"));
  await Promise.all(
    COPIED.map((entry) => cp(resolve(entry), join(root, entry), { recursive: true })),
  );
  // The check resolves `typescript` and `depcruise` through node_modules, so a link is enough
  // and 90 MB is not copied. Removing the copy unlinks it and leaves the real one alone.
  await symlink(resolve("node_modules"), join(root, "node_modules"));
  return root;
}

async function runBoundaryCheck(copyRoot: string): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const child = Bun.spawn(["bun", "run", "lint:modules"], {
    cwd: copyRoot,
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

async function requireCleanGraph(copyRoot: string, message: string): Promise<void> {
  const result = await runBoundaryCheck(copyRoot);
  if (result.exitCode !== 0) {
    report(result);
    throw new Error(message);
  }
}

async function proveViolation(copyRoot: string, violation: Violation): Promise<void> {
  try {
    for (const [path, content] of Object.entries(violation.files)) {
      await Bun.write(join(copyRoot, path), content, { createPath: true });
    }

    const result = await runBoundaryCheck(copyRoot);
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode === 0 || !diagnostics.includes(violation.expectedDiagnostic)) {
      report(result);
      throw new Error(`${violation.name} was not rejected`);
    }
  } finally {
    await rm(join(copyRoot, violation.cleanupPath), { force: true, recursive: true });
  }
}

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
    name: "lib importing a module interface",
    files: {
      [`lib/module-boundary-probe-${probeIdentity}.ts`]:
        'export { OperatorCli } from "../modules/operator-cli/main.ts";\n',
    },
    cleanupPath: `lib/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "lib must not import application or tooling code",
  },
  {
    name: "lib importing private module code",
    files: {
      [`lib/module-boundary-probe-${probeIdentity}.ts`]:
        'const run = import("../modules/operator-cli/run.ts");\n',
    },
    cleanupPath: `lib/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "lib must not import application or tooling code",
  },
  {
    name: "lib requiring application code",
    files: {
      [`lib/module-boundary-probe-${probeIdentity}.ts`]: 'require("../cli.ts");\n',
    },
    cleanupPath: `lib/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "lib must not import application or tooling code",
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
  {
    name: "module importing another module's private code",
    files: {
      [`modules/module-boundary-probe-private-${probeIdentity}/main.ts`]:
        'import "../operator-cli/run.ts";\nexport const PrivateProbe = { run() {} };\n',
    },
    cleanupPath: `modules/module-boundary-probe-private-${probeIdentity}`,
    expectedDiagnostic: "imports private module file",
  },
  {
    name: "lib dependency cycle",
    files: {
      [`lib/module-boundary-probe-cycle-${probeIdentity}/a.ts`]: 'import "./b.ts";\n',
      [`lib/module-boundary-probe-cycle-${probeIdentity}/b.ts`]: 'import "./a.ts";\n',
    },
    cleanupPath: `lib/module-boundary-probe-cycle-${probeIdentity}`,
    expectedDiagnostic: "no-module-cycles",
  },
  {
    name: "lib importing an application type",
    files: {
      [`lib/module-boundary-probe-${probeIdentity}.ts`]:
        'export type App = typeof import("../modules/operator-cli/main.ts");\n',
    },
    cleanupPath: `lib/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "lib must not import application or tooling code",
  },
  {
    name: "lib using an import-equals application reference",
    files: {
      [`lib/module-boundary-probe-${probeIdentity}.ts`]:
        'import App = require("../modules/operator-cli/main.ts");\n',
    },
    cleanupPath: `lib/module-boundary-probe-${probeIdentity}.ts`,
    expectedDiagnostic: "lib must not import application or tooling code",
  },
];

const copyRoot = await makeCopy();
try {
  await requireCleanGraph(copyRoot, "The clean module graph did not pass");
  const valid = `lib/module-boundary-probe-valid-${probeIdentity}`;
  await Bun.write(join(copyRoot, `${valid}/value.ts`), "export function value() { return 1; }\n", {
    createPath: true,
  });
  await Bun.write(
    join(copyRoot, `${valid}/consumer.ts`),
    'import { value } from "./value.ts";\nexport function twice() { return value() * 2; }\n',
  );
  await requireCleanGraph(copyRoot, "Focused lib imports and named exports did not pass");
  await rm(join(copyRoot, valid), { recursive: true });
  for (const violation of violations) {
    await proveViolation(copyRoot, violation);
  }
  await requireCleanGraph(copyRoot, "The restored module graph did not pass");
} finally {
  await rm(copyRoot, { force: true, recursive: true });
}

console.log(
  `module boundaries: clean -> rejected ${violations.length} deliberate violations -> clean`,
);
