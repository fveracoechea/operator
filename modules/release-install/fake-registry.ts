/**
 * A stand-in for the npm-compatible registry JSR serves its packages through.
 * It rewrites the package manifest the way the registry does, dropping the `bin`, `scripts`, and
 * `engines` fields, so a test proves the release still reports itself without them.
 */

export type RegistryFake = {
  url: string;
  packageName: string;
  requests: string[];
  stop: () => void;
};

function shasum(bytes: Uint8Array<ArrayBuffer>): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function integrity(bytes: Uint8Array<ArrayBuffer>): string {
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(bytes);
  return `sha512-${hasher.digest("base64")}`;
}

/**
 * The npm dependencies the registry derives from the release configuration.
 * JSR reads `jsr.json`, never the package manifest beside it, so the fake reads the same file
 * the real registry does and a dependency named only in the manifest stays missing here too.
 */
export function registryDependencies(config: {
  imports?: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.imports ?? {}).map(([name, specifier]) => [
      name,
      specifier.replace(/^npm:.*@/, ""),
    ]),
  );
}

/** The manifest the registry generates, which carries no command, script, or engine field. */
export function registryManifest(request: {
  packageName: string;
  version: string;
  dependencies: Record<string, string>;
}): string {
  return `${JSON.stringify(
    {
      name: request.packageName,
      version: request.version,
      type: "module",
      exports: {
        ".": { types: "./cli.d.ts", default: "./cli.js" },
        "./cli": { types: "./cli.d.ts", default: "./cli.js" },
      },
      dependencies: request.dependencies,
      _jsr_revision: 1,
    },
    null,
    2,
  )}\n`;
}

/** Serves one version of one package, exactly as an npm client asks for it. */
export function startRegistryFake(request: {
  packageName: string;
  version: string;
  tarball: Uint8Array<ArrayBuffer>;
  dependencies?: Record<string, string>;
}): RegistryFake {
  const requests: string[] = [];
  const port = { value: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(incoming): Response {
      const url = new URL(incoming.url);
      const path = decodeURIComponent(url.pathname);
      requests.push(path);

      if (path === `/${request.packageName}`) {
        const base = `http://127.0.0.1:${port.value}`;
        return Response.json({
          name: request.packageName,
          "dist-tags": { latest: request.version },
          versions: {
            [request.version]: {
              name: request.packageName,
              version: request.version,
              type: "module",
              // A client resolves what a package needs from the listing, not from the tarball.
              dependencies: request.dependencies ?? {},
              dist: {
                tarball: `${base}/tarball/${request.version}.tgz`,
                shasum: shasum(request.tarball),
                integrity: integrity(request.tarball),
              },
            },
          },
        });
      }

      if (path === `/tarball/${request.version}.tgz`) {
        return new Response(new Blob([request.tarball]), {
          headers: { "content-type": "application/octet-stream" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  port.value = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port.value}/`,
    packageName: request.packageName,
    requests,
    stop: () => server.stop(true),
  };
}
