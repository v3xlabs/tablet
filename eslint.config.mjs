import v3xlabs from "eslint-plugin-v3xlabs";

export default [
  { ignores: ["dist/**", "vscode-dts/**", "bench/cases/**", "bench/seeds/**", "bench/results/**", ".tmp/**"] },
  ...v3xlabs.configs.recommended,
  {
    files: ["eslint.config.mjs", "vitest.config.mts"],
    rules: { "import/no-default-export": "off" },
  },
  {
    rules: { "max-lines": ["warn", 500] },
  },
];
