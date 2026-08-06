import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "**/*.config.js", "src/test/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    settings: { react: { version: "19" } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // TypeScript's own compiler resolves identifiers, and `no-undef` is a JS
      // rule that can't see the type namespace — it flags `React.PointerEvent`
      // in type positions under the JSX transform, where no runtime `React`
      // binding exists. typescript-eslint disables it on TS for this reason.
      "no-undef": "off",
      // Empty grouped `case` labels that share one body are the intent here,
      // not a missing `break`; the default only flags them because a comment
      // sits between two of them. Cases with statements are still checked.
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // --- React Compiler rules, warned rather than errored ---
      //
      // `eslint-plugin-react-hooks` 7 folded the compiler's own analyses
      // into `recommended`. They are worth having: every one of these is
      // a pattern that stops the compiler memoizing a component, and
      // several are latent bugs under concurrent rendering.
      //
      // They are warnings because there are 68 of them, 29 of those in
      // `EditorCanvas` alone, and fixing a ref-during-render or a
      // setState-in-effect properly means changing when work happens —
      // not something to do blind across a canvas whose interactive
      // paths the unit tests do not reach. Warning keeps every site
      // visible and countable instead of hidden behind a disable.
      //
      // The classic rules (`rules-of-hooks`, `exhaustive-deps`) stay
      // errors and still pass, as do the compiler rules not listed here
      // — so a new violation of those fails the build normally.
      //
      // Burn these down per-file, then delete the entry.
      "react-hooks/set-state-in-effect": "warn", // 32
      "react-hooks/refs": "warn", // 29
      "react-hooks/immutability": "warn", // 3
      "react-hooks/globals": "warn", // 2
      "react-hooks/static-components": "warn", // 1
      "react-hooks/purity": "warn", // 1
    },
  },
  prettier,
];
