import v3xlabs from "eslint-plugin-v3xlabs";

// eslint and vitest both load their config through a default export
export default [
  { ignores: ["dist/**", "vscode-dts/**"] },
  ...v3xlabs.configs.recommended,
  {
    files: ["eslint.config.mjs", "vitest.config.mts"],
    rules: { "import/no-default-export": "off" },
  },
];
