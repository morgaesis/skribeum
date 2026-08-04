// Every user-facing string in the browser-demo shell lives here, matching
// the product catalogue's own rule (src/lib/strings.ts) so externalization
// stays a file swap rather than a component sweep.
export const DEMO_STRINGS = {
  noticeLabel: "Browser demo notice",
  noticeBody:
    "This is a browser demo of the Skribeum editor surface. The product is the desktop application where files on disk are the source of truth.",
  downloadDesktopApp: "Download the desktop app",
  dismissNotice: "Dismiss browser demo notice",
  storageStatusLabel: "Browser storage status",
  folderAccessUnsupported: "This browser does not support local folder access.",
  storageFolderWritable:
    "Reading Markdown from “{name}”. Edits are written to that folder using the browser permission you granted.",
  storageFolderReadOnly:
    "Reading Markdown from “{name}”. Write permission is unavailable, so edits stay in browser memory and are lost on reload.",
  storageSampleSupported:
    "The sample vault stays in browser memory until you open a folder. Sample edits are lost on reload.",
  storageSampleUnsupported:
    "This browser does not support local folder access. The sample vault stays in browser memory, and edits are lost on reload.",
  storageSkippedSingular: " {count} unreadable file was skipped.",
  storageSkippedPlural: " {count} unreadable files were skipped.",
} as const;
