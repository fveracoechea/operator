import { type Installation, inspectInstallation, type RunningRelease } from "./inspect.ts";
import {
  issueLines,
  JSR_PACKAGE_NAME,
  PACKAGE_NAME,
  PROJECT_COMMAND,
  readSelection,
  type ReleaseSelection,
  SELECTION_PATH,
  selectionSchema,
  selectionText,
} from "./selection.ts";

export const ReleaseInstall = {
  /** The project-relative path the release selection owns. */
  paths() {
    return { selection: SELECTION_PATH };
  },

  /** Reads the exact release this project selected. Writes nothing. */
  async selection(request: { projectRoot: string }) {
    return readSelection(request.projectRoot);
  },

  /**
   * Records one exact release selection. Bun owns the project's dependency and lock data.
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

    return { status: "selected" as const, selection: parsed.data, written };
  },

  /** Reports whether the selected release is the one installed and running. Writes nothing. */
  async inspect(request: { projectRoot: string; running: RunningRelease }): Promise<Installation> {
    return inspectInstallation(request);
  },

  /**
   * The exact commands one delivery path is used through from the project root.
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
      install: "bun install --frozen-lockfile",
      run: `${PROJECT_COMMAND} <operation>`,
      convenience: `bunx --bun jsr add --bun --save-dev "${PACKAGE_NAME}@${version}" (records ${JSR_PACKAGE_NAME}@${version})`,
    };
  },
};
