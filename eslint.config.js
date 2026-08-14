import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
// TODO: eslint-plugin-solid appears unmaintained (last release 0.14.5, no eslint 10 support).
// Explore alternatives: fork the plugin, contribute a PR, or replace with manual rules.
// See: https://github.com/solidjs-community/eslint-plugin-solid
import solid from "eslint-plugin-solid";
import globals from "globals";

/**
 * Adapted from the papergamer SPA's config — same stack (SolidStart, Solid,
 * TypeScript), so the core carries over unchanged.
 *
 * Deliberately not carried over: eslint-plugin-boundaries (its ~290 lines
 * describe papergamer's lib-combat/lib-character domain map, which has no
 * counterpart here), @bufferings/eslint-plugin-neverthrow (this codebase does
 * not use neverthrow), and the Supabase and DialogSystem restrictions, which
 * name modules that do not exist in this repo.
 *
 * What *is* worth having here is the browser/Node boundary below, retargeted at
 * this repo's split.
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  /** @ts-expect-error - eslint-plugin-solid flat config types not compatible with tseslint.config() */
  solid.configs["flat/typescript"],
  {
    // Stale `// eslint-disable-...` directives that no longer suppress anything
    // become build errors. Pairs with the `--max-warnings 0` gate to keep lint
    // debt from accumulating.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      // Allow unused vars starting with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Off for the reason papergamer turned it off: the plugin is unmaintained
      // and overzealously flags `createSignal(props.X)` initial-value reads,
      // which this codebase also does on purpose in form components. The other
      // solid/* rules stay on — they have near-zero false-positive rates.
      "solid/reactivity": "off",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "no-unneeded-ternary": "error",
      "default-case-last": "error",
      "no-useless-rename": "error",
      "operator-assignment": ["error", "always"],
      "prefer-object-spread": "error",
      "object-shorthand": ["error", "always"],
      "prefer-arrow-callback": "error",

      // Deferred, not dismissed: 36 violations across 16 files, nearly all
      // better-sqlite3 row casts in src/server. Enabling it today would mean
      // either 36 inline disables or a typing pass that has nothing to do with
      // adopting a linter. Following papergamer's own rule for this config —
      // turn on what is already clean, and track the rest as its own piece of
      // work.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // The browser/Node boundary, retargeted.
  //
  // This is the rule most worth importing, because the failure it catches has
  // already happened here: a route imported one pure helper that lived in a
  // server module, better-sqlite3 came with it, the chunk threw on load, and
  // the sign-in form silently stopped working — no error, because no JavaScript
  // was left running to show one. scripts/check-client-bundle catches it at
  // build time by scanning the emitted assets; this catches it in the editor.
  //
  // Scope is narrower than papergamer's: src/routes/api/** are API routes that
  // never reach the browser and legitimately use node:crypto, so they are
  // excluded along with the other server-side trees.
  {
    files: ["src/routes/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: ["src/routes/api/**", "**/*.test.{ts,tsx}"],
    rules: {
      // The TypeScript-aware variant, not the core rule, because of
      // allowTypeImports. src/lib/api.ts deliberately types every call against
      // the real server signatures via `import type * as Admin from
      // "~/server/admin"` — TypeScript erases those, so nothing ships, and that
      // is exactly how the two halves are kept in step. The core rule sees only
      // the specifier and would flag the pattern the architecture is built on.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "fs", message: "Node fs cannot be used in browser code.", allowTypeImports: true },
            { name: "path", message: "Node path cannot be used in browser code.", allowTypeImports: true },
            { name: "os", message: "Node os cannot be used in browser code.", allowTypeImports: true },
          ],
          patterns: [
            {
              group: ["node:*"],
              message: "Node builtins cannot be used in browser code.",
              allowTypeImports: true,
            },
            {
              group: ["~/server/*", "~/server"],
              message:
                "Client code must not import values from src/server — it drags the whole module graph, including better-sqlite3, into the browser bundle. Call through src/lib/api.ts. `import type` is fine: it is erased.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },

  // Server-side trees: Node globals, no browser restrictions.
  {
    files: [
      "src/server/**/*.{ts,tsx}",
      "src/routes/api/**/*.{ts,tsx}",
      "src/middleware.ts",
      "src/entry-server.tsx",
      "scripts/**/*.{ts,js,mjs}",
      "e2e/**/*.{ts,tsx}",
      // Integration tests boot the built server and talk to it over HTTP, so
      // they are Node programs — including harness.ts, which is not a .test.ts
      // and would otherwise fall through to the browser defaults below.
      "tests/**/*.{ts,tsx}",
      "*.config.{ts,js,mjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Tests: Node host, and fixtures legitimately need `any`.
  {
    files: ["**/*.test.{ts,tsx}", "e2e/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-imports": "off",
    },
  },

  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      ".vinxi/**",
      ".output/**",
      ".uat-data/**",
      "data/**",
    ],
  },
);
