# IonSync Obsidian Plugin

IonSync is a high-performance, real-time synchronization plugin for Obsidian. It utilizes a custom WebSocket-based protocol to sync vault data across devices with a focus on speed and reliability.

## Project Overview

- **Core Technology:** TypeScript, [esbuild](https://esbuild.github.io/), [Obsidian API](https://github.com/obsidianmd/obsidian-api).
- **Architecture:**
  - `src/main.ts`: Plugin entry point, settings management, and UI integration.
  - `src/XSync.ts`: Orchestrates the sync lifecycle, handles vault events, and manages the sync state.
  - `src/WsManager.ts`: Manages WebSocket connectivity, authentication (SHA-256 challenge-response), and version checking.
  - `src/Storage.ts`: Handles local metadata persistence and provides an abstraction layer over the Obsidian vault via `FSAdapter.ts`.
  - `src/XNotify.ts`: Manages status bar items, mobile indicators, and user notifications.
  - `src/ExclusionFilter.ts`: Handles file exclusion logic based on user settings.

## Building and Running

The project uses `npm` for task management and `esbuild` for bundling.

- **Build for Production:**
  ```bash
  npm run build
  ```
  This command runs the TypeScript compiler (`tsc`) for type checking and then bundles the code into `main.js` using `esbuild` with production optimizations.

- **Development Mode (Watch):**
  ```bash
  npm run dev
  ```
  Starts `esbuild` in watch mode. It will re-bundle the project automatically when source files change.

- **Type Checking:**
  ```bash
  npm run typecheck
  ```
  Runs `tsc` to verify type safety without emitting files.

## Development Conventions

- **Bundling:** All source files are bundled into a single `main.js` file in the root directory, as required by Obsidian.
- **Variable Injection:** The build script (`esbuild.config.mjs`) injects `__IONSYNC_VERSION__` and `__IONSYNC_BUILD__` into the bundle. Always use `JSON.stringify()` when replacing these placeholders in the build script to ensure they are treated as string literals.
- **File I/O:** Use the `Storage` and `FSAdapter` classes for interacting with the vault to ensure consistent path normalization and metadata tracking.
- **Async/Await:** Prefer `async/await` for all asynchronous operations, particularly when interacting with the Obsidian Vault or Network APIs.
- **Icons:** The plugin uses a custom SVG "Atom" icon defined in `IonSyncPlugin.getSVGIcon()`.
- **Testing:** New features or bug fixes should be verified by building the plugin and, where possible, simulating sync events or vault modifications.
