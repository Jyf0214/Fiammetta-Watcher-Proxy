import tseslint from "typescript-eslint";
import js from "@eslint/js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const nextConfig = require("eslint-config-next");

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextConfig,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: ["node_modules/", ".next/", "out/", "scripts/"],
  },
];
