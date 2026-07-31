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
  noteWriteFailed: "Saving the note failed",
  conflictBanner:
    "This note changed on disk while your edit was unsaved. The disk version was loaded and your edits were kept on top of it; review the result before saving.",
  noteRemovedBanner:
    "This note was removed from disk. Your buffer is kept as shown; saving is paused until the note reappears.",
  noteRecoveredNotice:
    "Unsaved changes from a previous session were recovered into this note. They are applied but not yet saved.",
  noteRecoveredPendingBanner:
    "Unsaved changes from a previous session were recovered. Open the note to apply them:",
  bulkDivergenceBanner:
    "More files changed at once than the review threshold. Nothing was applied automatically; review the affected files:",
  bannerReasonSizeShrank: "shrank on disk past the safety threshold",
  bannerReasonBecameEmpty: "became empty on disk",
  bannerReasonEditWithinWriteSettle:
    "changed on disk immediately after this device saved it",
  bannerReasonJournalDiverged:
    "changed on disk while the application was closed; recovered unsaved changes were not applied",
  reconciliationBannerPrefix: "Needs review:",
  reviewAction: "Review",
  dismissAction: "Dismiss",
} as const;
