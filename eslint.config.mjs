import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      "dist/**",
      "worker/dist/**",
      "*.config.*",
    ],
  },

  // 严格模式：禁止 eslint-disable 注释
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  // 基础规则
  js.configs.recommended,

  // TypeScript 规则
  ...tseslint.configs.recommended,

  // React Hooks 规则
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // 项目自定义规则
  {
    rules: {
      // 迁移期间关闭 any 检查（130+ 处，渐进修复）
      "@typescript-eslint/no-explicit-any": "off",
      // 允许未使用的变量（以下划线开头的忽略）
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      // 允许 require（动态导入场景）
      "@typescript-eslint/no-require-imports": "off",
      // 允许空 catch
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 允许 console（服务端日志）
      "no-console": "off",
    },
  },

  // 测试文件宽松规则
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-unused-vars": "off",
    },
  },
);
