{
  description = "tablet, a bring your own endpoint completion extension for vscode";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: rec {
      tablet = pkgs.callPackage ./nix/package.nix {};
      default = tablet;
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.callPackage ./nix/devshell.nix {};
    });

    checks = forAllSystems (pkgs: {
      inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) tablet;
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
