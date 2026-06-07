// Minimal, version-stable lint for the dashboard's TypeScript.
// Scoped to lib/ and app/; type-aware rules are intentionally not enabled to keep CI fast and deterministic.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["lib/**/*.ts", "app/**/*.ts", "app/**/*.tsx"],
    rules: {
      // Surfaced as warnings so they never block CI, but stay visible.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
