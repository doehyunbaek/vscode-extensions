# VS Code Extensions

Monorepo for the following VS Code extensions:

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

Package an extension with `npm run package:vgit` or `npm run package:vsync`.
