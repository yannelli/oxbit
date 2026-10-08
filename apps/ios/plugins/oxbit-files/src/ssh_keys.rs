use crate::Result;

const KEY_FIELDS: [&str; 5] = ["id", "name", "algorithm", "fingerprint", "publicKey"];

pub(crate) fn validate_ssh_key_request(request: &serde_json::Value) -> Result<()> {
    match request.get("operation").and_then(serde_json::Value::as_str) {
        Some("list" | "delete") => Ok(()),
        _ => Err(crate::Error::Unsupported("Unknown SSH key operation.")),
    }
}

pub(crate) fn ssh_key_metadata(response: serde_json::Value) -> Result<serde_json::Value> {
    let invalid = || crate::Error::Unsupported("Invalid SSH key response.");
    let keys = response
        .get("keys")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(invalid)?;
    let mut metadata = Vec::with_capacity(keys.len());
    for key in keys {
        let mut entry = serde_json::Map::new();
        for field in KEY_FIELDS {
            let value = key
                .get(field)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            entry.insert(field.into(), value.into());
        }
        metadata.push(serde_json::Value::Object(entry));
    }
    Ok(serde_json::json!({ "keys": metadata }))
}

#[cfg(test)]
mod tests {
    use super::{ssh_key_metadata, validate_ssh_key_request};
    use serde_json::json;

    #[test]
    fn public_ssh_keys_reject_internal_operations() {
        for operation in ["list", "delete"] {
            assert!(validate_ssh_key_request(&json!({ "operation": operation })).is_ok());
        }
        for request in [
            json!({ "operation": "read", "id": "x" }),
            json!({ "operation": "save" }),
            json!({ "operation": "readPassword" }),
            json!({ "operation": "savePassword" }),
            json!({ "operation": "forgetPassword" }),
            json!({}),
            json!({ "operation": 1 }),
        ] {
            assert!(validate_ssh_key_request(&request).is_err());
        }
    }

    #[test]
    fn public_ssh_keys_return_metadata_only() {
        let response = ssh_key_metadata(json!({
            "keys": [{
                "id": "7d1a3c1e-7f1c-4d55-9a4f-3f0f3c2b9d10",
                "name": "iPhone",
                "algorithm": "ssh-ed25519",
                "fingerprint": "SHA256:fixture",
                "publicKey": "ssh-ed25519 AAAAfixture iPhone@oxbit-ios",
                "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----fixture",
                "password": "fixture",
            }],
        }))
        .unwrap();
        assert_eq!(
            response,
            json!({
                "keys": [{
                    "id": "7d1a3c1e-7f1c-4d55-9a4f-3f0f3c2b9d10",
                    "name": "iPhone",
                    "algorithm": "ssh-ed25519",
                    "fingerprint": "SHA256:fixture",
                    "publicKey": "ssh-ed25519 AAAAfixture iPhone@oxbit-ios",
                }],
            })
        );
        assert!(!response.to_string().contains("PRIVATE"));
    }

    #[test]
    fn public_ssh_keys_require_complete_entries() {
        assert!(ssh_key_metadata(json!({ "privateKey": "x" })).is_err());
        assert!(ssh_key_metadata(json!({ "keys": [{ "id": "x" }] })).is_err());
        assert_eq!(
            ssh_key_metadata(json!({ "keys": [] })).unwrap(),
            json!({ "keys": [] })
        );
    }
}
