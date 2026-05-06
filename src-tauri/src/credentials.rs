use crate::models::{
    CredentialKind, CredentialRecord, CredentialStoreStatus, CredentialSummary, SshAuthMode,
    UpsertCredentialRequest,
};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const VAULT_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const ARGON2_MEMORY_COST: u32 = 19_456;
const ARGON2_TIME_COST: u32 = 2;
const ARGON2_PARALLELISM: u32 = 1;

#[derive(Default)]
pub struct CredentialStore {
    vault: Option<CredentialVault>,
    key: Option<[u8; KEY_LEN]>,
    header: Option<CryptoHeader>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialVault {
    #[serde(default)]
    credentials: Vec<CredentialRecord>,
    #[serde(default)]
    default_ssh_credential_id: Option<String>,
    #[serde(default)]
    default_rdp_credential_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCredentialFile {
    version: u8,
    kdf: KdfParams,
    cipher: CipherParams,
    ciphertext: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfParams {
    algorithm: String,
    memory_cost: u32,
    time_cost: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CipherParams {
    algorithm: String,
    nonce: String,
}

#[derive(Clone)]
struct CryptoHeader {
    kdf: KdfParams,
}

pub fn credentials_path() -> Result<PathBuf, String> {
    let base = dirs_next::config_dir()
        .ok_or_else(|| "Could not locate user config directory".to_string())?;
    Ok(base.join("ssm-commander").join("credentials.json"))
}

impl CredentialStore {
    pub fn status(&self) -> Result<CredentialStoreStatus, String> {
        self.status_at(&credentials_path()?)
    }

    pub fn unlock(&mut self, passphrase: &str) -> Result<CredentialStoreStatus, String> {
        self.unlock_at(&credentials_path()?, passphrase)
    }

    pub fn lock(&mut self) {
        self.vault = None;
        self.key = None;
        self.header = None;
    }

    pub fn list(&self) -> Result<Vec<CredentialSummary>, String> {
        Ok(self.unlocked_vault()?.summaries())
    }

    pub fn get(&self, credential_id: &str) -> Result<CredentialRecord, String> {
        self.unlocked_vault()?
            .credentials
            .iter()
            .find(|credential| credential.id == credential_id)
            .cloned()
            .ok_or_else(|| format!("No credential found for id {credential_id}"))
    }

    pub fn upsert(
        &mut self,
        request: UpsertCredentialRequest,
    ) -> Result<CredentialSummary, String> {
        let path = credentials_path()?;
        self.upsert_at(&path, request)
    }

    pub fn delete(&mut self, credential_id: &str) -> Result<(), String> {
        let path = credentials_path()?;
        self.delete_at(&path, credential_id)
    }

    pub fn set_default(
        &mut self,
        kind: CredentialKind,
        credential_id: Option<String>,
    ) -> Result<CredentialStoreStatus, String> {
        let path = credentials_path()?;
        self.set_default_at(&path, kind, credential_id)
    }

    fn status_at(&self, path: &Path) -> Result<CredentialStoreStatus, String> {
        let vault = self.vault.as_ref();
        Ok(CredentialStoreStatus {
            exists: path.exists(),
            unlocked: vault.is_some(),
            credential_count: vault.map(|vault| vault.credentials.len()).unwrap_or(0),
            default_ssh_credential_id: vault
                .and_then(|vault| vault.default_ssh_credential_id.clone()),
            default_rdp_credential_id: vault
                .and_then(|vault| vault.default_rdp_credential_id.clone()),
        })
    }

    fn unlock_at(
        &mut self,
        path: &Path,
        passphrase: &str,
    ) -> Result<CredentialStoreStatus, String> {
        validate_passphrase(passphrase)?;
        if path.exists() {
            let encrypted = read_encrypted_file(path)?;
            let key = derive_key(passphrase, &encrypted.kdf)?;
            let vault = decrypt_vault(&encrypted, &key)?;
            self.vault = Some(vault);
            self.key = Some(key);
            self.header = Some(CryptoHeader { kdf: encrypted.kdf });
            return self.status_at(path);
        }

        let header = CryptoHeader {
            kdf: new_kdf_params()?,
        };
        let key = derive_key(passphrase, &header.kdf)?;
        self.vault = Some(CredentialVault::default());
        self.key = Some(key);
        self.header = Some(header);
        self.save_at(path)?;
        self.status_at(path)
    }

    fn upsert_at(
        &mut self,
        path: &Path,
        request: UpsertCredentialRequest,
    ) -> Result<CredentialSummary, String> {
        let vault = self.unlocked_vault_mut()?;
        let credential = normalize_credential_request(request, vault)?;
        let credential_id = credential.id.clone();
        match vault
            .credentials
            .iter()
            .position(|existing| existing.id == credential_id)
        {
            Some(index) => vault.credentials[index] = credential,
            None => vault.credentials.push(credential),
        }
        vault.clear_invalid_defaults();
        self.save_at(path)?;
        self.get_summary(&credential_id)
    }

    fn delete_at(&mut self, path: &Path, credential_id: &str) -> Result<(), String> {
        let vault = self.unlocked_vault_mut()?;
        let original_len = vault.credentials.len();
        vault
            .credentials
            .retain(|credential| credential.id != credential_id);
        if vault.credentials.len() == original_len {
            return Err(format!("No credential found for id {credential_id}"));
        }
        if vault.default_ssh_credential_id.as_deref() == Some(credential_id) {
            vault.default_ssh_credential_id = None;
        }
        if vault.default_rdp_credential_id.as_deref() == Some(credential_id) {
            vault.default_rdp_credential_id = None;
        }
        self.save_at(path)
    }

    fn set_default_at(
        &mut self,
        path: &Path,
        kind: CredentialKind,
        credential_id: Option<String>,
    ) -> Result<CredentialStoreStatus, String> {
        let vault = self.unlocked_vault_mut()?;
        let normalized_id = credential_id.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        if let Some(id) = normalized_id.as_deref() {
            let credential = vault
                .credentials
                .iter()
                .find(|credential| credential.id == id)
                .ok_or_else(|| format!("No credential found for id {id}"))?;
            if credential.kind != kind {
                return Err(
                    "Credential type does not match the requested default type.".to_string()
                );
            }
        }
        match kind {
            CredentialKind::Ssh => vault.default_ssh_credential_id = normalized_id,
            CredentialKind::Rdp => vault.default_rdp_credential_id = normalized_id,
        }
        self.save_at(path)?;
        self.status_at(path)
    }

    fn get_summary(&self, credential_id: &str) -> Result<CredentialSummary, String> {
        self.unlocked_vault()?
            .summaries()
            .into_iter()
            .find(|summary| summary.id == credential_id)
            .ok_or_else(|| format!("No credential found for id {credential_id}"))
    }

    fn save_at(&self, path: &Path) -> Result<(), String> {
        let vault = self.unlocked_vault()?;
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| "Credential store is locked.".to_string())?;
        let header = self
            .header
            .as_ref()
            .ok_or_else(|| "Credential store encryption header is unavailable.".to_string())?;
        let encrypted = encrypt_vault(vault, key, &header.kdf)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create credentials directory: {error}"))?;
        }
        let contents = serde_json::to_string_pretty(&encrypted)
            .map_err(|error| format!("Could not serialize encrypted credentials: {error}"))?;
        fs::write(path, contents).map_err(|error| format!("Could not write credentials: {error}"))
    }

    fn unlocked_vault(&self) -> Result<&CredentialVault, String> {
        self.vault
            .as_ref()
            .ok_or_else(|| "Credential store is locked.".to_string())
    }

    fn unlocked_vault_mut(&mut self) -> Result<&mut CredentialVault, String> {
        self.vault
            .as_mut()
            .ok_or_else(|| "Credential store is locked.".to_string())
    }
}

impl CredentialVault {
    fn summaries(&self) -> Vec<CredentialSummary> {
        let mut summaries = self
            .credentials
            .iter()
            .map(|credential| CredentialSummary {
                id: credential.id.clone(),
                label: credential.label.clone(),
                kind: credential.kind,
                username: credential.username.clone(),
                domain: credential.domain.clone(),
                ssh_auth_mode: credential.ssh_auth_mode,
                rdp_security_mode: credential.rdp_security_mode.clone(),
                is_default: match credential.kind {
                    CredentialKind::Ssh => {
                        self.default_ssh_credential_id.as_deref() == Some(&credential.id)
                    }
                    CredentialKind::Rdp => {
                        self.default_rdp_credential_id.as_deref() == Some(&credential.id)
                    }
                },
                updated_at: credential.updated_at.clone(),
            })
            .collect::<Vec<_>>();
        summaries.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        summaries
    }

    fn clear_invalid_defaults(&mut self) {
        if !self.default_ssh_credential_id.as_deref().is_some_and(|id| {
            self.credentials
                .iter()
                .any(|credential| credential.id == id && credential.kind == CredentialKind::Ssh)
        }) {
            self.default_ssh_credential_id = None;
        }
        if !self.default_rdp_credential_id.as_deref().is_some_and(|id| {
            self.credentials
                .iter()
                .any(|credential| credential.id == id && credential.kind == CredentialKind::Rdp)
        }) {
            self.default_rdp_credential_id = None;
        }
    }
}

fn normalize_credential_request(
    request: UpsertCredentialRequest,
    vault: &CredentialVault,
) -> Result<CredentialRecord, String> {
    let label = trimmed_required(&request.label, "Credential label")?;
    let now = Utc::now().to_rfc3339();
    let existing = request.id.as_deref().and_then(|id| {
        vault
            .credentials
            .iter()
            .find(|credential| credential.id == id)
    });
    let id = request
        .id
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = existing
        .map(|credential| credential.created_at.clone())
        .unwrap_or_else(|| now.clone());

    let mut credential = CredentialRecord {
        id,
        label,
        kind: request.kind,
        username: trim_optional(request.username),
        password: trim_optional(request.password.clone()),
        domain: None,
        ssh_auth_mode: None,
        ssh_key_path: None,
        ssh_private_key_content: None,
        rdp_security_mode: None,
        created_at,
        updated_at: now,
    };

    match request.kind {
        CredentialKind::Ssh => {
            let auth_mode = request.ssh_auth_mode.unwrap_or(SshAuthMode::Password);
            credential.ssh_auth_mode = Some(auth_mode);
            match auth_mode {
                SshAuthMode::Password => {
                    credential.password = trim_optional(request.password);
                }
                SshAuthMode::PrivateKeyPath => {
                    credential.ssh_key_path = Some(trimmed_required(
                        request.ssh_key_path.as_deref().unwrap_or_default(),
                        "SSH key path",
                    )?);
                    credential.password = None;
                }
                SshAuthMode::PrivateKeyContent => {
                    credential.ssh_private_key_content = Some(trimmed_required(
                        request
                            .ssh_private_key_content
                            .as_deref()
                            .unwrap_or_default(),
                        "SSH private key",
                    )?);
                    credential.password = None;
                }
            }
        }
        CredentialKind::Rdp => {
            credential.domain = trim_optional(request.domain);
            credential.rdp_security_mode =
                trim_optional(request.rdp_security_mode).or_else(|| Some("auto".to_string()));
        }
    }

    Ok(credential)
}

fn read_encrypted_file(path: &Path) -> Result<EncryptedCredentialFile, String> {
    let contents =
        fs::read_to_string(path).map_err(|error| format!("Could not read credentials: {error}"))?;
    let encrypted: EncryptedCredentialFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Could not parse credentials: {error}"))?;
    if encrypted.version != VAULT_VERSION {
        return Err("Unsupported credentials vault version.".to_string());
    }
    Ok(encrypted)
}

fn encrypt_vault(
    vault: &CredentialVault,
    key: &[u8; KEY_LEN],
    kdf: &KdfParams,
) -> Result<EncryptedCredentialFile, String> {
    let plaintext = serde_json::to_vec(vault)
        .map_err(|error| format!("Could not serialize credential vault: {error}"))?;
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Could not initialize credential cipher.".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| "Could not encrypt credential vault.".to_string())?;
    Ok(EncryptedCredentialFile {
        version: VAULT_VERSION,
        kdf: kdf.clone(),
        cipher: CipherParams {
            algorithm: "aes-256-gcm".to_string(),
            nonce: STANDARD.encode(nonce_bytes),
        },
        ciphertext: STANDARD.encode(ciphertext),
    })
}

fn decrypt_vault(
    encrypted: &EncryptedCredentialFile,
    key: &[u8; KEY_LEN],
) -> Result<CredentialVault, String> {
    if encrypted.cipher.algorithm != "aes-256-gcm" {
        return Err("Unsupported credentials cipher.".to_string());
    }
    let nonce = decode_fixed::<NONCE_LEN>(&encrypted.cipher.nonce, "credential nonce")?;
    let ciphertext = STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|_| "Could not decode credential ciphertext.".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Could not initialize credential cipher.".to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "Could not unlock credentials. Check the master passphrase.".to_string())?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Could not parse unlocked credential vault: {error}"))
}

fn derive_key(passphrase: &str, params: &KdfParams) -> Result<[u8; KEY_LEN], String> {
    if params.algorithm != "argon2id" {
        return Err("Unsupported credentials KDF.".to_string());
    }
    let salt = decode_fixed::<SALT_LEN>(&params.salt, "credential salt")?;
    let argon_params = Params::new(
        params.memory_cost,
        params.time_cost,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|error| format!("Could not configure credential KDF: {error}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = [0_u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|error| format!("Could not derive credential key: {error}"))?;
    Ok(key)
}

fn new_kdf_params() -> Result<KdfParams, String> {
    let mut salt = [0_u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    Ok(KdfParams {
        algorithm: "argon2id".to_string(),
        memory_cost: ARGON2_MEMORY_COST,
        time_cost: ARGON2_TIME_COST,
        parallelism: ARGON2_PARALLELISM,
        salt: STANDARD.encode(salt),
    })
}

fn decode_fixed<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| format!("Could not decode {label}."))?;
    decoded
        .try_into()
        .map_err(|_| format!("Invalid {label} length."))
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.trim().is_empty() {
        return Err("Enter a master passphrase to unlock credentials.".to_string());
    }
    Ok(())
}

fn trimmed_required(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{label} is required."))
    } else {
        Ok(trimmed.to_string())
    }
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ssh_password_request(label: &str, password: &str) -> UpsertCredentialRequest {
        UpsertCredentialRequest {
            id: None,
            label: label.to_string(),
            kind: CredentialKind::Ssh,
            username: Some("ec2-user".to_string()),
            password: Some(password.to_string()),
            domain: None,
            ssh_auth_mode: Some(SshAuthMode::Password),
            ssh_key_path: None,
            ssh_private_key_content: None,
            rdp_security_mode: None,
        }
    }

    #[test]
    fn encrypts_decrypts_and_rejects_wrong_passphrase() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let mut store = CredentialStore::default();

        store.unlock_at(&path, "correct horse").unwrap();
        let summary = store
            .upsert_at(&path, ssh_password_request("Lab SSH", "secret-password"))
            .unwrap();
        store.lock();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("secret-password"));
        assert!(!raw.contains("ec2-user"));

        let mut wrong = CredentialStore::default();
        assert!(wrong.unlock_at(&path, "wrong").is_err());

        let mut reopened = CredentialStore::default();
        reopened.unlock_at(&path, "correct horse").unwrap();
        let credential = reopened.get(&summary.id).unwrap();
        assert_eq!(credential.password.as_deref(), Some("secret-password"));
    }

    #[test]
    fn stores_per_protocol_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        let mut store = CredentialStore::default();

        store.unlock_at(&path, "correct horse").unwrap();
        let summary = store
            .upsert_at(&path, ssh_password_request("Lab SSH", "secret-password"))
            .unwrap();
        let status = store
            .set_default_at(&path, CredentialKind::Ssh, Some(summary.id.clone()))
            .unwrap();

        assert_eq!(
            status.default_ssh_credential_id.as_deref(),
            Some(summary.id.as_str())
        );
        assert_eq!(store.list().unwrap()[0].is_default, true);
    }
}
