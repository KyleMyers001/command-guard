import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".codegraph/**", "coverage/**", "dist/**"],
  },
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "extensions/command-guard/policy.ts",
      "tests/command-guard.test.mjs",
    ],
    rules: {
      "no-control-regex": "off",
    },
  },
);
