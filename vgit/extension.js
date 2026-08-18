const vscode = require('vscode');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const execFileAsync = util.promisify(execFile);
const FIELD_SEPARATOR = '\x1f';
const RECORD_SEPARATOR = '\x1e';

class CommitItem extends vscode.TreeItem {
  constructor(commit, filePath) {
    super(commit.subject || '(no commit message)', vscode.TreeItemCollapsibleState.None);
    this.commit = commit;
    this.filePath = filePath;
    this.description = `${commit.shortHash} • ${commit.relativeDate}`;
    this.tooltip = new vscode.MarkdownString(
      `**${escapeMarkdown(commit.subject || '(no commit message)')}**\n\n` +
      `$(person) ${escapeMarkdown(commit.author)}  \n` +
      `$(calendar) ${escapeMarkdown(commit.date)}  \n` +
      `\`${commit.hash}\``
    );
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = filePath ? 'vgit.fileCommit' : 'vgit.commit';
    this.command = {
      command: 'vgit.openRemote',
      title: 'Open on Remote',
      arguments: [this]
    };
    this.accessibilityInformation = {
      label: `${commit.subject}, by ${commit.author}, ${commit.relativeDate}`
    };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(label, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class HistoryProvider {
  constructor(fileHistory = false) {
    this.fileHistory = fileHistory;
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  }

  refresh() {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren() {
    const target = this.fileHistory ? await activeFileTarget() : await repositoryTarget();
    if (!target) {
      return [new MessageItem(
        this.fileHistory ? 'Open a file to see its history' : 'Open a folder containing a Git repository',
        this.fileHistory ? 'file' : 'folder-opened'
      )];
    }

    const config = vscode.workspace.getConfiguration('vgit');
    const args = [
      'log',
      `--max-count=${config.get('maxCommits', 100)}`,
      `--pretty=format:%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ad${FIELD_SEPARATOR}%ar${RECORD_SEPARATOR}`,
      '--date=format:%Y-%m-%d %H:%M'
    ];
    if (config.get('showAllBranches', false)) args.splice(1, 0, '--all');
    if (this.fileHistory) args.push('--follow', '--', target.filePath);

    try {
      const { stdout } = await runGit(target.repository, args);
      const commits = stdout
        .split(RECORD_SEPARATOR)
        .map(record => record.trim())
        .filter(Boolean)
        .map(record => {
          const [hash, shortHash, subject, author, date, relativeDate] = record.split(FIELD_SEPARATOR);
          return { hash, shortHash, subject, author, date, relativeDate };
        });

      if (!commits.length) {
        return [new MessageItem(
          this.fileHistory ? 'This file has no committed history' : 'This repository has no commits',
          'git-commit'
        )];
      }
      return commits.map(commit => new CommitItem(commit, target.filePath));
    } catch (error) {
      return [new MessageItem(`Unable to read commits: ${gitError(error)}`, 'error')];
    }
  }
}

async function repositoryTarget() {
  const repository = await findRepository();
  return repository ? { repository } : undefined;
}

async function activeFileTarget() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') return undefined;

  const repository = await findRepositoryForPath(uri.fsPath);
  if (!repository) return undefined;
  const filePath = path.relative(repository, uri.fsPath);
  if (!filePath || filePath.startsWith('..') || path.isAbsolute(filePath)) return undefined;
  return { repository, filePath };
}

async function findRepository() {
  const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? vscode.window.activeTextEditor.document.uri.fsPath
    : undefined;
  if (activePath) {
    const repository = await findRepositoryForPath(activePath);
    if (repository) return repository;
  }

  for (const folder of vscode.workspace.workspaceFolders || []) {
    const repository = await findRepositoryForPath(folder.uri.fsPath);
    if (repository) return repository;
  }
  return undefined;
}

async function findRepositoryForPath(filePath) {
  try {
    const { stdout } = await runGit(filePath, ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function runGit(location, args) {
  let cwd = location;
  try {
    if (!fs.statSync(location).isDirectory()) cwd = path.dirname(location);
  } catch {
    cwd = path.dirname(location);
  }
  return execFileAsync('git', ['-C', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

async function openRemote(item) {
  if (!item?.commit) return;
  const target = item.filePath ? await activeFileTarget() : await repositoryTarget();
  if (!target) return;

  try {
    const { stdout } = await runGit(target.repository, ['remote', 'get-url', 'origin']);
    const baseUrl = remoteWebUrl(stdout.trim());
    if (!baseUrl) throw new Error('The origin remote is not a supported web URL');

    const url = item.filePath
      ? `${baseUrl}/blob/${item.commit.hash}/${encodePath(item.filePath)}`
      : `${baseUrl}/commit/${item.commit.hash}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    vscode.window.showErrorMessage(`VGit could not open the remote URL: ${gitError(error)}`);
  }
}

function remoteWebUrl(remote) {
  const scpMatch = remote.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) return `https://${scpMatch[1]}/${stripGitSuffix(scpMatch[2])}`;

  try {
    const url = new URL(remote);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    const protocol = url.protocol === 'http:' ? 'http:' : 'https:';
    return `${protocol}//${url.host}/${stripGitSuffix(url.pathname.replace(/^\//, ''))}`;
  } catch {
    return undefined;
  }
}

function stripGitSuffix(value) {
  return value.replace(/\.git\/?$/, '').replace(/\/$/, '');
}

function encodePath(filePath) {
  return filePath.split(/[\\/]/).map(encodeURIComponent).join('/');
}

async function copyHash(item) {
  if (!item?.commit) return;
  await vscode.env.clipboard.writeText(item.commit.hash);
  vscode.window.setStatusBarMessage(`Copied ${item.commit.shortHash}`, 2000);
}

function selectedLineRange(editor) {
  const selection = editor.selection;
  const start = selection.isEmpty ? selection.active.line + 1 : selection.start.line + 1;
  const endsAtLineStart = !selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line;
  const end = selection.isEmpty ? start : selection.end.line + (endsAtLineStart ? 0 : 1);
  return { start, end };
}

async function copyPathWithLine() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;

  const { start, end } = selectedLineRange(editor);
  const lineRange = start === end ? `${start}` : `${start}-${end}`;
  const value = `${editor.document.uri.fsPath}:${lineRange}`;
  await vscode.env.clipboard.writeText(value);
  vscode.window.setStatusBarMessage(`Copied ${value}`, 2000);
}

async function copyRemoteFileUrl() {
  const editor = vscode.window.activeTextEditor;
  const target = await activeFileTarget();
  if (!editor || !target) return;

  try {
    const [{ stdout: remote }, { stdout: revision }] = await Promise.all([
      runGit(target.repository, ['remote', 'get-url', 'origin']),
      runGit(target.repository, ['rev-parse', 'HEAD'])
    ]);
    const baseUrl = remoteWebUrl(remote.trim());
    if (!baseUrl) throw new Error('The origin remote is not a supported web URL');

    const { start, end } = selectedLineRange(editor);
    const lineAnchor = start === end ? `#L${start}` : `#L${start}-L${end}`;
    const value = `${baseUrl}/blob/${revision.trim()}/${encodePath(target.filePath)}${lineAnchor}`;
    await vscode.env.clipboard.writeText(value);
    vscode.window.setStatusBarMessage(`Copied ${value}`, 2000);
  } catch (error) {
    vscode.window.showErrorMessage(`VGit could not copy the remote file URL: ${gitError(error)}`);
  }
}

function gitError(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n').pop();
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
}

function activate(context) {
  const commitsProvider = new HistoryProvider();
  const fileHistoryProvider = new HistoryProvider(true);
  const refresh = () => {
    commitsProvider.refresh();
    fileHistoryProvider.refresh();
  };

  context.subscriptions.push(
    vscode.window.createTreeView('vgit.commits', { treeDataProvider: commitsProvider }),
    vscode.window.createTreeView('vgit.fileHistory', { treeDataProvider: fileHistoryProvider }),
    commitsProvider.onDidChangeTreeDataEmitter,
    fileHistoryProvider.onDidChangeTreeDataEmitter,
    vscode.commands.registerCommand('vgit.refresh', refresh),
    vscode.commands.registerCommand('vgit.openRemote', openRemote),
    vscode.commands.registerCommand('vgit.copyHash', copyHash),
    vscode.commands.registerCommand('vgit.copyPathWithLine', copyPathWithLine),
    vscode.commands.registerCommand('vgit.copyRemoteFileUrl', copyRemoteFileUrl),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vgit')) refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => fileHistoryProvider.refresh())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
