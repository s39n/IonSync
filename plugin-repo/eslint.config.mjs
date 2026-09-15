// ESLint flat config for the IonSync Obsidian plugin (standalone release repo).
//
// This repo contains ONLY the plugin (and the shared protocol source it
// bundles) — no Node server — so the Obsidian community reviewer's ruleset
// applies cleanly to everything here. We run that same recommended set locally
// (eslint-plugin-obsidianmd: obsidian rules + typescript-eslint type-checked)
// to reproduce the reviewer before publishing.
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{
		ignores: [
			"**/node_modules/**",
			"**/main.js",
			"**/*.d.ts",
			"**/*.mjs",
		],
	},

	...obsidianmd.configs.recommended,

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
];
