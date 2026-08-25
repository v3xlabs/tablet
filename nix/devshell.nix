{
  mkShell,
  nodejs_22,
  pnpm,
  vsce,
  alejandra,
}:
mkShell {
  packages = [
    nodejs_22
    pnpm
    vsce
    alejandra
  ];
}
