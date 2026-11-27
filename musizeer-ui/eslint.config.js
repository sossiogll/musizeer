// The lint of the web app (`pnpm lint`, run by CI).
//
// typescript-eslint reads the TypeScript 6 API: `typescript` in package.json is the compatibility package
// `@typescript/typescript6`, while `tsc` is TypeScript 7 (`@typescript/native`), as the TypeScript 7.0
// release notes advise until typescript-eslint supports 7 ("Running side by side with TypeScript 6.0").
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two rules of hooks: a hook called conditionally, or an effect that misses a dependency, is a bug.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // The rest of the plugin's recommended set (refs, set-state-in-effect, purity, globals, immutability...)
      // are the rules of the React Compiler, which this app does not use. The code they flag (the player, the
      // queue, the countdown) works as it is; adopting them is a refactor of its own, tried in a browser.
    },
  },
);
