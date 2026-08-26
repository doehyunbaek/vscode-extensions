# VS Code Extensions

Monorepo for the following VS Code extensions:

- [`pi`](./pi) — integrate the Pi coding agent with VS Code ([source repository](https://github.com/doehyunbaek/pi-vscode))
- [`vaper`](./vaper) — view PDF files in an editor tab
- [`vgit`](./vgit) — browse Git history in the VS Code sidebar
- [`vsync`](./vsync) — synchronize Pi configuration through GitHub

## Development

Install workspace dependencies:

```sh
npm install
```

Check both extensions:

```sh
npm run check
```

Package an extension with `npm run package:pi`, `npm run package:vaper`, `npm run package:vgit`, or `npm run package:vsync`.
