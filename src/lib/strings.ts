// Every user-facing string in the shell lives here, so externalization is a
// file swap rather than a component sweep.
export const STRINGS = {
  appTitle: "Skribeum",
  openVault: "Open vault",
  vaultTreeLabel: "Vault files",
  emptyStateHint: "No vault is open. Use “Open vault” to browse one read-only.",
  readOnlyBadge: "read-only",
  nonUtf8Banner:
    "This file is not UTF-8. It is shown read-only with unmappable bytes replaced and will never be written.",
  collisionBanner:
    "Some file names in this vault collide by letter case or Unicode form and may be merged by other filesystems:",
  vaultOpenFailed: "Opening the vault failed",
  noteReadFailed: "Reading the note failed",
} as const;
