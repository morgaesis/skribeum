//! The serializable IPC error shape. Every command failure crosses the
//! boundary as an `AppError { code, message, path }` with `code` stable and
//! tested; messages describe the failure class and never contain note
//! content.

use serde::Serialize;
use skribeum_vault::{FsError, VaultError, VaultPathError};

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
            VaultError::NotANote => "note/not-a-note",
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
            (VaultError::NotANote.into(), "note/not-a-note"),
            (VaultError::Fs(FsError::NotFound).into(), "fs/not-found"),
            (
                VaultError::Fs(FsError::NotADirectory).into(),
                "fs/not-a-directory",
            ),
            (VaultError::Fs(FsError::ReadOnly).into(), "fs/read-only"),
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
