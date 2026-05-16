import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Dev bind-mount holds OS-native dependency copies under hyphenated
    // `node-modules` dirs (postgres/redis/web/worker). ESLint's built-in
    // `node_modules` ignore doesn't match the hyphen, so without this it
    // walks thousands of dep files and dies on a malformed graphql .d.ts
    // (same root cause as the tsconfig `persistent_data` exclude).
    "persistent_data/**",
  ]),
]);

export default eslintConfig;
