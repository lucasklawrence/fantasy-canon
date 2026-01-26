const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    globals: true,
    include: ["packages/**/__tests__/**/*.test.ts", "apps/**/__tests__/**/*.test.ts"]
  }
});
