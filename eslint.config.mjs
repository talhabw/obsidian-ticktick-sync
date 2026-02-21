import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["node_modules/**", "example/**", "main.js"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        window: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
]);
