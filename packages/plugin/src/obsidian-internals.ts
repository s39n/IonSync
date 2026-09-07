/**
 * Typed accessors for Obsidian APIs that are real at runtime but not in the
 * public typings. Every unavoidable cast to an untyped host object is confined
 * to this module, so the rest of the plugin stays fully type-checked instead of
 * reaching through `any` at each call site.
 */
import type { App, Vault, EventRef, TAbstractFile } from "obsidian";

/** `app.plugins` — the community-plugin manager (enable/disable/manifests). */
export interface InternalPluginsApi {
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
  loadManifests?(): Promise<void>;
  enabledPlugins?: Set<string>;
  manifests?: Record<string, unknown>;
}

/** `app.customCss` — live theme/snippet reloading. */
export interface InternalCustomCssApi {
  requestLoadTheme?(): void;
  readCssSources?(): void;
}

/** `app.setting` — the settings window. */
export interface InternalSettingApi {
  open?(): void;
  openTabById?(id: string): void;
}

interface AppInternals {
  plugins: InternalPluginsApi;
  customCss?: InternalCustomCssApi;
  setting?: InternalSettingApi;
}

/** Access the undocumented members of the Obsidian `App` object, typed. */
export function appInternals(app: App): AppInternals {
  return app as unknown as AppInternals;
}

/**
 * Register a handler for the undocumented vault "raw" event, which — unlike the
 * typed create/modify/delete events — also fires for files under the config dir.
 */
export type RawEventCallback = (path: string) => void;
interface VaultRawEvents {
  on(name: "raw", callback: RawEventCallback): EventRef;
}
export function vaultOnRaw(vault: Vault, callback: RawEventCallback): EventRef {
  return (vault as unknown as VaultRawEvents).on("raw", callback);
}

/**
 * Register one of the typed vault file events with a single unified callback.
 * The public `Vault.on` overloads take a per-event callback shape; this wraps
 * them so the same `(file, ...args)` handler can be registered for any of the
 * four actions without an `any` cast at the call site.
 */
export type VaultFileEvent = "create" | "modify" | "delete" | "rename";
export type VaultFileEventCallback = (file: TAbstractFile, ...args: unknown[]) => void;
interface VaultTypedEvents {
  on(name: VaultFileEvent, callback: VaultFileEventCallback): EventRef;
}
export function vaultOnFileEvent(
  vault: Vault,
  name: VaultFileEvent,
  callback: VaultFileEventCallback,
): EventRef {
  return (vault as unknown as VaultTypedEvents).on(name, callback);
}
