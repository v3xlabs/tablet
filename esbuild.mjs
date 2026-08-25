import process from "node:process";

import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

if (watch) {
  const context_ = await context(options);

  await context_.watch();
}
else {
  await build(options);
}
