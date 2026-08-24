# VS Code Extensions

Monorepo for the following VS Code extensions:

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

Package an extension with `npm run package:vaper`, `npm run package:vgit`, or `npm run package:vsync`.
