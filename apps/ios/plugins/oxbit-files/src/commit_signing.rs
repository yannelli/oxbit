use serde::Deserialize;
use serde_json::{json, Value};

use crate::Result;

mod keys;

pub use keys::CommitSigner;

/// Operations the webview may send. `read` and `save` carry the secret key and stay native-only.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CommitSigningRequest {
    Get {},
    Generate {
        name: String,
        email: String,
    },
    Import {
        #[serde(rename = "secretKey")]
        secret_key: String,
        passphrase: Option<String>,
    },
    SetEnabled {
        enabled: bool,
    },
    Remove {},
}

#[derive(Deserialize)]
struct StoredSigning {
    #[serde(rename = "secretKey")]
    secret_key: Option<String>,
    #[serde(default)]
    enabled: bool,
}

pub(crate) fn validate_commit_signing_request(request: Value) -> Result<CommitSigningRequest> {
    let request: CommitSigningRequest = serde_json::from_value(request)
        .map_err(|_| crate::Error::Unsupported("Unknown commit signing operation."))?;
    if let CommitSigningRequest::Import {
        secret_key,
        passphrase,
    } = &request
    {
        if secret_key.len() > keys::MAX_ARMORED_KEY_BYTES
            || passphrase.as_ref().is_some_and(|value| value.len() > 1024)
        {
            return Err(crate::Error::Unsupported(
                "The key or passphrase is too long.",
            ));
        }
    }
    Ok(request)
}

/// Runs a validated request against the native store and returns metadata without the secret key.
pub(crate) fn commit_signing(
    request: CommitSigningRequest,
    store: impl Fn(Value) -> Result<Value>,
) -> Result<Value> {
    let save = |signer: CommitSigner| {
        store(json!({ "operation": "save", "secretKey": signer.secret_armored()? }))
    };
    let stored = match request {
        CommitSigningRequest::Get {} => store(json!({ "operation": "read" }))?,
        CommitSigningRequest::Generate { name, email } => {
            save(CommitSigner::generate(&name, &email)?)?
        }
        CommitSigningRequest::Import {
            secret_key,
            passphrase,
        } => save(CommitSigner::import(&secret_key, passphrase.as_deref())?)?,
        CommitSigningRequest::SetEnabled { enabled } => {
            store(json!({ "operation": "setEnabled", "enabled": enabled }))?
        }
        CommitSigningRequest::Remove {} => store(json!({ "operation": "remove" }))?,
    };
    commit_signing_metadata(stored)
}

pub(crate) fn commit_signing_metadata(stored: Value) -> Result<Value> {
    let stored = parse_stored(stored)?;
    let mut metadata = json!({ "enabled": stored.enabled && stored.secret_key.is_some() });
    if let Some(secret_key) = stored.secret_key {
        metadata["key"] = stored_signer(&secret_key)?.metadata()?;
    }
    Ok(metadata)
}

/// Returns the signer for new commits, or nothing while signing is off.
pub(crate) fn commit_signer(stored: Value) -> Result<Option<CommitSigner>> {
    match parse_stored(stored)? {
        StoredSigning {
            secret_key: Some(secret_key),
            enabled: true,
        } => stored_signer(&secret_key).map(Some),
        _ => Ok(None),
    }
}

fn parse_stored(stored: Value) -> Result<StoredSigning> {
    serde_json::from_value(stored)
        .map_err(|_| crate::Error::Unsupported("Invalid commit signing response."))
}

fn stored_signer(secret_key: &str) -> Result<CommitSigner> {
    CommitSigner::from_armored(secret_key).map_err(|_| {
        crate::Error::CommitSigning(
            "The saved signing key could not be read. Remove it and add a key again.".into(),
        )
    })
}

#[cfg(test)]
mod tests;
