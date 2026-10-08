use crate::Result;
use serde_json::Value;

pub(crate) fn validate_git_credential_request(request: &Value) -> Result<()> {
    match request.get("operation").and_then(Value::as_str) {
        Some("get" | "save" | "addGitHub" | "addGitea" | "remove" | "setDefault") => Ok(()),
        _ => Err(crate::Error::Unsupported(
            "Unknown Git credential operation.",
        )),
    }
}

fn account_metadata(account: &Value) -> Option<Value> {
    let mut metadata = serde_json::Map::new();
    for field in ["id", "provider", "host", "login"] {
        metadata.insert(field.into(), account.get(field)?.as_str()?.into());
    }
    metadata.insert(
        "isDefault".into(),
        account.get("isDefault")?.as_bool()?.into(),
    );
    if let Some(url) = account.get("url") {
        metadata.insert("url".into(), url.as_str()?.into());
    }
    Some(metadata.into())
}

/// Copies the author and per-account metadata; tokens and unknown fields are dropped.
pub(crate) fn git_credential_metadata(response: Value) -> Result<Value> {
    let invalid = crate::Error::Unsupported("Invalid Git credential response.");
    let accounts = response
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or(crate::Error::Unsupported(
            "Invalid Git credential response.",
        ))?
        .iter()
        .map(account_metadata)
        .collect::<Option<Vec<_>>>()
        .ok_or(invalid)?;
    let mut metadata = serde_json::Map::new();
    for field in ["name", "email"] {
        if let Some(value) = response.get(field).and_then(Value::as_str) {
            metadata.insert(field.into(), value.into());
        }
    }
    metadata.insert("accounts".into(), accounts.into());
    Ok(metadata.into())
}

#[cfg(test)]
mod tests {
    use super::{git_credential_metadata, validate_git_credential_request};
    use serde_json::json;

    #[test]
    fn public_git_credentials_reject_internal_reads() {
        for operation in [
            "get",
            "save",
            "addGitHub",
            "addGitea",
            "remove",
            "setDefault",
        ] {
            assert!(validate_git_credential_request(&json!({ "operation": operation })).is_ok());
        }
        for request in [
            json!({ "operation": "read" }),
            json!({ "operation": "connectGitea" }),
            json!({}),
            json!({ "operation": 1 }),
        ] {
            assert!(validate_git_credential_request(&request).is_err());
        }
    }

    #[test]
    fn public_git_credentials_return_metadata() {
        let response = git_credential_metadata(json!({
            "name": "Example Author",
            "email": "author@example.com",
            "token": "legacy-fixture",
            "accounts": [
                {
                    "id": "00000000-0000-0000-0000-000000000001",
                    "provider": "github",
                    "host": "github.com",
                    "login": "octocat",
                    "token": "credential-fixture",
                    "isDefault": true,
                },
                {
                    "id": "00000000-0000-0000-0000-000000000002",
                    "provider": "gitea",
                    "host": "git.example.test",
                    "url": "https://git.example.test",
                    "login": "gitea-user",
                    "token": "gitea-fixture",
                    "isDefault": false,
                    "extra": "dropped",
                },
            ],
        }))
        .unwrap();
        assert_eq!(
            response,
            json!({
                "name": "Example Author",
                "email": "author@example.com",
                "accounts": [
                    {
                        "id": "00000000-0000-0000-0000-000000000001",
                        "provider": "github",
                        "host": "github.com",
                        "login": "octocat",
                        "isDefault": true,
                    },
                    {
                        "id": "00000000-0000-0000-0000-000000000002",
                        "provider": "gitea",
                        "host": "git.example.test",
                        "url": "https://git.example.test",
                        "login": "gitea-user",
                        "isDefault": false,
                    },
                ],
            })
        );
        assert!(!response.to_string().contains("fixture"));
    }

    #[test]
    fn public_git_credentials_require_account_metadata() {
        assert!(git_credential_metadata(json!({ "token": "credential-fixture" })).is_err());
        assert!(git_credential_metadata(json!({ "accounts": {} })).is_err());
        for account in [
            json!({ "id": "a", "provider": "github", "host": "github.com", "login": "octocat" }),
            json!({ "id": "a", "provider": "github", "host": "github.com", "login": 1, "isDefault": true }),
            json!({ "id": "a", "provider": "gitea", "host": "h", "login": "u", "isDefault": true, "url": 1 }),
        ] {
            assert!(git_credential_metadata(json!({ "accounts": [account] })).is_err());
        }
        assert_eq!(
            git_credential_metadata(json!({ "accounts": [] })).unwrap(),
            json!({ "accounts": [] })
        );
    }
}
