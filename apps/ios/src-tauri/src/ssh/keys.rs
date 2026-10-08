//! SSH key generation and import. Private keys leave this module as unencrypted OpenSSH text
//! for the Keychain; the WebView receives only `KeyInfo`.
use crate::fs_core::{Error, Result};
use russh::keys::{
    decode_secret_key,
    ssh_key::{rand_core::UnwrapErr, Algorithm, HashAlg, LineEnding, PrivateKey},
    Error as KeyError,
};
use serde::{Deserialize, Serialize};

pub const MAX_KEY_TEXT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub id: String,
    pub name: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

pub struct KeyMaterial {
    pub info: KeyInfo,
    pub private_key: String,
}

pub fn key_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(Error::invalid("Enter a key name of up to 64 characters."));
    }
    Ok(name.to_string())
}

pub fn generate(name: &str) -> Result<KeyMaterial> {
    let name = key_name(name)?;
    let mut key = PrivateKey::random(&mut UnwrapErr(getrandom::SysRng), Algorithm::Ed25519)
        .map_err(|_| Error::new("KEY", "Could not generate an Ed25519 key."))?;
    key.set_comment(comment(&name));
    material(&key, name)
}

pub fn import(name: &str, text: &str, passphrase: Option<&str>) -> Result<KeyMaterial> {
    let name = key_name(name)?;
    if text.len() > MAX_KEY_TEXT_BYTES {
        return Err(Error::invalid("The key file is too large."));
    }
    let passphrase = passphrase.filter(|value| !value.is_empty());
    let key = decode_secret_key(text, passphrase).map_err(|error| match error {
        KeyError::KeyIsEncrypted => Error::new(
            "PASSPHRASE_REQUIRED",
            "This key is protected by a passphrase. Enter it to import the key.",
        ),
        _ if passphrase.is_some() => Error::new(
            "KEY_INVALID",
            "The passphrase is incorrect or the private key could not be read.",
        ),
        _ => Error::new(
            "KEY_INVALID",
            "Paste an OpenSSH, PEM, or PKCS#8 private key.",
        ),
    })?;
    material(&key, name)
}

pub fn decode(private_key: &str) -> Result<PrivateKey> {
    decode_secret_key(private_key, None)
        .map_err(|_| Error::new("KEY_INVALID", "The saved SSH key could not be read."))
}

fn comment(name: &str) -> String {
    let words: Vec<String> = name
        .split_whitespace()
        .map(|word| word.chars().filter(|c| c.is_ascii_graphic()).collect())
        .collect();
    format!("{}@oxbit-ios", words.join("-"))
}

fn material(key: &PrivateKey, name: String) -> Result<KeyMaterial> {
    let unreadable = || Error::new("KEY_INVALID", "The private key could not be encoded.");
    Ok(KeyMaterial {
        private_key: key
            .to_openssh(LineEnding::LF)
            .map_err(|_| unreadable())?
            .to_string(),
        info: KeyInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            algorithm: key.algorithm().as_str().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: key.public_key().to_openssh().map_err(|_| unreadable())?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::process::Command;

    fn keygen(directory: &std::path::Path, name: &str, args: &[&str]) -> String {
        let path = directory.join(name);
        let status = Command::new("ssh-keygen")
            .args(["-q", "-C", "fixture", "-f"])
            .arg(&path)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn generates_ed25519_keys_that_round_trip() {
        let generated = generate("iPhone key").unwrap();
        assert_eq!(generated.info.algorithm, "ssh-ed25519");
        assert!(generated.info.fingerprint.starts_with("SHA256:"));
        assert!(generated.info.public_key.starts_with("ssh-ed25519 AAAA"));
        assert!(generated.info.public_key.ends_with(" iPhone-key@oxbit-ios"));
        let decoded = decode(&generated.private_key).unwrap();
        assert_eq!(
            decoded.fingerprint(HashAlg::Sha256).to_string(),
            generated.info.fingerprint
        );
    }

    #[test]
    fn imports_pem_pkcs8_and_encrypted_openssh_keys() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-keys-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let rsa = ["-t", "rsa", "-b", "2048", "-N", ""];
        let pkcs1 = keygen(&directory, "pkcs1", &[&rsa[..], &["-m", "PEM"]].concat());
        let pkcs8 = keygen(&directory, "pkcs8", &[&rsa[..], &["-m", "PKCS8"]].concat());
        let encrypted = keygen(
            &directory,
            "locked",
            &["-t", "ed25519", "-N", "oxbit-fixture"],
        );
        std::fs::remove_dir_all(&directory).unwrap();
        for text in [&pkcs1, &pkcs8] {
            let imported = import("Server", text, None).unwrap();
            assert_eq!(imported.info.algorithm, "ssh-rsa");
            assert!(imported
                .private_key
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
            decode(&imported.private_key).unwrap();
        }
        assert_eq!(
            import("Locked", &encrypted, None).err().unwrap().code,
            "PASSPHRASE_REQUIRED"
        );
        assert_eq!(
            import("Locked", &encrypted, Some("wrong"))
                .err()
                .unwrap()
                .code,
            "KEY_INVALID"
        );
        let unlocked = import("Locked", &encrypted, Some("oxbit-fixture")).unwrap();
        assert_eq!(unlocked.info.algorithm, "ssh-ed25519");
        decode(&unlocked.private_key).unwrap();
    }

    #[test]
    fn rejects_invalid_names_and_text() {
        assert!(key_name("  ").is_err());
        assert!(key_name(&"k".repeat(65)).is_err());
        assert!(key_name("bad\nname").is_err());
        assert_eq!(
            import("Key", "not a key", None).err().unwrap().code,
            "KEY_INVALID"
        );
        assert!(import("Key", &"a".repeat(MAX_KEY_TEXT_BYTES + 1), None).is_err());
    }
}
