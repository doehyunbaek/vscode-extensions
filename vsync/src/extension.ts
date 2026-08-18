import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";

const IGNORED_DIRECTORIES = new Set([".git"]);

type GitHubContent = {
  type?: "file" | "dir";
  name?: string;
  path?: string;
  content?: string;
  encoding?: string;
  sha?: string;
};

type GitHubRepository = {
  full_name: string;
  default_branch: string;
  private: boolean;
};

type GitReference = {
  object: { sha: string };
};

type GitCommit = {
  sha: string;
  tree: { sha: string };
};

type GitObject = {
  sha: string;
};

type RemoteRepository = {
  owner: string;
  repository: string;
  branch: string;
  directory: string;
};

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith(`~${path.sep}`)) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function localRepositoryPath(): string {
  const configured = vscode.workspace
    .getConfiguration("piConfigVsync")
    .get<string>("local.repository", "~/.vsync");
  return expandHome(configured || "~/.vsync");
}

function localUri(relativePath = ""): vscode.Uri {
  const root = localRepositoryPath();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Invalid local path: ${relativePath}`);
  }
  return vscode.Uri.file(resolved);
}

function homeRelativePath(uri: vscode.Uri): string {
  const home = path.resolve(os.homedir());
  const source = path.resolve(uri.fsPath);
  const relativePath = path.relative(home, source);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The active file must be inside your home directory.");
  }
  return relativePath.split(path.sep).join("/");
}

function homeUri(relativePath: string): vscode.Uri {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(home, relativePath);
  if (!resolved.startsWith(`${home}${path.sep}`)) throw new Error(`Invalid home-relative path: ${relativePath}`);
  return vscode.Uri.file(resolved);
}

async function listLocalFiles(relativeDirectory = ""): Promise<string[]> {
  const directory = localUri(relativeDirectory);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return [];
    throw error;
  }

  const files: string[] = [];
  for (const [name, type] of entries) {
    if (type === vscode.FileType.Directory && IGNORED_DIRECTORIES.has(name)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (type === vscode.FileType.Directory) files.push(...await listLocalFiles(relativePath));
    else if (type === vscode.FileType.File) files.push(relativePath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

class VSyncFilesProvider implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly configurationListener: vscode.Disposable;

  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    this.resetWatcher();
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("piConfigVsync.local.repository")) this.resetWatcher();
      if (event.affectsConfiguration("piConfigVsync")) this.refresh();
    });
  }

  private resetWatcher(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(localRepositoryPath(), "**/*"),
    );
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(element?: string): Promise<string[]> {
    return element ? [] : listLocalFiles();
  }

  getTreeItem(relativePath: string): vscode.TreeItem {
    const uri = localUri(relativePath);
    const remoteRepository = configuredRemoteRepository();
    const item = new vscode.TreeItem(relativePath, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.contextValue = "vsyncFile";
    item.description = "in local repository";
    item.iconPath = vscode.ThemeIcon.File;
    const destination = homeUri(relativePath);
    item.tooltip = remoteRepository
      ? `Home file: ${destination.fsPath}\nVSync mirror: ${uri.fsPath}\nRemote: ${remoteRepository.owner}/${remoteRepository.repository}/${remotePath(relativePath, remoteRepository)} (${remoteRepository.branch})\nSync status has not been compared.`
      : `Home file: ${destination.fsPath}\nVSync mirror: ${uri.fsPath}\nNo remote repository selected. Sync status is unavailable.`;
    item.command = { command: "vscode.open", title: "Open VSync File", arguments: [uri] };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
    this.watcher?.dispose();
    this.configurationListener.dispose();
  }
}

let filesProvider: VSyncFilesProvider | undefined;

function configuredRemoteRepository(): RemoteRepository | undefined {
  const config = vscode.workspace.getConfiguration("piConfigVsync");
  const fullName = config.get<string>("github.remoteRepository", "").trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(fullName);
  if (!match) return undefined;

  return {
    owner: match[1],
    repository: match[2],
    branch: config.get<string>("github.branch", "main"),
    directory: config.get<string>("github.directory", ""),
  };
}

function remotePath(relativePath: string, remoteRepository: RemoteRepository): string {
  const directory = remoteRepository.directory.replace(/^\/+|\/+$/g, "");
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return directory ? `${directory}/${normalized}`.replace(/\/$/, "") : normalized;
}

async function token(): Promise<string> {
  const session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
  return session.accessToken;
}

async function githubRequest<T>(endpoint: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${response.statusText}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function addCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No file is open in the active editor.");

  const source = editor.document.uri;
  if (source.scheme !== "file" || editor.document.isUntitled) {
    throw new Error("The active editor must contain a saved local file.");
  }

  if (editor.document.isDirty) await editor.document.save();

  const repositoryRoot = path.resolve(localRepositoryPath());
  const sourcePath = path.resolve(source.fsPath);
  if (sourcePath === repositoryRoot || sourcePath.startsWith(`${repositoryRoot}${path.sep}`)) {
    filesProvider?.refresh();
    void vscode.window.showInformationMessage("This file is already in the VSync local repository.");
    return;
  }

  const relativePath = homeRelativePath(source);
  const destination = localUri(relativePath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));

  try {
    await vscode.workspace.fs.stat(destination);
    const choice = await vscode.window.showWarningMessage(
      `${relativePath} already exists in the VSync local repository.`,
      { modal: true },
      "Overwrite",
    );
    if (choice !== "Overwrite") return;
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
  }

  await vscode.workspace.fs.copy(source, destination, { overwrite: true });
  filesProvider?.refresh();
  void vscode.window.showInformationMessage(`Added ~/${relativePath} to VSync.`);
}

async function removeFile(relativePath?: string): Promise<void> {
  const files = await listLocalFiles();
  if (files.length === 0) throw new Error("The VSync local repository contains no files.");

  const selectedPath = relativePath ?? await vscode.window.showQuickPick(files, {
    placeHolder: "Select a file to remove from VSync",
  });
  if (!selectedPath) return;
  if (!files.includes(selectedPath)) throw new Error(`File is not in the VSync local repository: ${selectedPath}`);

  const remoteRepository = await requireRemoteRepository();
  if (!remoteRepository) return;
  const choice = await vscode.window.showWarningMessage(
    `Remove ${selectedPath} from the VSync mirror and ${remoteRepository.owner}/${remoteRepository.repository}? The original ~/${selectedPath} will not be deleted.`,
    { modal: true },
    "Remove",
  );
  if (choice !== "Remove") return;

  const accessToken = await token();
  const remote = await getRemote(selectedPath, accessToken, remoteRepository);
  if (Array.isArray(remote)) throw new Error(`${remotePath(selectedPath, remoteRepository)} is a directory.`);
  if (remote?.sha) {
    await githubRequest(contentEndpoint(selectedPath, remoteRepository), accessToken, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Remove ${selectedPath} from VSync`,
        branch: remoteRepository.branch,
        sha: remote.sha,
      }),
    });
  }

  await vscode.workspace.fs.delete(localUri(selectedPath));
  filesProvider?.refresh();
  const remoteStatus = remote?.sha ? " and remote repository" : " (remote file was already absent)";
  void vscode.window.showInformationMessage(`Removed ${selectedPath} from the VSync mirror${remoteStatus}.`);
}

async function selectLocalRepository(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: localUri(),
    openLabel: "Use as VSync Local Repository",
    title: "Select VSync Local Repository",
  });
  if (!selected?.[0]) return;
  await vscode.workspace.getConfiguration("piConfigVsync").update(
    "local.repository",
    selected[0].fsPath,
    vscode.ConfigurationTarget.Global,
  );
  await vscode.workspace.fs.createDirectory(selected[0]);
  filesProvider?.refresh();
  void vscode.window.showInformationMessage(`VSync local repository: ${selected[0].fsPath}`);
}

async function selectRemoteRepository(): Promise<RemoteRepository | undefined> {
  const accessToken = await token();
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest<GitHubRepository[]>(
      `/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
      accessToken,
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }

  const selected = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      label: repository.full_name,
      description: repository.private ? "Private" : "Public",
      repository,
    })),
    { placeHolder: "Select the GitHub remote repository", matchOnDescription: true },
  );
  if (!selected) return undefined;

  const config = vscode.workspace.getConfiguration("piConfigVsync");
  await config.update("github.remoteRepository", selected.repository.full_name, vscode.ConfigurationTarget.Global);
  await config.update("github.branch", selected.repository.default_branch, vscode.ConfigurationTarget.Global);
  filesProvider?.refresh();
  void vscode.window.showInformationMessage(`VSync remote repository: ${selected.repository.full_name}`);
  return configuredRemoteRepository();
}

async function requireRemoteRepository(): Promise<RemoteRepository | undefined> {
  const configured = configuredRemoteRepository();
  if (configured) return configured;
  const choice = await vscode.window.showInformationMessage(
    "Select a remote GitHub repository before synchronizing files.",
    "Select Repository",
  );
  return choice === "Select Repository" ? selectRemoteRepository() : undefined;
}

function repositoryEndpoint(remoteRepository: RemoteRepository): string {
  return `/repos/${encodeURIComponent(remoteRepository.owner)}/${encodeURIComponent(remoteRepository.repository)}`;
}

function contentEndpoint(relativePath: string, remoteRepository: RemoteRepository): string {
  const encodedPath = remotePath(relativePath, remoteRepository).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${repositoryEndpoint(remoteRepository)}/contents/${encodedPath}`;
}

async function commitFiles(
  files: Array<{ path: string; bytes: Uint8Array }>,
  accessToken: string,
  remoteRepository: RemoteRepository,
): Promise<boolean> {
  const repository = repositoryEndpoint(remoteRepository);
  const encodedBranch = remoteRepository.branch.split("/").map(encodeURIComponent).join("/");
  const referencePath = `${repository}/git/ref/heads/${encodedBranch}`;
  const reference = await githubRequest<GitReference>(referencePath, accessToken);
  const parent = await githubRequest<GitCommit>(`${repository}/git/commits/${reference.object.sha}`, accessToken);
  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];

  for (const file of files) {
    const blob = await githubRequest<GitObject>(`${repository}/git/blobs`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(file.bytes).toString("base64"), encoding: "base64" }),
    });
    treeEntries.push({ path: remotePath(file.path, remoteRepository), mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest<GitObject>(`${repository}/git/trees`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeEntries }),
  });
  if (tree.sha === parent.tree.sha) return false;

  const commit = await githubRequest<GitObject>(`${repository}/git/commits`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `VSync ${files.length} file${files.length === 1 ? "" : "s"}`,
      tree: tree.sha,
      parents: [parent.sha],
    }),
  });
  await githubRequest<GitReference>(`${repository}/git/refs/heads/${encodedBranch}`, accessToken, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commit.sha }),
  });
  return true;
}

async function getRemote(
  relativePath: string,
  accessToken: string,
  remoteRepository: RemoteRepository,
): Promise<GitHubContent | GitHubContent[] | undefined> {
  const response = await fetch(
    `https://api.github.com${contentEndpoint(relativePath, remoteRepository)}?ref=${encodeURIComponent(remoteRepository.branch)}`,
    { headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub ${response.status} ${response.statusText}: ${await response.text()}`);
  return (await response.json()) as GitHubContent | GitHubContent[];
}

async function listRemoteFiles(
  accessToken: string,
  remoteRepository: RemoteRepository,
  relativeDirectory = "",
): Promise<string[]> {
  const remote = await getRemote(relativeDirectory, accessToken, remoteRepository);
  if (!remote) return [];
  const entries = Array.isArray(remote) ? remote : [remote];
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.name || !entry.type) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.type === "dir") files.push(...await listRemoteFiles(accessToken, remoteRepository, relativePath));
    else if (entry.type === "file") files.push(relativePath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function push(): Promise<void> {
  const remoteRepository = await requireRemoteRepository();
  if (!remoteRepository) return;
  await vscode.workspace.fs.createDirectory(localUri());
  const files = await listLocalFiles();
  if (files.length === 0) throw new Error(`Local repository ${localRepositoryPath()} contains no files.`);
  const accessToken = await token();
  const pending: Array<{ path: string; bytes: Uint8Array }> = [];

  for (const file of files) {
    const mirror = localUri(file);
    const source = homeUri(file);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(source);
      await vscode.workspace.fs.writeFile(mirror, bytes);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
      bytes = await vscode.workspace.fs.readFile(mirror);
    }
    pending.push({ path: file, bytes });
  }

  const committed = await commitFiles(pending, accessToken, remoteRepository);
  filesProvider?.refresh();
  const message = committed
    ? `Pushed ${files.length} file(s) to ${remoteRepository.owner}/${remoteRepository.repository} in one commit.`
    : `${remoteRepository.owner}/${remoteRepository.repository} is already up to date.`;
  void vscode.window.showInformationMessage(message);
}

async function pull(): Promise<void> {
  const remoteRepository = await requireRemoteRepository();
  if (!remoteRepository) return;
  const accessToken = await token();
  const files = await listRemoteFiles(accessToken, remoteRepository);
  if (files.length === 0) throw new Error(`No files found in ${remoteRepository.owner}/${remoteRepository.repository}/${remoteRepository.directory}.`);
  const pending: Array<{ file: string; bytes: Uint8Array }> = [];

  for (const file of files) {
    const remote = await getRemote(file, accessToken, remoteRepository);
    if (Array.isArray(remote) || !remote?.content || remote.encoding !== "base64") {
      throw new Error(`${remotePath(file, remoteRepository)} is not a downloadable GitHub file.`);
    }
    pending.push({ file, bytes: Buffer.from(remote.content.replace(/\s/g, ""), "base64") });
  }

  await vscode.workspace.fs.createDirectory(localUri());
  for (const { file, bytes } of pending) {
    const mirror = localUri(file);
    const destination = homeUri(file);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(mirror.fsPath)));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination.fsPath)));
    await vscode.workspace.fs.writeFile(mirror, bytes);
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  filesProvider?.refresh();
  void vscode.window.showInformationMessage(`Pulled ${files.length} file(s) and restored their home-relative paths.`);
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(`VSync: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  void vscode.workspace.fs.createDirectory(localUri());
  filesProvider = new VSyncFilesProvider();
  context.subscriptions.push(
    filesProvider,
    vscode.window.registerTreeDataProvider("piConfigVsync.files", filesProvider),
    vscode.commands.registerCommand("piConfigVsync.refreshFiles", () => filesProvider?.refresh()),
    vscode.commands.registerCommand("piConfigVsync.addFile", () => run(addCurrentFile)),
    vscode.commands.registerCommand("piConfigVsync.removeFile", (relativePath?: string) => run(() => removeFile(relativePath))),
    vscode.commands.registerCommand("piConfigVsync.selectLocalRepository", () => run(selectLocalRepository)),
    vscode.commands.registerCommand("piConfigVsync.selectRepository", () => run(async () => { await selectRemoteRepository(); })),
    vscode.commands.registerCommand("piConfigVsync.push", () => run(push)),
    vscode.commands.registerCommand("piConfigVsync.pull", () => run(pull)),
  );
}

export function deactivate(): void {}
