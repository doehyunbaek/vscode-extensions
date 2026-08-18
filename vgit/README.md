# VGit

A lightweight VS Code extension that displays commits from the current workspace repository.

## Features

- Repository commit history in the Source Control panel
- File history for the currently active file, including renames
- Subject, short hash, relative date, author, and timestamp
- Open commits—and files at their selected revision—on the `origin` remote
- Copy full commit hashes from the item toolbar
- Copy the active file's absolute path and cursor line with `Ctrl+C`
- Copy the active file's remote URL and selected lines with `Ctrl+Cmd+C` on macOS
- Supports multi-root workspaces by preferring the active editor's repository
- Optional history across all branches

## Run locally

1. Open this folder in VS Code:
   ```sh
   code ~/vgit
   ```
2. Press `F5` to launch an Extension Development Host.
3. Open a Git repository in the new window.
4. Open the **Source Control** panel and expand **Commits** or **File History**.

## Settings

- `vgit.maxCommits`: Maximum commits displayed (default: `100`)
- `vgit.showAllBranches`: Include all local and remote branches (default: `false`)

## Package

```sh
npm run package
```
