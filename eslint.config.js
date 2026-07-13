// @ts-check
// Flat config (ESLint 10 dropped .eslintrc support). Faithful port of the former
// .eslintrc.cjs: eslint:recommended + typescript-eslint recommended-type-checked + prettier.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Replaces the old `ignorePatterns`. A bare `ignores` key = global ignores.
  {
    // Browser userscripts under `assets/` ship to Tampermonkey, not the Node build — they use
    // browser/GM_* globals the Node lint config doesn't know, so they're linted by the browser, not
    // here. Prettier still formats them.
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/assets/**'],
  },
  js.configs.recommended,
  // recommendedTypeChecked is a superset of `recommended`; it carries the type-aware rules
  // the old config pulled in via `recommended-type-checked`.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.base.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  // Type-aware rules require a TS program; turn them off for any plain-JS files (e.g. this
  // config) so they don't trip "file not included in project" errors.
  {
    files: ['**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Must stay last: disables stylistic rules that conflict with Prettier.
  prettier,
);
