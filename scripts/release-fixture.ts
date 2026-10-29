// Bun has no TCP server for proxy requests, temporary directory, or path API.
import { expect } from "bun:test";
import { createServer } from "node:net";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Records the host of each HTTPS request a child sends through it and refuses the connection, so
 * a release command under test never reaches a real registry.
 */
export async function startProxyRecorder(): Promise<{
  url: string;
  hosts: string[];
  stop: () => void;
}> {
  const hosts: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const [, host = ""] = /^CONNECT (\S+) /.exec(data.toString()) ?? [];
      hosts.push(host);
      socket.destroy();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(z.object({ port: z.number() }).parse(server.address()).port);
    });
  });
  return { url: `http://127.0.0.1:${port}`, hosts, stop: () => server.close() };
}

function digest(
  algorithm: "sha1" | "sha512",
  bytes: Uint8Array<ArrayBuffer>,
  encoding: "hex" | "base64",
) {
  const hasher = new Bun.CryptoHasher(algorithm);
  hasher.update(bytes);
  return hasher.digest(encoding);
}

/**
 * Serves one controlled package as the `@jsr` scope serves Operator. Its `cli.js` registers a
 * project and prints the given version report. With no report, every request is not found.
 */
export async function startPackageRegistry(
  version: string,
  report: { operatorVersion: string; commit: string; artifactIdentity: string } | null,
): Promise<{ url: string; requests: string[]; times: number[]; stop: () => Promise<void> }> {
  const packageName = "@jsr/fveracoechea__operator";
  const root = await mkdtemp(path.join(tmpdir(), "operator-release-package-"));
  await Bun.write(
    `${root}/package/package.json`,
    JSON.stringify({ name: packageName, version, type: "module" }),
    { createPath: true },
  );
  await Bun.write(
    `${root}/package/cli.js`,
    `if (process.argv[2] === "--version") console.log(${JSON.stringify(JSON.stringify({ data: report }))});\n`,
  );
  const packed = Bun.spawnSync(["tar", "-czf", `${root}/package.tgz`, "-C", root, "package"]);
  expect(packed.exitCode, packed.stderr.toString()).toBe(0);
  const tarball = new Uint8Array(await Bun.file(`${root}/package.tgz`).arrayBuffer());
  const requests: string[] = [];
  const times: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(incoming): Response {
      const requested = decodeURIComponent(new URL(incoming.url).pathname);
      requests.push(requested);
      times.push(Date.now());
      if (report !== null && requested === `/${packageName}`) {
        return Response.json({
          name: packageName,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name: packageName,
              version,
              type: "module",
              dependencies: {},
              dist: {
                tarball: `http://127.0.0.1:${server.port}/package.tgz`,
                shasum: digest("sha1", tarball, "hex"),
                integrity: `sha512-${digest("sha512", tarball, "base64")}`,
              },
            },
          },
        });
      }
      if (report !== null && requested === "/package.tgz") return new Response(tarball);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    requests,
    times,
    stop: () => server.stop(true),
  };
}

/**
 * Writes controlled commands, such as `bun`, `bunx`, and `jsr`. Each records its arguments and
 * PATH in the directory, then exits with the code the test chose.
 */
export async function writeControlledTools(codes: Record<string, number>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "operator-release-tools-"));
  for (const [tool, code] of Object.entries(codes)) {
    await Bun.write(
      `${directory}/${tool}`,
      `#!/bin/sh\necho "$*" >> "${directory}/${tool}.args"\necho "$PATH" >> "${directory}/${tool}.path"\nexit ${code}\n`,
    );
    await chmod(`${directory}/${tool}`, 0o755);
  }
  return directory;
}
