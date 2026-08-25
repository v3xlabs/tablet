{
  lib,
  stdenv,
  nodejs_22,
  pnpmConfigHook,
  fetchPnpmDeps,
  pnpm,
  vsce,
  vscode-utils,
}: let
  version = "0.1.0";

  vsix = stdenv.mkDerivation (final: {
    pname = "tablet-vsix";
    inherit version;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../pnpm-lock.yaml
        ../pnpm-workspace.yaml
        ../tsconfig.json
        ../esbuild.mjs
        ../eslint.config.mjs
        ../vitest.config.mts
        ../.vscodeignore
        ../README.md
        ../src
        ../test
        ../vscode-dts
      ];
    };

    nativeBuildInputs = [
      nodejs_22
      pnpm
      pnpmConfigHook
      vsce
    ];

    pnpmDeps = fetchPnpmDeps {
      inherit (final) pname version src;
      fetcherVersion = 4;
      hash = "sha256-lKv6bcp3akC1wptORVjWNoIxFZfqds9YlFCbFaF7piw=";
    };

    buildPhase = ''
      runHook preBuild
      pnpm run check
      pnpm run build
      vsce package --no-dependencies --allow-missing-repository --skip-license --out tablet.vsix
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      install -Dm444 tablet.vsix $out/tablet.vsix
      runHook postInstall
    '';
  });
in
  vscode-utils.buildVscodeExtension {
    pname = "tablet";
    inherit version;
    src = "${vsix}/tablet.vsix";
    vscodeExtPublisher = "v3xlabs";
    vscodeExtName = "tablet";
    vscodeExtUniqueId = "v3xlabs.tablet";

    meta = {
      description = "Bring your own endpoint tab completion and next edit prediction";
      license = lib.licenses.mit;
      platforms = lib.platforms.all;
    };
  }
