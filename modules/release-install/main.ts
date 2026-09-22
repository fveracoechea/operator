import { type Installation, inspectInstallation, type RunningRelease } from "./inspect.ts";
import {
  INSTALL_ROOT,
  issueLines,
  JSR_PACKAGE_NAME,
  MANIFEST_PATH,
  manifestText,
  PACKAGE_NAME,
  readSelection,
  type ReleaseSelection,
  SELECTION_PATH,
  selectionSchema,
  selectionText,
} from "./selection.ts";

export const ReleaseInstall = {
  /** The project-relative paths the isolated installation owns. */
  paths() {
    return { root: INSTALL_ROOT, selection: SELECTION_PATH, manifest: MANIFEST_PATH };
  },

  /** Reads the exact release this project selected. Writes nothing. */
  async selection(request: { projectRoot: string }) {
    return readSelection(request.projectRoot);
  },

  /**
   * Records one exact release selection, and the isolated manifest the registry path installs
   * from. Existing lock data is never touched, because only a package manager may write it.
   */
  async select(request: { projectRoot: string; selection: ReleaseSelection }) {
    const parsed = selectionSchema.safeParse(request.selection);
    if (!parsed.success) {
      return { status: "invalid" as const, issues: issueLines(parsed.error) };
    }

    const written = [SELECTION_PATH];
    await Bun.write(`${request.projectRoot}/${SELECTION_PATH}`, selectionText(parsed.data), {
      createPath: true,
    });

    if (parsed.data.delivery === "jsr" && parsed.data.packageVersion !== null) {
      written.push(MANIFEST_PATH);
      await Bun.write(
        `${request.projectRoot}/${MANIFEST_PATH}`,
        manifestText({ packageVersion: parsed.data.packageVersion }),
        { createPath: true },
      );
    }

    return { status: "selected" as const, selection: parsed.data, written };
  },

  /** Reports whether the selected release is the one installed and running. Writes nothing. */
  async inspect(request: { projectRoot: string; running: RunningRelease }): Promise<Installation> {
    return inspectInstallation(request);
  },

  /**
   * The exact commands one delivery path is used through.
   * The registry path installs first and then executes through the importable entry point, so
   * the launcher resolves the package from the isolated installation and keeps the project
   * directory as the working directory.
   */
  commands(request: { selection: ReleaseSelection }) {
    const { selection } = request;
    if (selection.delivery === "github-source") {
      return {
        install: null,
        run: `bunx "github:fveracoechea/operator#${selection.commit}" <operation>`,
        convenience: "bunx github:fveracoechea/operator <operation>",
      };
    }

    const version = selection.packageVersion ?? selection.version;
    return {
      install: `cd ${INSTALL_ROOT} && bun install --frozen-lockfile`,
      run: [
        "bun --no-install -e 'const { main } = await import(",
        `Bun.pathToFileURL(Bun.resolveSync("${PACKAGE_NAME}/cli", \`\${process.cwd()}/${INSTALL_ROOT}\`)).href`,
        "); await main(Bun.argv.slice(1))' -- <operation>",
      ].join(""),
      convenience: `bunx --bun jsr add --bun "${PACKAGE_NAME}@${version}" (in ${INSTALL_ROOT}, which records ${JSR_PACKAGE_NAME}@${version})`,
    };
  },
};
