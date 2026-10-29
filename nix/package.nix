# The Operator release as a Nix package.
# It builds the same artifact as the JSR release job, from the same commit and with the same
# release record, and lays it out like Bun's global folder. See ADR-0007.
{
  lib,
  stdenv,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  bun2nix,
  src,
  commit,
  sourceDateEpoch,
}:
let
  packageJson = lib.importJSON ../package.json;
  bunVersion = lib.removePrefix "bun@" packageJson.packageManager;

  # The official Bun archives at the version the release pins. A consumer's nixpkgs can carry an
  # older Bun that the CLI refuses, so the package never takes Bun from nixpkgs.
  # Each Bun update needs both hashes from the npm registry, and the build refuses a mismatch.
  bunArchives = {
    aarch64-darwin = {
      name = "bun-darwin-aarch64";
      hash = "sha512-MXdZkP1featqxZ+/VTXWG1BVjM4OGBehVY2Q88EeUj/7L0UMeCGItmyPYTN+wxvlGJ6F66JEtzsw+GvQWewnag==";
    };
    x86_64-linux = {
      name = "bun-linux-x64";
      hash = "sha512-9/E/UXOTpSo3YsV5g+FhtTd/qTpiWoKuxS12cqtuYA1ssu9fRAoPQnipFgGyck3tWO63iUdxBiygq+kELFawng==";
    };
  };
  archive = bunArchives.${stdenv.hostPlatform.system};

  # Readiness needs every owned skill, so consumers link each name the release ships.
  skills = lib.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ../skills));

  bun = stdenvNoCC.mkDerivation {
    pname = "bun";
    version = bunVersion;
    src = fetchurl {
      url = "https://registry.npmjs.org/@oven/${archive.name}/-/${archive.name}-${bunVersion}.tgz";
      inherit (archive) hash;
    };
    sourceRoot = "package";
    dontBuild = true;
    dontStrip = true;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
    installPhase = ''
      runHook preInstall
      install -Dm755 bin/bun $out/bin/bun
      ln -s bun $out/bin/bunx
      runHook postInstall
    '';
  };
in
stdenv.mkDerivation {
  pname = "operator";
  version = packageJson.version;
  inherit src;

  # The pinned Bun comes before the hook, so the locked install runs on it too.
  nativeBuildInputs = [
    bun
    bun2nix.hook
  ];
  bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

  # The artifact identity covers every byte, so nothing may rewrite the shebangs or strip files.
  dontUseBunPatch = true;
  dontFixup = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;

  # The release job records the commit time as the build time, so both release records match.
  SOURCE_DATE_EPOCH = sourceDateEpoch;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    if [ "$(bun --version)" != "${bunVersion}" ]; then
      echo "The build runs Bun $(bun --version), not the pinned ${bunVersion}." >&2
      exit 1
    fi
    bun scripts/release.ts build --out dist --commit ${commit}
    # The runtime packages come from the same locked cache, without development packages.
    mkdir runtime
    cp package.json bun.lock runtime/
    (cd runtime && bun install --frozen-lockfile --production --ignore-scripts \
      --linker=hoisted --backend=copyfile)
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    root=$out/lib/operator
    release=$root/node_modules/@fveracoechea/operator
    mkdir -p $root/node_modules/@fveracoechea $out/bin $out/share/skills/operator
    cp -R runtime/node_modules/. $root/node_modules/
    cp -R dist $release
    # One link per skill folder, in the nixpkgs agent-skills layout that consumers link from.
    for skill in $release/skills/*/; do
      name=$(basename "$skill")
      ln -s ../../../lib/operator/node_modules/@fveracoechea/operator/skills/$name \
        $out/share/skills/operator/$name
    done
    bun scripts/release.ts launcher --root $root --bun ${bun}/bin/bun > $out/bin/operator
    chmod 755 $out/bin/operator
    runHook postInstall
  '';

  passthru = {
    inherit bun bunVersion skills;
    release = "lib/operator/node_modules/@fveracoechea/operator";
  };

  meta = {
    description = "Coordinate SuperAgents and WorkerAgents across projects on one device";
    license = lib.licenses.mit;
    mainProgram = "operator";
    platforms = builtins.attrNames bunArchives;
  };
}
