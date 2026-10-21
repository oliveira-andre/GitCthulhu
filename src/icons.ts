// Lucide icons, bundled locally (no CDN).
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Copy,
  Ellipsis,
  File,
  FileMinus,
  FilePen,
  FilePlus,
  FileQuestion,
  FileSymlink,
  FileWarning,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  GitPullRequestArrow,
  Laptop,
  ListTree,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
  Star,
  Tag,
  Trash2,
  Undo2,
  X,
  createElement,
} from "lucide";

const icons = {
  stash: Archive,
  pop: ArchiveRestore,
  arrowDown: ArrowDown,
  pull: ArrowDownToLine,
  arrowUp: ArrowUp,
  push: ArrowUpFromLine,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  dot: CircleDot,
  cloud: Cloud,
  copy: Copy,
  more: Ellipsis,
  file: File,
  fileRemoved: FileMinus,
  fileModified: FilePen,
  fileAdded: FilePlus,
  fileUntracked: FileQuestion,
  fileRenamed: FileSymlink,
  fileConflict: FileWarning,
  folder: Folder,
  repo: FolderGit2,
  folderOpen: FolderOpen,
  folderPlus: FolderPlus,
  branch: GitBranch,
  branchPlus: GitBranchPlus,
  commit: GitCommitHorizontal,
  clone: GitFork,
  merge: GitMerge,
  rebase: GitPullRequestArrow,
  laptop: Laptop,
  tree: ListTree,
  minus: Minus,
  leftPanel: PanelLeft,
  rightPanel: PanelRight,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  terminal: SquareTerminal,
  star: Star,
  tag: Tag,
  trash: Trash2,
  undo: Undo2,
  close: X,
};

export type IconName = keyof typeof icons;

export function icon(name: IconName, size = 16): SVGElement {
  const svg = createElement(icons[name], { width: size, height: size, "aria-hidden": "true" });
  svg.classList.add("icon");
  return svg;
}

export function iconButton(
  name: IconName,
  label: string,
  onClick: (event: MouseEvent) => void,
  className = "icon-button",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", onClick);
  return button;
}
