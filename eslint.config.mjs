import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import security from "eslint-plugin-security";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import sonarjs from "eslint-plugin-sonarjs";

export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      "dist/**",
      "worker/dist/**",
      "src/generated/**",
      "*.config.*",
      "scripts/**",
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

  // eslint-plugin-security：检测常见安全反模式
  {
    plugins: { security },
    rules: {
      "security/detect-buffer-noassert": "warn",
      "security/detect-child-process": "warn",
      "security/detect-disable-mustache-escape": "warn",
      "security/detect-eval-with-expression": "warn",
      "security/detect-new-buffer": "warn",
      "security/detect-no-csrf-before-method-override": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-non-literal-require": "warn",
      "security/detect-object-injection": "off", // 误报率高，TS 已有类型保护
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-bidi-characters": "warn",
      "security/detect-non-literal-fs-filename": "off", // 动态路径是本项目的正常模式（i18n 工具等）
      "security/detect-non-literal-regexp": "off", // 动态正则用于 i18n 检查工具，非用户输入
    },
  },

  // eslint-plugin-no-unsanitized：禁止未净化的 HTML 注入
  {
    plugins: { "no-unsanitized": noUnsanitized },
    rules: {
      "no-unsanitized/property": "error",
      "no-unsanitized/method": "error",
    },
  },

  // eslint-plugin-sonarjs：仅启用安全相关规则（跳过代码质量/复杂度/测试规则避免性能问题）
  {
    plugins: { sonarjs },
    rules: {
      // 安全
      "sonarjs/no-hardcoded-passwords": "error",
      "sonarjs/no-hardcoded-secrets": "error",
      "sonarjs/hashing": "error",
      "sonarjs/no-weak-keys": "error",
      "sonarjs/insecure-jwt-token": "error",
      "sonarjs/insecure-cookie": "error",
      "sonarjs/cookie-no-httponly": "error",
      "sonarjs/cors": "error",
      "sonarjs/csrf": "error",
      "sonarjs/x-powered-by": "error",
      "sonarjs/no-clear-text-protocols": "error",
      "sonarjs/no-mime-sniff": "error",
      "sonarjs/no-referrer-policy": "error",
      "sonarjs/strict-transport-security": "error",
      "sonarjs/content-security-policy": "error",
      "sonarjs/content-length": "error",
      "sonarjs/disabled-resource-integrity": "error",
      "sonarjs/no-weak-cipher": "error",
      "sonarjs/encryption-secure-mode": "error",
      "sonarjs/production-debug": "error",
      "sonarjs/pseudo-random": "off", // Math.random 用于密钥轮询，非加密场景
      "sonarjs/no-unsafe-unzip": "off",
      "sonarjs/unverified-certificate": "error",
      "sonarjs/unverified-hostname": "error",
      "sonarjs/post-message": "warn",
      "sonarjs/no-os-command-from-path": "warn",
      "sonarjs/no-clear-text-protocols": "error",
      "sonarjs/no-session-cookies-on-static-assets": "error",
      "sonarjs/file-uploads": "warn",
      "sonarjs/file-permissions": "warn",
      "sonarjs/publicly-writable-directories": "warn",
      "sonarjs/disabled-auto-escaping": "warn",
      "sonarjs/link-with-target-blank": "warn",
      "sonarjs/dynamically-constructed-templates": "warn",

      // 正则安全
      "sonarjs/no-invalid-regexp": "error",
      "sonarjs/no-misleading-character-class": "error",
      "sonarjs/no-empty-character-class": "error",
      "sonarjs/no-control-regex": "error",
      "sonarjs/regex-complexity": "warn",
      "sonarjs/slow-regex": "warn",
      "sonarjs/anchor-precedence": "warn",

      // 少量高价值代码质量规则
      "sonarjs/no-fallthrough": "error",
      "sonarjs/no-extra-arguments": "error",
      "sonarjs/no-useless-catch": "error",
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-useless-increment": "error",
      "sonarjs/no-misleading-array-reverse": "error",
      "sonarjs/no-array-delete": "error",
      "sonarjs/no-delete-var": "error",
      "sonarjs/no-implicit-global": "error",
      "sonarjs/empty-string-repetition": "error",
      "sonarjs/non-existent-operator": "error",
      "sonarjs/void-use": "error",
      "sonarjs/no-unthrown-error": "error",
      "sonarjs/unused-import": "error",
      "sonarjs/no-literal-call": "error",
      "sonarjs/no-async-constructor": "error",
      "sonarjs/no-useless-intersection": "error",
      "sonarjs/no-uniq-key": "error",
      "sonarjs/no-hook-setter-in-body": "error",
      "sonarjs/no-useless-react-setstate": "error",
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
      "@typescript-eslint/no-explicit-any": "off",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-hardcoded-secrets": "off",
      "sonarjs/pseudo-random": "off",
      "sonarjs/no-identical-expressions": "off",
      "sonarjs/no-identical-conditions": "off",
      "sonarjs/no-duplicated-branches": "off",
      "sonarjs/no-all-duplicated-branches": "off",
      "sonarjs/no-useless-increment": "off",
      "sonarjs/no-misleading-array-reverse": "off",
      "sonarjs/no-array-delete": "off",
      "sonarjs/no-delete-var": "off",
      "sonarjs/no-implicit-global": "off",
      "sonarjs/empty-string-repetition": "off",
      "sonarjs/non-existent-operator": "off",
      "sonarjs/void-use": "off",
      "sonarjs/no-unthrown-error": "off",
      "sonarjs/unused-import": "off",
      "sonarjs/no-literal-call": "off",
      "sonarjs/no-async-constructor": "off",
      "sonarjs/no-useless-intersection": "off",
      "sonarjs/no-uniq-key": "off",
      "sonarjs/no-hook-setter-in-body": "off",
      "sonarjs/no-useless-react-setstate": "off",
      "sonarjs/regex-complexity": "off",
      "sonarjs/slow-regex": "off",
      "sonarjs/anchor-precedence": "off",
      "sonarjs/no-invalid-regexp": "off",
      "sonarjs/no-misleading-character-class": "off",
      "sonarjs/no-empty-character-class": "off",
      "sonarjs/no-control-regex": "off",
      "sonarjs/dynamically-constructed-templates": "off",
      "sonarjs/production-debug": "off",
      "sonarjs/no-hardcoded-ip": "off",
      "sonarjs/hashing": "off",
      "sonarjs/no-weak-keys": "off",
      "sonarjs/insecure-jwt-token": "off",
      "sonarjs/insecure-cookie": "off",
      "sonarjs/cookie-no-httponly": "off",
      "sonarjs/cors": "off",
      "sonarjs/csrf": "off",
      "sonarjs/x-powered-by": "off",
      "sonarjs/no-clear-text-protocols": "off",
      "sonarjs/no-mime-sniff": "off",
      "sonarjs/no-referrer-policy": "off",
      "sonarjs/strict-transport-security": "off",
      "sonarjs/content-security-policy": "off",
      "sonarjs/content-length": "off",
      "sonarjs/disabled-resource-integrity": "off",
      "sonarjs/no-weak-cipher": "off",
      "sonarjs/encryption-secure-mode": "off",
      "sonarjs/unverified-certificate": "off",
      "sonarjs/unverified-hostname": "off",
      "sonarjs/post-message": "off",
      "sonarjs/no-os-command-from-path": "off",
      "sonarjs/no-session-cookies-on-static-assets": "off",
      "sonarjs/file-uploads": "off",
      "sonarjs/file-permissions": "off",
      "sonarjs/publicly-writable-directories": "off",
      "sonarjs/disabled-auto-escaping": "off",
      "sonarjs/link-with-target-blank": "off",
    },
  },
);
