import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**", "test-results/**"]
  }
});
