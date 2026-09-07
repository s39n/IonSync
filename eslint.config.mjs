// ESLint flat config for IonSync.
//
// The Obsidian community-plugin reviewer lints with eslint-plugin-obsidianmd
// (obsidian rules + typescript-eslint type-checked). We apply that same
// recommended set across the repo so we reproduce the reviewer locally.
//
// The server and protocol packages are Node code, not a mobile plugin, so the
// obsidian/mobile-specific rules (no-nodejs-modules, prefer-window-timers,
// no-global-this, hardcoded-config-path, DOM helpers, no-console) do not apply
// there and are turned off for those paths. Genuine type-safety rules still run.
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/main.js",
      "packages/server/client/**",
      "**/*.d.ts",
      "**/*.mjs",
      "**/test/**",
      "**/*.test.ts",
      "**/scripts/**",
      "**/*.config.ts",
      "**/config.example.js",
    ],
  },

  // Mirror the Obsidian community reviewer across the repo.
  ...obsidianmd.configs.recommended,

  // Type-checked rules need access to the TypeScript projects.
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript's own checker reports undefined identifiers; the core
      // no-undef rule only produces false positives on typed code.
      "no-undef": "off",
    },
  },

  // Server + protocol are Node, not a mobile plugin: drop the mobile/DOM rules.
  {
    files: ["packages/server/**/*.ts", "packages/protocol/**/*.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-global-this": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-static-styles-assignment": "off",
      "obsidianmd/prefer-create-el": "off",
      "obsidianmd/validate-manifest": "off",
      "obsidianmd/validate-license": "off",
      // Server logging is legitimate; the wrapper only re-emits no-console here.
      "obsidianmd/rule-custom-message": "off",
      "no-console": "off",
      // The server loads its own config file via dynamic import() from a
      // path.resolve'd local path — a Node pattern, not a browser XSS sink.
      "no-unsanitized/method": "off",
    },
  },
];
