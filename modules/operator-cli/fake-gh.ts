/**
 * A stand-in for the `gh` CLI.
 * It answers in the shape `gh api --include` produces and records every call, so tests drive
 * tracker writes, lost answers, duplicates, edits, and closure conflicts through the real
 * external interface instead of replacing a module by path.
 *
 * Its state lives in `$GH_FAKE_DIR/state.json` and the faults it injects in `faults.json`.
 */

import type { FakeComment, FakeFault, FakeIssue, GithubFakeState } from "./github-fake-state.ts";

const directory = process.env.GH_FAKE_DIR ?? "";
const statePath = `${directory}/state.json`;
const faultsPath = `${directory}/faults.json`;

async function readState(): Promise<GithubFakeState> {
  const file = Bun.file(statePath);
  if (await file.exists()) {
    const held: GithubFakeState = await file.json();
    return held;
  }

  return { viewer: "operator-bot", nextCommentId: 1, issues: {}, comments: {}, events: {} };
}

async function writeState(state: GithubFakeState): Promise<void> {
  await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function takeFault(name: string): Promise<string | null> {
  const file = Bun.file(faultsPath);
  if (!(await file.exists())) {
    return null;
  }

  const faults: Record<string, FakeFault | undefined> = await file.json();
  const fault = faults[name];
  if (fault === undefined || fault.remaining <= 0) {
    return null;
  }

  fault.remaining -= 1;
  await Bun.write(faultsPath, `${JSON.stringify(faults, null, 2)}\n`);
  return fault.kind;
}

function answer(status: number, body: unknown): void {
  const text = body === null ? "" : JSON.stringify(body);
  process.stdout.write(
    [
      `HTTP/2.0 ${status} ${status < 300 ? "OK" : "Error"}`,
      "content-type: application/json; charset=utf-8",
      "",
      text,
    ].join("\r\n"),
  );
}

/** A lost answer: the call ends with nothing readable, so its effect stays unknown. */
function lose(): void {
  process.stderr.write("gh: the answer was lost\n");
  process.exitCode = 1;
}

function parsePath(raw: string): { path: string; query: URLSearchParams } {
  const [path, search] = raw.split("?");
  return { path: path ?? "", query: new URLSearchParams(search ?? "") };
}

const args = process.argv.slice(2);
const flags = new Set(["--include", "-i"]);
const valueFlags = new Set(["--method", "--input", "-f", "-F", "-H"]);

let method = "GET";
let usesStdin = false;
let rawPath = "";
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index] ?? "";
  if (argument === "api" || flags.has(argument)) {
    continue;
  }
  if (valueFlags.has(argument)) {
    const value = args[index + 1] ?? "";
    if (argument === "--method") {
      method = value;
    }
    if (argument === "--input") {
      usesStdin = value === "-";
    }
    index += 1;
    continue;
  }
  if (rawPath === "") {
    rawPath = argument;
  }
}

await Bun.write(
  Bun.file(`${directory}/calls.log`),
  `${await Bun.file(`${directory}/calls.log`)
    .text()
    .catch(() => "")}${method} ${rawPath}\n`,
);

const { path, query } = parsePath(rawPath);
const body: { body?: string; state?: string; state_reason?: string } | null = usesStdin
  ? JSON.parse(await Bun.stdin.text())
  : null;
const state = await readState();
const now = new Date().toISOString();

const commentMatch = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
const issueMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
const commentsMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
const eventsMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(path);

/** Answers with the fault this call was given, or null when it should run normally. */
/**
 * Answers with the fault this call was given, if it stops the call before its effect.
 * Returns `applied-lost` when the effect still runs and only its answer is lost, so recovery
 * has to read to find out what happened.
 */
async function faulted(name: string): Promise<"answered" | "applied-lost" | "none"> {
  const fault = await takeFault(name);
  if (fault === null) {
    return "none";
  }
  if (fault === "lost") {
    lose();
    return "answered";
  }

  const status = /^status:(\d+)$/.exec(fault);
  if (status?.[1] !== undefined) {
    answer(Number(status[1]), { message: "the fake refused" });
    return "answered";
  }

  return "applied-lost";
}

if (path === "user") {
  if ((await faulted("viewer")) === "none") {
    answer(200, { login: state.viewer });
  }
} else if (commentsMatch?.[1] !== undefined && method === "POST") {
  const issue = commentsMatch[1];
  const fault = await faulted("createComment");
  if (fault !== "answered") {
    const id = state.nextCommentId;
    state.nextCommentId += 1;
    const comment: FakeComment = {
      id,
      html_url: `https://github.com/fake/repo/issues/${issue}#issuecomment-${id}`,
      user: { login: state.viewer },
      body: String(body?.body ?? ""),
      created_at: now,
      updated_at: now,
    };
    state.comments[issue] = [...(state.comments[issue] ?? []), comment];
    await writeState(state);
    if (fault === "applied-lost") {
      lose();
    } else {
      answer(201, comment);
    }
  }
} else if (commentsMatch?.[1] !== undefined) {
  const issue = commentsMatch[1];
  const page = Number(query.get("page") ?? "1");
  if ((await faulted(page === 1 ? "scanComments" : `scanComments.page${page}`)) === "none") {
    const perPage = Number(query.get("per_page") ?? "100");
    const held = state.comments[issue] ?? [];
    answer(200, held.slice((page - 1) * perPage, page * perPage));
  }
} else if (commentMatch?.[1] !== undefined) {
  if ((await faulted("readComment")) === "none") {
    const id = Number(commentMatch[1]);
    const found = Object.values(state.comments)
      .flat()
      .find((one) => one.id === id);
    if (found === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      answer(200, found);
    }
  }
} else if (eventsMatch?.[1] !== undefined) {
  if ((await faulted("readEvents")) === "none") {
    answer(200, state.events[eventsMatch[1]] ?? []);
  }
} else if (issueMatch?.[1] !== undefined && method === "PATCH") {
  const number = issueMatch[1];
  const fault = await faulted("closeIssue");
  if (fault !== "answered") {
    const held = state.issues[number];
    if (held === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      const closed: FakeIssue = {
        ...held,
        state: body?.state ?? "closed",
        state_reason: body?.state_reason ?? "completed",
        closed_by: { login: state.viewer },
        closed_at: now,
        updated_at: now,
      };
      state.issues[number] = closed;
      state.events[number] = [
        ...(state.events[number] ?? []),
        {
          event: "closed",
          actor: { login: state.viewer },
          state_reason: closed.state_reason,
          created_at: now,
        },
      ];
      await writeState(state);
      if (fault === "applied-lost") {
        lose();
      } else {
        answer(200, closed);
      }
    }
  }
} else if (issueMatch?.[1] !== undefined) {
  if ((await faulted("readIssue")) === "none") {
    const held = state.issues[issueMatch[1]];
    if (held === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      answer(200, held);
    }
  }
} else {
  answer(404, { message: `the fake does not answer ${method} ${path}` });
}
