//! Durable startup-vault selection. This document is device-local app
//! configuration, deliberately separate from user-editable settings.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{FileSystem, FsError, write_durable_private};

/// File name of the device-local vault startup session document.
pub const VAULT_SESSION_FILE_NAME: &str = "vault-session.json";
/// Private directory containing the device-local vault startup session.
pub const VAULT_SESSION_DIRECTORY_NAME: &str = "vault-session";
/// Current schema version of [`VaultSession`].
pub const VAULT_SESSION_SCHEMA_VERSION: u32 = 1;
/// Number of recently opened vaults retained for startup recovery.
pub const MAX_RECENT_VAULTS: usize = 12;

/// Failures while reading or writing the vault startup-session document.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultSessionError {
    /// A filesystem operation failed.
    #[error(transparent)]
    Fs(#[from] FsError),
    /// The session document could not be serialized.
    #[error("vault session document could not be serialized")]
    Serialize,
}

/// The persisted startup selection and recent-vault list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultSession {
    /// Schema version of this document.
    pub schema_version: u32,
    /// Most recently opened canonical vault root, when one exists.
    pub last_vault: Option<String>,
    /// Canonical vault roots ordered newest first.
    pub recent_vaults: Vec<String>,
}

impl Default for VaultSession {
    fn default() -> Self {
        Self {
            schema_version: VAULT_SESSION_SCHEMA_VERSION,
            last_vault: None,
            recent_vaults: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultSessionDocument {
    schema_version: u32,
    #[serde(default)]
    last_vault: Option<String>,
    #[serde(default)]
    recent_vaults: Vec<String>,
}

impl VaultSession {
    fn from_document(document: VaultSessionDocument) -> Option<Self> {
        if document.schema_version != VAULT_SESSION_SCHEMA_VERSION {
            return None;
        }

        let mut recent_vaults = Vec::with_capacity(MAX_RECENT_VAULTS);
        let mut append = |path: String| {
            if Path::new(&path).is_absolute()
                && !recent_vaults.contains(&path)
                && recent_vaults.len() < MAX_RECENT_VAULTS
            {
                recent_vaults.push(path);
            }
        };
        let last_vault = document
            .last_vault
            .filter(|path| Path::new(path).is_absolute());
        if let Some(last_vault) = &last_vault {
            append(last_vault.clone());
        }
        for path in document.recent_vaults {
            append(path);
        }
        Some(Self {
            schema_version: VAULT_SESSION_SCHEMA_VERSION,
            last_vault,
            recent_vaults,
        })
    }

    fn document(&self) -> VaultSessionDocument {
        VaultSessionDocument {
            schema_version: VAULT_SESSION_SCHEMA_VERSION,
            last_vault: self.last_vault.clone(),
            recent_vaults: self.recent_vaults.clone(),
        }
    }

    fn record_opened(&mut self, canonical_root: &Path) {
        let root = canonical_root.to_string_lossy().into_owned();
        self.last_vault = Some(root.clone());
        self.recent_vaults.retain(|path| path != &root);
        self.recent_vaults.insert(0, root);
        self.recent_vaults.truncate(MAX_RECENT_VAULTS);
    }

    fn forget(&mut self, path: &str) {
        self.recent_vaults.retain(|candidate| candidate != path);
        if self.last_vault.as_deref() == Some(path) {
            self.last_vault = None;
        }
    }

    fn clear_last(&mut self) {
        self.last_vault = None;
    }
}

/// The vault startup-session document at a fixed app-config path.
#[derive(Debug, Clone)]
pub struct VaultSessionStore {
    path: PathBuf,
}

impl VaultSessionStore {
    /// A store in its dedicated `directory`.
    #[must_use]
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(VAULT_SESSION_FILE_NAME),
        }
    }

    /// The session document path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads the stored selection. Missing, malformed, unsupported, and
    /// invalid documents safely become an empty session.
    ///
    /// # Errors
    ///
    /// Returns an error when an existing document cannot be read.
    pub fn read(&self, fs: &dyn FileSystem) -> Result<VaultSession, VaultSessionError> {
        let bytes = match fs.read(&self.path) {
            Ok(bytes) => bytes,
            Err(FsError::NotFound) => return Ok(VaultSession::default()),
            Err(error) => return Err(error.into()),
        };
        let session = serde_json::from_slice::<VaultSessionDocument>(&bytes)
            .ok()
            .and_then(VaultSession::from_document)
            .unwrap_or_default();
        Ok(session)
    }

    /// Records a vault only after its caller has opened and canonicalized it.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be read, serialized, or
    /// written durably.
    pub fn record_opened(
        &self,
        fs: &dyn FileSystem,
        canonical_root: &Path,
    ) -> Result<VaultSession, VaultSessionError> {
        let mut session = self.read(fs)?;
        session.record_opened(canonical_root);
        self.write(fs, &session)?;
        Ok(session)
    }

    /// Removes one explicitly selected vault candidate from the session.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be read, serialized, or
    /// written durably.
    pub fn forget(
        &self,
        fs: &dyn FileSystem,
        path: &str,
    ) -> Result<VaultSession, VaultSessionError> {
        let mut session = self.read(fs)?;
        session.forget(path);
        self.write(fs, &session)?;
        Ok(session)
    }

    /// Clears only the authoritative automatic-startup selection without
    /// deleting the recent list. Startup policy may still choose a remaining
    /// recent vault when no authoritative selection exists.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be read, serialized, or
    /// written durably.
    pub fn clear_last(&self, fs: &dyn FileSystem) -> Result<VaultSession, VaultSessionError> {
        let mut session = self.read(fs)?;
        session.clear_last();
        self.write(fs, &session)?;
        Ok(session)
    }

    fn write(&self, fs: &dyn FileSystem, session: &VaultSession) -> Result<(), VaultSessionError> {
        let mut bytes = serde_json::to_vec_pretty(&session.document())
            .map_err(|_| VaultSessionError::Serialize)?;
        bytes.push(b'\n');
        let parent = self.path.parent().ok_or(FsError::NotADirectory)?;
        fs.create_private_dir_all(parent)?;
        write_durable_private(fs, &self.path, &bytes)?;
        Ok(())
    }
}
