/** The startup-vault session shape shared with the generated IPC binding. */
export type VaultStartupSession = {
  schema_version: number;
  last_vault: string | null;
  recent_vaults: string[];
};

export type StartupVaultRow = {
  path: string;
  label: string;
  accessibleLabel: string;
};

export type StartupVaultSurface =
  | { kind: "pending" }
  | { kind: "empty"; error?: string }
  | { kind: "chooser"; rows: StartupVaultRow[]; error?: string };

export type StartupVaultDecision =
  | { kind: "open"; path: string }
  | { kind: "surface"; surface: StartupVaultSurface };

export type StartupSource =
  | { kind: "browser" }
  | { kind: "webdriver"; path: string }
  | { kind: "native" }
  | { kind: "session" };

export type VaultBrowseResult =
  | { kind: "cancelled" }
  | { kind: "opened" }
  | { kind: "failed"; error: unknown };

export type VaultPickerReadResult =
  | { kind: "loaded"; session: VaultStartupSession }
  | { kind: "failed"; error: unknown }
  | { kind: "superseded" };

/** Gives only the newest picker read permission to update picker state. */
export class VaultPickerReadOwnership {
  #epoch = 0;

  begin(): number {
    this.#epoch += 1;
    return this.#epoch;
  }

  invalidate(): void {
    this.#epoch += 1;
  }

  isCurrent(epoch: number): boolean {
    return this.#epoch === epoch;
  }
}

/** Reads picker rows without allowing an obsolete completion to escape. */
export async function readVaultPickerSession(
  ownership: VaultPickerReadOwnership,
  read: () => Promise<VaultStartupSession>,
): Promise<VaultPickerReadResult> {
  const epoch = ownership.begin();
  try {
    const session = await read();
    return ownership.isCurrent(epoch)
      ? { kind: "loaded", session }
      : { kind: "superseded" };
  } catch (error) {
    return ownership.isCurrent(epoch)
      ? { kind: "failed", error }
      : { kind: "superseded" };
  }
}

/** Resolves directory selection and vault opening into one caught result. */
export async function browseVaultSelection(
  selectDirectory: () => Promise<string | null>,
  openVault: (path: string) => Promise<unknown | null>,
): Promise<VaultBrowseResult> {
  try {
    const path = await selectDirectory();
    if (path === null) return { kind: "cancelled" };
    const failure = await openVault(path);
    return failure === null
      ? { kind: "opened" }
      : { kind: "failed", error: failure };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function vaultName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || path
  );
}

function vaultPathParts(path: string): string[] {
  return path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .filter((part) => part.length > 0);
}

function ancestorLabel(path: string, count: number): string {
  const parts = vaultPathParts(path);
  return parts
    .slice(Math.max(0, parts.length - count - 1), Math.max(0, parts.length - 1))
    .join("/");
}

/**
 * Preserves newest-first ordering while ensuring indistinguishable basenames
 * have visibly distinct, fully announced labels.
 */
export function startupVaultRows(paths: readonly string[]): StartupVaultRow[] {
  const names = paths.map(vaultName);
  const qualifiers = paths.map(() => "");
  const indexesByName = new Map<string, number[]>();
  for (const [index, name] of names.entries()) {
    const indexes = indexesByName.get(name);
    if (indexes === undefined) indexesByName.set(name, [index]);
    else indexes.push(index);
  }

  for (const indexes of indexesByName.values()) {
    if (indexes.length < 2) continue;
    const resolved = new Set<number>();
    const maximumAncestors = Math.max(
      ...indexes.map((index) => vaultPathParts(paths[index] ?? "").length - 1),
    );
    for (let count = 1; count <= maximumAncestors; count += 1) {
      const labels = new Map<string, number[]>();
      for (const index of indexes) {
        if (resolved.has(index)) continue;
        const label = ancestorLabel(paths[index] ?? "", count);
        const grouped = labels.get(label);
        if (grouped === undefined) labels.set(label, [index]);
        else grouped.push(index);
      }
      for (const [label, grouped] of labels) {
        if (label.length === 0 || grouped.length > 1) continue;
        const [index] = grouped;
        if (index !== undefined) {
          qualifiers[index] = label;
          resolved.add(index);
        }
      }
    }
    const fallbackCounts = new Map<string, number>();
    for (const index of indexes) {
      if (resolved.has(index)) continue;
      const fullPath = (paths[index] ?? "").replace(/[\\/]+$/u, "");
      const occurrence = (fallbackCounts.get(fullPath) ?? 0) + 1;
      fallbackCounts.set(fullPath, occurrence);
      qualifiers[index] =
        occurrence === 1 ? fullPath : `${fullPath} (${occurrence})`;
    }
  }

  return paths.map((path, index) => {
    const name = names[index] ?? path;
    const qualifier = qualifiers[index] ?? "";
    return {
      path,
      label: qualifier.length > 0 ? `${name} · ${qualifier}` : name,
      accessibleLabel:
        qualifier.length > 0
          ? `Open vault ${name} in ${qualifier}`
          : `Open vault ${name}`,
    };
  });
}

export function emptyStartupSurface(error?: string): StartupVaultSurface {
  return error === undefined ? { kind: "empty" } : { kind: "empty", error };
}

function chooserStartupSurface(
  paths: readonly string[],
  error?: string,
): StartupVaultSurface {
  const rows = startupVaultRows(paths);
  return error === undefined
    ? { kind: "chooser", rows }
    : { kind: "chooser", rows, error };
}

/** Applies the authoritative-last then recent-vault startup policy. */
export function nextStartupDecision(
  session: VaultStartupSession,
): StartupVaultDecision {
  if (session.last_vault !== null) {
    return { kind: "open", path: session.last_vault };
  }
  if (session.recent_vaults.length === 1) {
    return { kind: "open", path: session.recent_vaults[0] ?? "" };
  }
  if (session.recent_vaults.length > 1) {
    return {
      kind: "surface",
      surface: chooserStartupSurface(session.recent_vaults),
    };
  }
  return { kind: "surface", surface: emptyStartupSurface() };
}

/** Only a missing root or a root that became a file is safe to forget. */
export function isStaleVaultOpenError(
  code: string | null | undefined,
): boolean {
  return code === "vault/not-found" || code === "vault/not-a-directory";
}

/**
 * Keeps a failed automatic candidate available for an explicit retry. A
 * chooser is deliberate even for one candidate, so a transient failure never
 * loops automatically and Browse remains available.
 */
export function failedStartupSurface(
  session: VaultStartupSession,
  failedPath: string,
  error: string,
): StartupVaultSurface {
  const paths = [
    failedPath,
    ...session.recent_vaults.filter((path) => path !== failedPath),
  ];
  return chooserStartupSurface(paths, error);
}

/** Keeps an explicitly selected candidate available after a non-stale failure. */
export function selectedStartupFailureSurface(
  surface: StartupVaultSurface,
  failedPath: string,
  error: string,
): StartupVaultSurface {
  if (surface.kind === "chooser") return { ...surface, error };
  return failedStartupSurface(
    {
      schema_version: 1,
      last_vault: failedPath,
      recent_vaults: [failedPath],
    },
    failedPath,
    error,
  );
}

/** Applies chooser policy after forgetting one explicitly selected stale row. */
export function staleChooserStartupDecision(
  session: VaultStartupSession,
): StartupVaultDecision {
  return nextStartupDecision({ ...session, last_vault: null });
}

/** Establishes whether recovery may read the native session at all. */
export function startupSource(options: {
  desktop: boolean;
  webdriverVault?: string;
  nativeOpenPending?: boolean;
}): StartupSource {
  if (!options.desktop) return { kind: "browser" };
  if (typeof options.webdriverVault === "string") {
    return { kind: "webdriver", path: options.webdriverVault };
  }
  if (options.nativeOpenPending === true) return { kind: "native" };
  return { kind: "session" };
}
