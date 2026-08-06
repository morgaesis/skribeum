//! The serializable IPC error shape. Every command failure crosses the
//! boundary as an `AppError { code, message, path }` with `code` stable and
//! tested; messages describe the failure class and never contain note
//! content.

use serde::Serialize;
use skribeum_vault::{
    EditHistoryError, FsError, SearchError, SettingsError, VaultError, VaultPathError,
};

/// The one error shape that crosses IPC.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AppError {
    /// Stable machine-readable code. Codes are part of the IPC contract:
    /// existing values never change meaning, and the committed test below
    /// pins them.
    pub code: &'static str,
    /// Human-readable failure description. Built exclusively from error enum
    /// display text, never from file bytes, so it cannot leak note content.
    pub message: String,
    /// The vault-relative path involved, when one exists.
    pub path: Option<String>,
}

impl AppError {
    /// An error for an unknown vault handle.
    #[must_use]
    pub fn unknown_handle() -> Self {
        Self {
            code: "vault/unknown-handle",
            message: "no open vault has this handle".to_owned(),
            path: None,
        }
    }

    /// An error for a vault whose search index is not available (still
    /// opening, or the app-data directory could not be resolved).
    #[must_use]
    pub fn search_unavailable() -> Self {
        Self {
            code: "search/unavailable",
            message: "the search index for this vault is not available".to_owned(),
            path: None,
        }
    }

    /// A search request outside the bounded renderer contract.
    #[must_use]
    pub fn search_invalid() -> Self {
        Self {
            code: "search/invalid",
            message: "the search request is outside the supported limits".to_owned(),
            path: None,
        }
    }

    /// An error for an unresolvable settings location.
    #[must_use]
    pub fn settings_unavailable() -> Self {
        Self {
            code: "settings/unavailable",
            message: "the settings directory could not be resolved".to_owned(),
            path: None,
        }
    }

    /// An error for an unavailable application-data history location.
    #[must_use]
    pub fn edit_history_unavailable() -> Self {
        Self {
            code: "edit-history/unavailable",
            message: "the edit-history directory could not be resolved".to_owned(),
            path: None,
        }
    }

    /// An update check that cannot run or complete.
    #[must_use]
    pub fn update_failed(message: impl Into<String>) -> Self {
        Self {
            code: "update/check",
            message: message.into(),
            path: None,
        }
    }

    /// An operating-system file-open path that is missing or unsupported.
    #[must_use]
    pub fn open_file_invalid() -> Self {
        Self {
            code: "open-file/invalid",
            message: "the file-open path is missing or unsupported".to_owned(),
            path: None,
        }
    }

    /// A native window operation that failed.
    #[must_use]
    pub fn window_failed(message: impl Into<String>) -> Self {
        Self {
            code: "window/operation",
            message: message.into(),
            path: None,
        }
    }

    /// Attaches the vault-relative path the failure concerns.
    #[must_use]
    pub fn with_path(mut self, path: &str) -> Self {
        self.path = Some(path.to_owned());
        self
    }
}

fn fs_code(error: &FsError) -> &'static str {
    match error {
        FsError::NotFound => "fs/not-found",
        FsError::NotADirectory => "fs/not-a-directory",
        FsError::ReadOnly => "fs/read-only",
        FsError::NoSpace => "fs/no-space",
        FsError::Io(_) => "fs/io",
    }
}

impl From<&VaultError> for AppError {
    fn from(error: &VaultError) -> Self {
        let code = match error {
            VaultError::RootNotFound => "vault/not-found",
            VaultError::RootNotADirectory => "vault/not-a-directory",
            VaultError::Path(_) => "path/invalid",
            VaultError::NoteNotFound => "note/not-found",
            VaultError::NoteAlreadyExists => "note/already-exists",
            VaultError::EntryNotFound => "entry/not-found",
            VaultError::EntryAlreadyExists => "entry/already-exists",
            VaultError::NotANote => "note/not-a-note",
            VaultError::NotAFile => "entry/not-a-file",
            VaultError::NoteNotRead => "note/not-read",
            VaultError::NoteReadOnly => "note/read-only",
            VaultError::BaseMismatch => "note/base-mismatch",
            VaultError::ChangeSet(_) => "note/change-set",
            VaultError::Fs(fs) => fs_code(fs),
        };
        Self {
            code,
            message: error.to_string(),
            path: None,
        }
    }
}

impl From<VaultError> for AppError {
    fn from(error: VaultError) -> Self {
        Self::from(&error)
    }
}

impl From<SearchError> for AppError {
    fn from(error: SearchError) -> Self {
        let code = match error {
            SearchError::Storage(_) => "search/index",
        };
        Self {
            code,
            message: error.to_string(),
            path: None,
        }
    }
}

impl From<SettingsError> for AppError {
    fn from(error: SettingsError) -> Self {
        let code = match &error {
            SettingsError::Corrupt => "settings/corrupt",
            SettingsError::InvalidValue(_) => "settings/invalid",
            SettingsError::Fs(fs) => fs_code(fs),
        };
        Self {
            code,
            message: error.to_string(),
            path: None,
        }
    }
}

impl From<EditHistoryError> for AppError {
    fn from(error: EditHistoryError) -> Self {
        let code = match &error {
            EditHistoryError::Fs(fs) => fs_code(fs),
            EditHistoryError::Serialize => "edit-history/serialize",
        };
        Self {
            code,
            message: error.to_string(),
            path: None,
        }
    }
}

impl From<VaultPathError> for AppError {
    fn from(error: VaultPathError) -> Self {
        Self {
            code: "path/invalid",
            message: error.to_string(),
            path: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skribeum_vault::VaultPath;

    /// The code table is part of the IPC contract. This test pins every
    /// mapping; changing a code is a contract change and needs a decision
    /// recorded, not a refactor.
    #[test]
    fn error_codes_are_stable() {
        let cases: Vec<(AppError, &str)> = vec![
            (VaultError::RootNotFound.into(), "vault/not-found"),
            (
                VaultError::RootNotADirectory.into(),
                "vault/not-a-directory",
            ),
            (VaultError::NoteNotFound.into(), "note/not-found"),
            (VaultError::NoteAlreadyExists.into(), "note/already-exists"),
            (VaultError::EntryNotFound.into(), "entry/not-found"),
            (
                VaultError::EntryAlreadyExists.into(),
                "entry/already-exists",
            ),
            (VaultError::NotANote.into(), "note/not-a-note"),
            (VaultError::NoteNotRead.into(), "note/not-read"),
            (VaultError::NoteReadOnly.into(), "note/read-only"),
            (VaultError::BaseMismatch.into(), "note/base-mismatch"),
            (
                VaultError::ChangeSet(skribeum_core::ChangeSetError::Overlap).into(),
                "note/change-set",
            ),
            (VaultError::Fs(FsError::NotFound).into(), "fs/not-found"),
            (
                VaultError::Fs(FsError::NotADirectory).into(),
                "fs/not-a-directory",
            ),
            (VaultError::Fs(FsError::ReadOnly).into(), "fs/read-only"),
            (VaultError::Fs(FsError::NoSpace).into(), "fs/no-space"),
            (
                VaultError::Fs(FsError::Io("disk".to_owned())).into(),
                "fs/io",
            ),
            (
                VaultError::Path(VaultPathError::Traversal).into(),
                "path/invalid",
            ),
            (
                VaultPath::new("/x").expect_err("absolute rejected").into(),
                "path/invalid",
            ),
            (AppError::unknown_handle(), "vault/unknown-handle"),
            (
                SearchError::Storage("disk".to_owned()).into(),
                "search/index",
            ),
            (AppError::search_unavailable(), "search/unavailable"),
            (AppError::search_invalid(), "search/invalid"),
            (SettingsError::Corrupt.into(), "settings/corrupt"),
            (
                SettingsError::InvalidValue("theme").into(),
                "settings/invalid",
            ),
            (SettingsError::Fs(FsError::NoSpace).into(), "fs/no-space"),
            (AppError::settings_unavailable(), "settings/unavailable"),
            (
                AppError::edit_history_unavailable(),
                "edit-history/unavailable",
            ),
            (EditHistoryError::Serialize.into(), "edit-history/serialize"),
            (AppError::update_failed("offline"), "update/check"),
            (AppError::open_file_invalid(), "open-file/invalid"),
            (AppError::window_failed("window"), "window/operation"),
        ];
        for (error, expected) in cases {
            assert_eq!(error.code, expected);
        }
    }

    /// Messages come from error display text only; reading a note whose
    /// content is a known marker never places that marker in any error
    /// message produced along the path.
    #[test]
    fn messages_never_contain_note_content() {
        let marker = "TOP-SECRET-NOTE-BYTES";
        let fs = skribeum_vault::SimFs::new();
        let root = std::path::PathBuf::from("vault");
        fs.external_write(&root.join("secret.md"), marker.as_bytes());
        fs.external_write(&root.join("secret.csv"), marker.as_bytes());
        let vault = skribeum_vault::Vault::open(&fs, &root).expect("vault opens");

        let missing = vault
            .read_note(&fs, &VaultPath::new("absent.md").expect("valid"))
            .expect_err("missing note fails");
        let app_error = AppError::from(missing).with_path("absent.md");
        assert!(!app_error.message.contains(marker));
        assert_eq!(app_error.path.as_deref(), Some("absent.md"));

        let not_note = vault
            .read_note(&fs, &VaultPath::new("secret.csv").expect("valid"))
            .expect_err("non-note read fails");
        assert!(!AppError::from(not_note).message.contains(marker));
    }
}
