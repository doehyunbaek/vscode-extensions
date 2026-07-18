# VSync

A VS Code extension that synchronizes files by preserving their paths relative to your home directory.

## Repositories

- **Local repository:** `~/.vsync` by default
- **Remote repository:** a GitHub repository you select
- **Remote directory:** the remote repository root by default

The local and remote repositories mirror home-relative paths. For example:

```text
Original:      ~/.pi/agent/models.json
Local mirror:  ~/.vsync/.pi/agent/models.json
Remote:        .pi/agent/models.json
```

The `.git` directory in the local repository is ignored.

## Setup

1. Open the **VSYNC** view.
2. Optionally run **VSync: Select Local Repository** to replace the default `~/.vsync` mirror.
3. Run **VSync: Select Remote Repository** and choose a GitHub repository.
4. Open a file under your home directory and run **VSync: Add File**.
5. Run **VSync: Push Files**.

The extension authenticates through VS Code's built-in GitHub authentication provider and does not store a token.

## Behavior

- **Add File** copies the active file into the local repository at its home-relative path.
- **Push Files** refreshes each mirrored file from its home location when available, then uploads it.
- **Pull Files** downloads each remote file into the local mirror and restores it to the corresponding path under your home directory.
- **Remove File** deletes the mirror and remote copy but leaves the original home file untouched.
- Files outside your home directory cannot be added because they do not have a safe home-relative destination.

## VSYNC view

The **FILES** view lists all mirrored files. Select a file to open its mirror, or hover to see the original home path, local mirror, and remote path.

Toolbar actions are ordered as Push, Pull, Refresh, Local Repository, and Remote Repository.

## Commands

- **VSync: Add File** — add the active saved file while preserving its home-relative path.
- **VSync: Remove File** — remove a selected file from the local mirror and GitHub remote, without deleting the original home file.
- **VSync: Push Files** — upload all mirrored files.
- **VSync: Pull Files** — download files and restore their home-relative destinations.
- **VSync: Refresh Files** — refresh the files view.
- **VSync: Select Local Repository** — choose the local mirror folder.
- **VSync: Select Remote Repository** — choose the GitHub remote repository.

## Settings

- `piConfigVsync.local.repository` (default `~/.vsync`)
- `piConfigVsync.github.remoteRepository` — repository in `owner/repository` form
- `piConfigVsync.github.branch` (default `main`; changed to a selected repository's default branch)
- `piConfigVsync.github.directory` (default empty, meaning the repository root)

## Development

```sh
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host, or package/install it:

```sh
npm run package
code --install-extension pi-config-vsync-0.1.0.vsix
```
