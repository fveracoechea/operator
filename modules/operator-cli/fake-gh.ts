/**
 * A stand-in for the `gh` CLI.
 * It answers in the shape `gh api --include` produces and records every call, so tests drive
 * tracker writes, lost answers, duplicates, edits, and closure conflicts through the real
 * external interface instead of replacing a module by path.
 *
 * Its state lives in `$GH_FAKE_DIR/state.json` and the faults it injects in `faults.json`.
 */

import type {
  FakeComment,
  FakeFault,
  FakeIssue,
  FakePull,
  GithubFakeState,
} from "./github-fake-state.ts";

const directory = process.env.GH_FAKE_DIR ?? "";
const statePath = `${directory}/state.json`;
const faultsPath = `${directory}/faults.json`;

async function readState(): Promise<GithubFakeState> {
  const file = Bun.file(statePath);
  if (await file.exists()) {
    const held: GithubFakeState = await file.json();
    return held;
  }

  return {
    viewer: "operator-bot",
    nextCommentId: 1,
    issues: {},
    comments: {},
    events: {},
    subIssues: {},
    blockedBy: {},
  };
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
if (args[0] === "--version") {
  const file = Bun.file(`${directory}/version-new`);
  const version = (await file.exists()) ? (await file.text()).trim() || "2.1.0" : "2.0.0";
  console.log(`gh version ${version}`);
  process.exit(0);
}
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
const body: {
  body?: string;
  state?: string;
  state_reason?: string;
  title?: string;
  head?: string;
  base?: string;
  draft?: boolean;
} | null = usesStdin ? JSON.parse(await Bun.stdin.text()) : null;
const state = await readState();
const now = new Date().toISOString();

const commentMatch = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
const issueMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
const commentsMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
const eventsMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(path);
const subIssuesMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/sub_issues$/.exec(path);
const blockedByMatch = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
const repositoryMatch = /^repos\/([^/]+\/[^/]+)$/.exec(path);
const rulesMatch = /^repos\/([^/]+\/[^/]+)\/rules\/branches\/(.+)$/.exec(path);
const pullsMatch = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
const pullMatch = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
const commitMatch = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/.exec(path);

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

if (repositoryMatch?.[1] !== undefined) {
  if ((await faulted("readRepository")) === "none") {
    const name = repositoryMatch[1];
    answer(200, {
      full_name: name,
      ...(state.repositories?.[name] ?? {
        default_branch: "main",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
      }),
    });
  }
} else if (rulesMatch?.[1] !== undefined) {
  if ((await faulted("readRules")) === "none") {
    answer(200, state.rules?.[`${rulesMatch[1]}:${decodeURIComponent(rulesMatch[2] ?? "")}`] ?? []);
  }
} else if (pullsMatch?.[1] !== undefined && method === "POST") {
  const name = pullsMatch[1];
  const fault = await faulted("createPull");
  if (fault !== "answered") {
    const held = state.pulls?.[name] ?? [];
    const text = String(body?.body ?? "");
    if (text.length > 65_536) {
      answer(422, { message: "Validation Failed: body is too long (maximum is 65536 characters)" });
    } else {
      const number = 1000 + Object.values(state.pulls ?? {}).flat().length + 1;
      const owner = name.split("/")[0] ?? "";
      const pull: FakePull = {
        number,
        html_url: `https://github.com/${name}/pull/${number}`,
        state: "open",
        draft: body?.draft === true,
        title: String(body?.title ?? ""),
        body: text,
        head: { ref: String(body?.head ?? ""), label: `${owner}:${String(body?.head ?? "")}` },
        base: { ref: String(body?.base ?? "") },
      };
      state.pulls = { ...state.pulls, [name]: [...held, pull] };
      await writeState(state);
      if (fault === "applied-lost") {
        lose();
      } else {
        answer(201, pull);
      }
    }
  }
} else if (pullsMatch?.[1] !== undefined) {
  if ((await faulted("listPulls")) === "none") {
    const wanted = query.get("state") ?? "open";
    const head = query.get("head");
    answer(
      200,
      (state.pulls?.[pullsMatch[1]] ?? []).filter(
        (one) =>
          (wanted === "all" || one.state === wanted) && (head === null || one.head.label === head),
      ),
    );
  }
} else if (pullMatch?.[1] !== undefined && method === "PATCH") {
  const name = pullMatch[1];
  const fault = await faulted("updatePull");
  if (fault !== "answered") {
    const held = state.pulls?.[name] ?? [];
    const found = held.find((one) => one.number === Number(pullMatch[2]));
    if (found === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      const changed = { ...found };
      if (body?.base !== undefined) {
        changed.base = { ref: body.base };
      }
      if (body?.state === "closed" || body?.state === "open") {
        changed.state = body.state;
      }
      state.pulls = {
        ...state.pulls,
        [name]: held.map((one) => (one.number === changed.number ? changed : one)),
      };
      await writeState(state);
      if (fault === "applied-lost") {
        lose();
      } else {
        answer(200, { merged: false, merge_commit_sha: null, ...changed });
      }
    }
  }
} else if (pullMatch?.[1] !== undefined && method === "GET") {
  if ((await faulted("readPull")) === "none") {
    const found = (state.pulls?.[pullMatch[1]] ?? []).find(
      (one) => one.number === Number(pullMatch[2]),
    );
    if (found === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      answer(200, { merged: false, merge_commit_sha: null, ...found });
    }
  }
} else if (commitMatch?.[2] !== undefined) {
  if ((await faulted("readCommit")) === "none") {
    const found = state.commits?.[commitMatch[2]];
    if (found === undefined) {
      answer(404, { message: "No commit found for SHA" });
    } else {
      answer(200, found);
    }
  }
} else if (path === "user") {
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
} else if (subIssuesMatch?.[1] !== undefined) {
  if ((await faulted("readSubIssues")) === "none") {
    answer(200, state.subIssues?.[subIssuesMatch[1]] ?? []);
  }
} else if (blockedByMatch?.[1] !== undefined) {
  if ((await faulted("readBlockedBy")) === "none") {
    answer(200, state.blockedBy?.[blockedByMatch[1]] ?? []);
  }
} else if (issueMatch?.[1] !== undefined && method === "PATCH") {
  const number = issueMatch[1];
  const fault = await faulted(body?.state === "open" ? "reopenIssue" : "closeIssue");
  if (fault !== "answered") {
    const held = state.issues[number];
    if (held === undefined) {
      answer(404, { message: "Not Found" });
    } else {
      const reopening = body?.state === "open";
      const closed: FakeIssue = reopening
        ? {
            ...held,
            state: "open",
            state_reason: null,
            closed_by: null,
            closed_at: null,
            updated_at: now,
          }
        : {
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
          event: reopening ? "reopened" : "closed",
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
