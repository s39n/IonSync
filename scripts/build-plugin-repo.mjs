// Assemble the standalone Obsidian plugin repo (the community-store release
// repo, s39n/ion-sync) from this monorepo. Combines the plugin-repo/ template
// shell with the plugin source, the shared protocol source, and the plugin
// metadata. Run locally to verify, and by the mirror-plugin workflow to publish.
//
//   node scripts/build-plugin-repo.mjs [--out <dir>]
//
// Default output: ./dist-plugin-repo (git-ignored). The mirror workflow points
// --out at a checkout of the release repo and keeps its .git.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const outArgIdx = process.argv.indexOf("--out");
const OUT = path.resolve(outArgIdx !== -1 ? process.argv[outArgIdx + 1] : path.join(ROOT, "dist-plugin-repo"));

const KEEP = new Set([".git", "node_modules"]);

function cleanOut() {
	if (!fs.existsSync(OUT)) { fs.mkdirSync(OUT, { recursive: true }); return; }
	for (const entry of fs.readdirSync(OUT)) {
		if (KEEP.has(entry)) continue;
		fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
	}
}

function copy(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(src, dest, { recursive: true });
}

cleanOut();

// 1. Template shell (package.json, tsconfig, esbuild/eslint config, workflows, README, .gitignore)
for (const entry of fs.readdirSync(path.join(ROOT, "plugin-repo"))) {
	copy(path.join(ROOT, "plugin-repo", entry), path.join(OUT, entry));
}

// 2. Plugin source (imports @ionsync/protocol unchanged; resolved via tsconfig paths + esbuild alias)
copy(path.join(ROOT, "packages", "plugin", "src"), path.join(OUT, "src"));

// 3. Shared protocol source, bundled alongside the plugin
copy(path.join(ROOT, "packages", "protocol", "src"), path.join(OUT, "src", "protocol"));

// 4. Plugin metadata + styles + license
for (const f of ["manifest.json", "versions.json", "styles.css"]) {
	copy(path.join(ROOT, "packages", "plugin", f), path.join(OUT, f));
}
copy(path.join(ROOT, "LICENSE"), path.join(OUT, "LICENSE"));

// 5. Keep package.json version in step with the plugin manifest (cosmetic; the
//    build and the release tag check both read manifest.json).
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf-8"));
const pkgPath = path.join(OUT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
pkg.version = manifest.version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");

console.log(`Assembled standalone plugin repo at ${OUT} (v${manifest.version})`);