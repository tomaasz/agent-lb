import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.git/**",
      "**/docker/**",
      "**/.agents/**",
      "**/.claude/**",
      "**/.ai/**",
      "**/.ai-team/**"
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024
      }
    },
    rules: {
      // Terminal title and TUI intentionally use control character regexes (\x1b, etc.)
      "no-control-regex": "off",
      "no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ],
      "no-console": "off",
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-constant-condition": ["warn", { "checkLoops": false }],
      "no-useless-escape": "warn"
    }
  },
  {
    files: ["setup/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node
      }
    }
  }
];
