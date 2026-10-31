# Flake checks for the Nix package. Each check runs the installed package the way a consumer
# does, in isolated device roots, and fails on the first broken promise.
{
  lib,
  runCommand,
  runtimeShell,
  git,
  jq,
  operator,
  bun2nixCli,
  src,
  commit,
  sourceDateEpoch,
}:
let
  version = operator.version;
  release = "${operator}/${operator.passthru.release}";
  bun = "${operator.passthru.bun}/bin/bun";

  # Isolated device roots, and a registered project, because every command but registration
  # refuses before the device database exists.
  device = ''
    set -euo pipefail
    export HOME=$TMPDIR/home XDG_CONFIG_HOME=$TMPDIR/config XDG_STATE_HOME=$TMPDIR/state
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
    mkdir -p $HOME $TMPDIR/checkout
    ${git}/bin/git init -q $TMPDIR/checkout
    ${git}/bin/git -C $TMPDIR/checkout remote add origin https://github.com/fixture/registered.git
  '';
  register = ''
    (cd $TMPDIR/checkout && PATH=${git}/bin:$PATH operator project register --json > /dev/null)
  '';
in
{
  # The installed command reports the release version, the pinned Bun, the commit, and the
  # artifact identity of the release it runs.
  version = runCommand "operator-version-check" { } ''
    ${device}
    export PATH=${operator}/bin:$PATH
    ${register}
    test "$(operator --version)" = "operator ${version}"
    operator --version --json > version.json
    ${jq}/bin/jq -e \
      --arg version ${version} --arg bun ${operator.passthru.bunVersion} --arg commit ${commit} \
      --slurpfile record ${release}/release.json '
        .data.operatorVersion == $version and .data.bunVersion == $bun
        and .data.commit == $commit and .data.artifactIdentity == $record[0].artifactIdentity
      ' version.json
    cp version.json $out
  '';

  # The packaged artifact holds exactly the bytes its release record names, with the shebang the
  # JSR artifact has, and a release record that a build of the same commit always repeats.
  artifact = runCommand "operator-artifact-check" { } ''
    set -euo pipefail
    export HOME=$TMPDIR
    ${bun} -e '
      const root = "${release}";
      const { OperatorRelease } = await import(`''${root}/modules/operator-release/main.js`);
      const inspected = await OperatorRelease.inspect({ artifactRoot: root });
      const record = await Bun.file(`''${root}/release.json`).json();
      const cli = await Bun.file(`''${root}/cli.js`).text();
      const failures = [
        inspected.status === "complete" || `missing ''${inspected.missing.join(", ")}`,
        inspected.artifactIdentity === record.artifactIdentity || "the identity changed after the build",
        record.commit === "${commit}" || `the record names commit ''${record.commit}`,
        record.builtAt === new Date(${toString sourceDateEpoch} * 1000).toISOString()
          || `the record names build time ''${record.builtAt}, not the commit time`,
        cli.startsWith("#!/usr/bin/env bun\n") || "cli.js lost its shebang",
      ].filter((result) => result !== true);
      console.log(JSON.stringify({ identity: inspected.artifactIdentity, failures }));
      if (failures.length > 0) process.exit(1);
    ' | tee $out
    # One consumer link per skill folder, each reaching the release's own skill, and the names
    # consumers link from are exactly those folders.
    expected=$(cd ${release}/skills && find * -maxdepth 0 -type d | sort)
    linked=$(cd ${operator}/share/skills/operator && find * -maxdepth 0 | sort)
    test "$expected" = "$linked"
    test "$expected" = "$(printf '%s\n' ${lib.escapeShellArgs operator.passthru.skills} | sort)"
    for name in $linked; do
      test "$(realpath ${operator}/share/skills/operator/$name)" = "$(realpath ${release}/skills/$name)"
    done
  '';

  # nix/bun.nix is what the pinned bun2nix writes from the committed bun.lock.
  dependencies = runCommand "operator-dependencies-check" { } ''
    set -euo pipefail
    cp ${src}/bun.lock bun.lock
    ${bun2nixCli}/bin/bun2nix -l bun.lock -o bun.nix
    if ! diff -u ${src}/nix/bun.nix bun.nix; then
      echo "nix/bun.nix is stale. Run nix run .#bun2nix -- -l bun.lock -o nix/bun.nix" >&2
      exit 1
    fi
    touch $out
  '';

  # A Herdr hook finds the command through PATH alone, and readiness passes with skills that the
  # consumer links from the package. Owned installation only checks those links, and delegated
  # upstream installation reaches the package's Bun on a device with no other Bun.
  discovery = runCommand "operator-discovery-check" { } ''
    ${device}
    # The hook environment: a profile link to the package command, Git, and controlled tools.
    mkdir -p $TMPDIR/profile/bin $TMPDIR/tools
    ln -s ${operator}/bin/operator $TMPDIR/profile/bin/operator
    ln -s ${git}/bin/git $TMPDIR/tools/git
    for tool in gh herdr claude opencode; do
      printf '#!${runtimeShell}\n[ "$*" = "auth status --hostname github.com" ] && [ %s = gh ]\n' \
        $tool > $TMPDIR/tools/$tool
      chmod 755 $TMPDIR/tools/$tool
    done
    # Every Operator run below sees only that PATH.
    operator() { env PATH=$TMPDIR/profile/bin:$TMPDIR/tools operator "$@"; }
    ${register}

    printf '{"superAgent":{"host":"claude-code"}}' > $TMPDIR/config.json
    mkdir -p $XDG_CONFIG_HOME/operator $HOME/.claude/skills/code-review $HOME/.agents/skills/code-review
    cp $TMPDIR/config.json $XDG_CONFIG_HOME/operator/config.json
    echo upstream > $HOME/.claude/skills/code-review/SKILL.md
    echo upstream > $HOME/.agents/skills/code-review/SKILL.md
    # The consumer's Nix configuration owns the links to each owned skill. Claude Code gets the
    # shape that the Home Manager skills options write, a folder of links to each file. OpenCode
    # gets one link to each skill folder.
    mkdir -p $XDG_CONFIG_HOME/opencode/skills
    # cp keeps the read-only mode of the store folders, and Home Manager writes normal folders.
    linkClaude() {
      cp -rs ${operator}/share/skills/operator/$1/ $HOME/.claude/skills/$1
      chmod -R u+w $HOME/.claude/skills/$1
    }
    for name in ${lib.escapeShellArgs operator.passthru.skills}; do
      linkClaude $name
      ln -s ${operator}/share/skills/operator/$name $XDG_CONFIG_HOME/opencode/skills/$name
    done
    test -d $HOME/.claude/skills/worker-agent -a ! -L $HOME/.claude/skills/worker-agent
    test -L $HOME/.claude/skills/worker-agent/SKILL.md
    hosts() { (cd $HOME && find .claude .agents -exec ls -ld {} + ; cd $XDG_CONFIG_HOME && find opencode -exec ls -ld {} +) | sort; }
    before=$(hosts)

    operator ready --json > ready.json || true
    cat ready.json
    ${jq}/bin/jq -e '.reason == "ready" and .blockers == []' ready.json

    operator install --claude --opencode --check --json > install.json
    ${jq}/bin/jq -e '.reason == "skills_checked" and .data.checkOnly == true' install.json
    test "$before" = "$(hosts)"

    # A missing consumer link is a blocker that names the Nix links, and nothing repairs it.
    rm -r $HOME/.claude/skills/worker-agent
    status=0; operator ready --json > missing.json || status=$?
    test $status = 3
    ${jq}/bin/jq -e '.reason == "not_ready" and (.blockers | length) == 1
      and (.blockers[0].detail | contains("consumer-owned Nix links"))' missing.json
    status=0; operator install --claude --json > refused.json || status=$?
    test $status != 0
    test ! -e $HOME/.claude/skills/worker-agent
    linkClaude worker-agent

    # Delegated upstream installation runs the package's Bun, which no other PATH entry supplies.
    # Local upstream repositories and an unreachable registry keep the attempt off the network.
    # The owned links are complete again, so the owned part only checks them.
    : > $TMPDIR/gitconfig
    upstream() {
      mkdir -p $TMPDIR/$1/$2
      printf -- '---\nname: %s\n---\n' $(basename $2) > $TMPDIR/$1/$2/SKILL.md
      ${git}/bin/git -C $TMPDIR/$1 init -q
      ${git}/bin/git -C $TMPDIR/$1 add .
      ${git}/bin/git -C $TMPDIR/$1 -c user.name=fixture -c user.email=fixture@example.com commit -qm fixture
      printf '[url "file://%s"]\n\tinsteadOf = https://github.com/%s.git\n' \
        $TMPDIR/$1 $3 >> $TMPDIR/gitconfig
    }
    upstream matt tdd mattpocock/skills
    upstream cursor pstack/skills/unslop cursor/plugins
    upstream humanlayer plugins/show-me/skills/show-me humanlayer/skills
    status=0
    env GIT_CONFIG_GLOBAL=$TMPDIR/gitconfig BUN_CONFIG_REGISTRY=http://127.0.0.1:9/ \
      PATH=$TMPDIR/profile/bin:$TMPDIR/tools operator install --claude --json > upstream.json \
      || status=$?
    cat upstream.json
    test $status != 0
    ${jq}/bin/jq -e '.reason == "upstream_install_failed"' upstream.json

    cp ready.json $out
  '';
}
