# IonSync (Obsidian plugin)

Self-hosted vault synchronization for [Obsidian](https://obsidian.md). IonSync
keeps your notes in sync across devices through a server you run yourself, with
optional end-to-end encryption.

> This repository is the **published plugin** for the Obsidian community store.
> It is generated from the [IonSync monorepo](https://github.com/s39n/IonSync),
> where the server and full development history live. The `src/protocol/` folder
> is the shared wire-protocol source that the plugin bundles.

## Install

- **Community store:** search for "IonSync" in Obsidian - Settings - Community
  plugins.
- **Manual:** download `main.js`, `manifest.json`, and `styles.css` from the
  latest [release](../../releases) into
  `<vault>/.obsidian/plugins/ion-sync/`.

You also need the IonSync server running somewhere you control. See the
[monorepo](https://github.com/s39n/IonSync) for server setup.

## Build from source

```bash
npm ci
npm run build   # produces main.js
```

The build is reproducible: a clean checkout of a given tag always produces a
byte-identical `main.js`, matching the attested release asset.

## License

MIT (c) Sean Richards