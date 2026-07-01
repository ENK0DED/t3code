import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
} from "./path.ts";

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

export function getAbsolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) {
    return "windows";
  }
  if (value.startsWith("/")) {
    return "unix";
  }
  return null;
}

export function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed =
    getAbsolutePathKind(value) === "unix"
      ? value.replace(/\/+$/g, "")
      : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function preferredPathSeparator(value: string): "/" | "\\" {
  const absolutePathKind = getAbsolutePathKind(value);
  if (absolutePathKind === "windows") return "\\";
  if (absolutePathKind === "unix") return "/";
  return value.includes("\\") ? "\\" : "/";
}

export function splitPathSegments(value: string, separator: "/" | "\\"): string[] {
  return value.split(separator === "/" ? /\/+/ : /[\\/]+/).filter(Boolean);
}

export function getLastPathSeparatorIndex(value: string): number {
  if (getAbsolutePathKind(value) === "unix") {
    return value.lastIndexOf("/");
  }
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

export function splitAbsolutePath(value: string): {
  root: string;
  separator: "/" | "\\";
  segments: string[];
} | null {
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    const segments = splitPathSegments(value.slice(root.length), "\\");
    return { root, separator: "\\", segments };
  }
  if (isUncPath(value)) {
    const segments = splitPathSegments(value, "\\");
    const [server, share, ...rest] = segments;
    if (!server || !share) return null;
    return {
      root: `\\\\${server}\\${share}\\`,
      separator: "\\",
      segments: rest,
    };
  }
  if (value.startsWith("/")) {
    return {
      root: "/",
      separator: "/",
      segments: splitPathSegments(value.slice(1), "/"),
    };
  }
  return null;
}

export function isExplicitRelativeProjectPath(value: string): boolean {
  return isExplicitRelativePath(value);
}

export function isUnsupportedWindowsProjectPath(value: string, platform: string): boolean {
  return isWindowsAbsolutePath(value) && !isWindowsPlatform(platform);
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativePath(trimmedValue) || !cwd) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const absoluteBase = splitAbsolutePath(normalizeProjectPathForDispatch(cwd));
  if (!absoluteBase) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const nextSegments = [...absoluteBase.segments];
  for (const segment of trimmedValue.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      nextSegments.pop();
      continue;
    }
    nextSegments.push(segment);
  }

  const joinedPath = nextSegments.join(absoluteBase.separator);
  return normalizeProjectPathForDispatch(
    joinedPath.length === 0 ? absoluteBase.root : `${absoluteBase.root}${joinedPath}`,
  );
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  const absolutePath = splitAbsolutePath(normalized);
  if (absolutePath) {
    return absolutePath.segments.findLast(Boolean) ?? normalized;
  }
  const segments = normalized.split(/[/\\]/);
  return segments.findLast(Boolean) ?? normalized;
}
