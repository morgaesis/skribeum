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

function vaultName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) || path
  );
}

/**
 * Preserves newest-first ordering while ensuring indistinguishable basenames
 * have visibly distinct, fully announced labels.
 */
export function startupVaultRows(paths: readonly string[]): StartupVaultRow[] {
  const names = paths.map(vaultName);
  return paths.map((path, index) => {
    const name = names[index] ?? path;
    const duplicate =
      names.filter((candidate) => candidate === name).length > 1;
    return {
      path,
      label: duplicate ? `${name}, ${path}` : name,
      accessibleLabel: `Open vault ${path}`,
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
