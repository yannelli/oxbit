use crate::fs_core::{Error, Result};
use serde_json::Value;
use std::io::{self, Write};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_VALUE_COUNT: usize = 16_384;
const MAX_VALUE_DEPTH: usize = 32;
const MAX_OUTPUT_BYTES: usize = 4096;

struct RequestBudget(usize);

impl Write for RequestBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Request limit"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn validate_request_id(request_id: &str) -> Result<()> {
    if request_id.len() != 36 || uuid::Uuid::parse_str(request_id).is_err() {
        return Err(Error::invalid("Git request ID must be a UUID"));
    }
    Ok(())
}

fn validate_structure(value: &Value, depth: usize, remaining: &mut usize) -> Result<()> {
    if depth > MAX_VALUE_DEPTH || *remaining == 0 {
        return Err(Error::invalid("Git request parameters exceed the limit"));
    }
    *remaining -= 1;
    match value {
        Value::Array(values) => {
            for value in values {
                validate_structure(value, depth + 1, remaining)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_structure(value, depth + 1, remaining)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_request(method: &str, params: &Value) -> Result<()> {
    if method.is_empty()
        || method.len() > 64
        || !method.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(Error::invalid("Invalid Git method"));
    }
    let object = params
        .as_object()
        .ok_or_else(|| Error::invalid("Git request parameters must be an object"))?;
    if [
        "token",
        "password",
        "credentials",
        "authorization",
        "root",
        "rootPath",
        "cwd",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
    {
        return Err(Error::invalid(
            "Git credentials and roots are managed natively",
        ));
    }
    let mut remaining = MAX_VALUE_COUNT;
    validate_structure(params, 0, &mut remaining)?;
    serde_json::to_writer(RequestBudget(MAX_REQUEST_BYTES), params)
        .map_err(|_| Error::invalid("Git request parameters exceed the limit"))
}

pub(crate) fn safe_output(data: &str, token: Option<&str>) -> String {
    let output = match token.filter(|token| !token.is_empty()) {
        Some(token) => data.replace(token, "[redacted]"),
        None => data.to_owned(),
    };
    if ["Authorization:", "Bearer ", "Basic "]
        .iter()
        .any(|marker| output.contains(marker))
    {
        return "Git authentication output omitted".to_owned();
    }
    let filtered: String = output
        .chars()
        .filter(|character| !character.is_control() || matches!(*character, '\n' | '\r' | '\t'))
        .collect();
    let mut end = filtered.len().min(MAX_OUTPUT_BYTES);
    while !filtered.is_char_boundary(end) {
        end -= 1;
    }
    filtered[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::{safe_output, validate_request, validate_request_id, MAX_OUTPUT_BYTES};
    use serde_json::json;

    #[test]
    fn request_validation_bounds_input_and_rejects_native_overrides() {
        assert!(validate_request("commitDiff", &json!({ "path": "README.md" })).is_ok());
        for params in [
            json!([]),
            json!({ "token": "fixture" }),
            json!({ "root": "/tmp" }),
        ] {
            assert!(validate_request("status", &params).is_err());
        }
        assert!(
            validate_request("status", &json!({ "message": "x".repeat(1024 * 1024) })).is_err()
        );
        assert!(validate_request("git.status", &json!({})).is_err());
        assert!(validate_request(&"s".repeat(65), &json!({})).is_err());
        assert!(validate_request_id("07fc5bfa-51f0-4af9-8e0e-54a4a27e46fb").is_ok());
        assert!(validate_request_id("request").is_err());
    }

    #[test]
    fn progress_and_errors_redact_credentials_and_bound_utf8() {
        assert_eq!(
            safe_output("remote fixture-token", Some("fixture-token")),
            "remote [redacted]"
        );
        assert_eq!(
            safe_output("Authorization: Bearer fixture", None),
            "Git authentication output omitted"
        );
        assert_eq!(safe_output("fetch\0\u{1b} 50%\n", None), "fetch 50%\n");
        let bounded = safe_output(&"日".repeat(MAX_OUTPUT_BYTES), None);
        assert!(bounded.len() <= MAX_OUTPUT_BYTES);
        assert!(bounded.chars().all(|character| character == '日'));
    }
}
