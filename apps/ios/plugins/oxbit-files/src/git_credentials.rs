use crate::Result;

pub(crate) fn validate_git_credential_request(request: &serde_json::Value) -> Result<()> {
    match request.get("operation").and_then(serde_json::Value::as_str) {
        Some("get" | "save" | "forget") => Ok(()),
        _ => Err(crate::Error::Unsupported(
            "Unknown Git credential operation.",
        )),
    }
}

pub(crate) fn git_credential_metadata(response: serde_json::Value) -> Result<serde_json::Value> {
    let authenticated = response
        .get("authenticated")
        .and_then(serde_json::Value::as_bool)
        .ok_or(crate::Error::Unsupported(
            "Invalid Git credential response.",
        ))?;
    let mut metadata = serde_json::Map::new();
    metadata.insert("authenticated".into(), authenticated.into());
    for field in ["login", "name", "email"] {
        if let Some(value) = response.get(field).and_then(serde_json::Value::as_str) {
            metadata.insert(field.into(), value.into());
        }
    }
    Ok(metadata.into())
}

#[cfg(test)]
mod tests {
    use super::{git_credential_metadata, validate_git_credential_request};
    use serde_json::json;

    #[test]
    fn public_git_credentials_reject_internal_reads() {
        for operation in ["get", "save", "forget"] {
            assert!(validate_git_credential_request(&json!({ "operation": operation })).is_ok());
        }
        for request in [
            json!({ "operation": "read" }),
            json!({}),
            json!({ "operation": 1 }),
        ] {
            assert!(validate_git_credential_request(&request).is_err());
        }
    }

    #[test]
    fn public_git_credentials_return_metadata() {
        let response = git_credential_metadata(json!({
            "authenticated": true,
            "login": "octocat",
            "name": "Example Author",
            "email": "author@example.com",
            "token": "credential-fixture",
        }))
        .unwrap();
        assert_eq!(
            response,
            json!({
                "authenticated": true,
                "login": "octocat",
                "name": "Example Author",
                "email": "author@example.com",
            })
        );
    }

    #[test]
    fn public_git_credentials_require_authentication_metadata() {
        assert!(git_credential_metadata(json!({ "token": "credential-fixture" })).is_err());
        assert!(git_credential_metadata(json!({ "authenticated": "true" })).is_err());
        assert_eq!(
            git_credential_metadata(json!({ "authenticated": false })).unwrap(),
            json!({ "authenticated": false })
        );
    }
}
