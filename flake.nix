{
  description = "Operator, one device release of the CLI and its owned skills";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # nixpkgs refuses x86_64-darwin, so bun2nix makes its outputs only for these systems.
    systems.url = "github:nix-systems/triplet";
    bun2nix = {
      url = "github:nix-community/bun2nix/2.1.2";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      # A tag input records the commit that the tag and the JSR release name. The release build
      # refuses a dirty or unknown revision, so only a clean Git source builds the package.
      commit = self.rev or self.dirtyRev or "unknown";
      sourceDateEpoch = self.lastModified;
    in
    {
      packages = forAll (
        system: pkgs: {
          default = pkgs.callPackage ./nix/package.nix {
            bun2nix = bun2nix.packages.${system}.default;
            src = self;
            inherit commit sourceDateEpoch;
          };
        }
      );

      # The pinned bun2nix that writes nix/bun.nix, so the dependency check and a refresh agree.
      apps = forAll (
        system: pkgs: {
          bun2nix = {
            type = "app";
            program = "${bun2nix.packages.${system}.default}/bin/bun2nix";
            meta.description = "Write nix/bun.nix from bun.lock";
          };
        }
      );

      checks = forAll (
        system: pkgs:
        pkgs.callPackages ./nix/checks.nix {
          operator = self.packages.${system}.default;
          bun2nixCli = bun2nix.packages.${system}.default;
          src = self;
          inherit commit sourceDateEpoch;
        }
      );
    };
}
