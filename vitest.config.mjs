import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@/lib": path.resolve(__dirname, "lib"),
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/tmp/**",
      "**/.next/**",
      "**/crud-operations.test.ts",
    ],
  },
});
