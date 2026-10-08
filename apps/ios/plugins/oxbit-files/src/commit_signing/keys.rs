use pgp::{
    composed::{
        ArmorOptions, Deserializable, DetachedSignature, EncryptionCaps, KeyType,
        SecretKeyParamsBuilder, SignedPublicKey, SignedSecretKey,
    },
    crypto::hash::HashAlgorithm,
    types::{KeyDetails, Password, SigningKey},
};
use serde_json::{json, Value};

use crate::{Error, Result};

pub(crate) const MAX_ARMORED_KEY_BYTES: usize = 64 * 1024;

/// An unlocked OpenPGP secret key that signs commit buffers with SHA-256.
pub struct CommitSigner {
    key: SignedSecretKey,
}

fn failure(message: impl Into<String>) -> Error {
    Error::CommitSigning(message.into())
}

impl CommitSigner {
    /// Creates a v4 EdDSA (legacy Ed25519) key, the key type `git verify-commit` accepts under GnuPG.
    pub fn generate(name: &str, email: &str) -> Result<Self> {
        let user_id = user_id(name, email)?;
        let params = SecretKeyParamsBuilder::default()
            .key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .can_encrypt(EncryptionCaps::None)
            .primary_user_id(user_id)
            .build()
            .map_err(|_| failure("Could not prepare the signing key."))?;
        let key = params
            .generate(rand::thread_rng())
            .map_err(|_| failure("Could not generate the signing key."))?;
        Self::new(key)
    }

    /// Parses an armored secret key and removes its passphrase protection.
    pub fn import(armored: &str, passphrase: Option<&str>) -> Result<Self> {
        let mut key = parse(armored)?;
        let locked = key.primary_key.secret_params().is_encrypted()
            || key
                .secret_subkeys
                .iter()
                .any(|subkey| subkey.key.secret_params().is_encrypted());
        if locked {
            let passphrase = passphrase
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    failure(
                        "This key is protected by a passphrase. Enter the passphrase to import it.",
                    )
                })?;
            let password = Password::from(passphrase);
            let wrong = |_| failure("The passphrase does not unlock this key.");
            key.primary_key.remove_password(&password).map_err(wrong)?;
            for subkey in &mut key.secret_subkeys {
                subkey.key.remove_password(&password).map_err(wrong)?;
            }
        }
        Self::new(key)
    }

    /// Reads a key saved by [`CommitSigner::secret_armored`].
    pub fn from_armored(armored: &str) -> Result<Self> {
        Self::new(parse(armored)?)
    }

    fn new(key: SignedSecretKey) -> Result<Self> {
        key.verify_bindings()
            .map_err(|_| failure("The key's self-signatures are invalid."))?;
        let signer = Self { key };
        signer.signing_key()?;
        Ok(signer)
    }

    /// Picks the primary key when its self-signature allows signing, otherwise the first signing subkey.
    fn signing_key(&self) -> Result<&dyn SigningKey> {
        let primary_signs = self
            .key
            .details
            .users
            .iter()
            .flat_map(|user| &user.signatures)
            .chain(&self.key.details.direct_signatures)
            .any(|signature| signature.key_flags().sign());
        if primary_signs && !self.key.primary_key.secret_params().is_encrypted() {
            return Ok(&self.key.primary_key);
        }
        self.key
            .secret_subkeys
            .iter()
            .find(|subkey| {
                !subkey.key.secret_params().is_encrypted()
                    && subkey
                        .signatures
                        .iter()
                        .any(|signature| signature.key_flags().sign())
            })
            .map(|subkey| &subkey.key as &dyn SigningKey)
            .ok_or_else(|| failure("This key has no secret key that can sign."))
    }

    /// Returns an armored detached signature for `commit_signed`.
    pub fn sign(&self, buffer: &[u8]) -> Result<String> {
        let signature = DetachedSignature::sign_binary_data(
            rand::thread_rng(),
            &Box::new(self.signing_key()?),
            &Password::empty(),
            HashAlgorithm::Sha256,
            buffer,
        )
        .map_err(|_| failure("Could not sign the commit."))?;
        signature
            .to_armored_string(ArmorOptions::default())
            .map_err(|_| failure("Could not encode the commit signature."))
    }

    /// Checks an armored detached signature against this key and its subkeys.
    pub fn verify(&self, buffer: &[u8], armored_signature: &str) -> Result<()> {
        let (signature, _) = DetachedSignature::from_string(armored_signature)
            .map_err(|_| failure("The signature could not be read."))?;
        let public = self.public_key();
        let verified = signature.verify(&public.primary_key, buffer).is_ok()
            || public
                .public_subkeys
                .iter()
                .any(|subkey| signature.verify(&subkey.key, buffer).is_ok());
        verified
            .then_some(())
            .ok_or_else(|| failure("The signature does not match this key."))
    }

    pub fn secret_armored(&self) -> Result<String> {
        self.key
            .to_armored_string(ArmorOptions::default())
            .map_err(|_| failure("Could not encode the signing key."))
    }

    fn public_key(&self) -> SignedPublicKey {
        self.key.to_public_key()
    }

    pub fn public_armored(&self) -> Result<String> {
        self.public_key()
            .to_armored_string(ArmorOptions::default())
            .map_err(|_| failure("Could not encode the public key."))
    }

    pub fn user_ids(&self) -> Vec<String> {
        self.key
            .details
            .users
            .iter()
            .filter_map(|user| user.id.as_str().map(str::to_owned))
            .collect()
    }

    /// Public metadata for the settings screen. The secret key stays out of this value.
    pub fn metadata(&self) -> Result<Value> {
        let primary = &self.key.primary_key;
        let key_id: String = primary
            .legacy_key_id()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        Ok(json!({
            "fingerprint": format!("{:X}", primary.fingerprint()),
            "keyId": key_id,
            "userIds": self.user_ids(),
            "createdAt": primary.created_at().as_secs(),
            "publicKey": self.public_armored()?,
        }))
    }
}

fn parse(armored: &str) -> Result<SignedSecretKey> {
    if armored.len() > MAX_ARMORED_KEY_BYTES {
        return Err(failure("The key is too large."));
    }
    if !armored.contains("-----BEGIN PGP PRIVATE KEY BLOCK-----") {
        return Err(failure(
            "Paste an armored secret key that starts with -----BEGIN PGP PRIVATE KEY BLOCK-----.",
        ));
    }
    SignedSecretKey::from_string(armored)
        .map(|(key, _)| key)
        .map_err(|_| failure("The secret key could not be read."))
}

fn user_id(name: &str, email: &str) -> Result<String> {
    let name = name.trim();
    let email = email.trim();
    let valid = |value: &str, limit: usize| {
        !value.is_empty()
            && value.chars().count() <= limit
            && !value
                .chars()
                .any(|character| character.is_control() || matches!(character, '<' | '>'))
    };
    if !valid(name, 256) || !valid(email, 320) || !email.contains('@') {
        return Err(failure(
            "Save a Git author name and email before creating a signing key.",
        ));
    }
    Ok(format!("{name} <{email}>"))
}
