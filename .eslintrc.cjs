module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ["./tsconfig.base.json"],
    sourceType: "module"
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier"
  ],
  ignorePatterns: ["dist", "build", "node_modules"],
  rules: {
    "@typescript-eslint/explicit-module-boundary-types": "off"
  }
};
