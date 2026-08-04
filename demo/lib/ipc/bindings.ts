import type {
  BulkDivergenceReview,
  ExternalNoteRemove,
  ExternalNoteUpdate,
  MaximizeButtonHitState,
  MenuCommandInvoked,
  NoteRecovered,
  OpenFilesAvailable,
  ReconciliationBanner,
  SettingsZoomChanged,
  VaultChanged,
  VaultCollisionsDetected,
} from "../../../src/lib/ipc/bindings";

export type {
  AppError,
  BannerReason,
  ByteRangeReplace,
  MaximizeButtonRect,
  NoteContent,
  NoteStat,
  OpenFileTarget,
  SearchHit,
  SettingsDoc,
  TagFrequency,
  TreeEntry,
  TreeEntryKind,
  VaultHandle,
  WriteResult,
} from "../../../src/lib/ipc/bindings";

type EventCallback<T> = (event: { payload: T }) => void;
type Unlisten = () => void;

function inertEvent<T>() {
  return {
    listen(_callback: EventCallback<T>): Promise<Unlisten> {
      return Promise.resolve(() => {});
    },
    once(_callback: EventCallback<T>): Promise<Unlisten> {
      return Promise.resolve(() => {});
    },
    emit(_payload: T): Promise<void> {
      return Promise.resolve();
    },
  };
}

export const events = {
  bulkDivergenceReview: inertEvent<BulkDivergenceReview>(),
  externalNoteRemove: inertEvent<ExternalNoteRemove>(),
  externalNoteUpdate: inertEvent<ExternalNoteUpdate>(),
  maximizeButtonHitState: inertEvent<MaximizeButtonHitState>(),
  menuCommandInvoked: inertEvent<MenuCommandInvoked>(),
  noteRecovered: inertEvent<NoteRecovered>(),
  openFilesAvailable: inertEvent<OpenFilesAvailable>(),
  reconciliationBanner: inertEvent<ReconciliationBanner>(),
  settingsZoomChanged: inertEvent<SettingsZoomChanged>(),
  vaultChanged: inertEvent<VaultChanged>(),
  vaultCollisionsDetected: inertEvent<VaultCollisionsDetected>(),
};
