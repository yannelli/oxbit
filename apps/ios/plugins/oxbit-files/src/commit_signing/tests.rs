use super::{commit_signer, commit_signing, validate_commit_signing_request, CommitSigner};
use pgp::composed::{ArmorOptions, EncryptionCaps, KeyType, SecretKeyParamsBuilder};
use serde_json::{json, Value};
use std::cell::RefCell;

/// Mirrors CommitSigning.swift: one stored key plus the switch, returned in full after each operation.
#[derive(Default)]
struct Store(RefCell<(Option<String>, bool)>);

impl Store {
    fn handle(&self, request: Value) -> crate::Result<Value> {
        let mut state = self.0.borrow_mut();
        match request["operation"].as_str() {
            Some("read") => {}
            Some("save") => state.0 = request["secretKey"].as_str().map(str::to_owned),
            Some("setEnabled") if state.0.is_some() => state.1 = request["enabled"] == true,
            Some("remove") => *state = (None, false),
            _ => return Err(crate::Error::Unsupported("unexpected store request")),
        }
        Ok(json!({ "secretKey": state.0, "enabled": state.1 }))
    }

    fn run(&self, request: Value) -> crate::Result<Value> {
        commit_signing(validate_commit_signing_request(request)?, |stored| {
            self.handle(stored)
        })
    }
}

fn protected_key(passphrase: &str) -> String {
    SecretKeyParamsBuilder::default()
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id("Imported Author <imported@example.test>".into())
        .passphrase(Some(passphrase.into()))
        .build()
        .unwrap()
        .generate(rand::thread_rng())
        .unwrap()
        .to_armored_string(ArmorOptions::default())
        .unwrap()
}

#[test]
fn public_commit_signing_rejects_internal_operations() {
    for request in [
        json!({ "operation": "get" }),
        json!({ "operation": "generate", "name": "A", "email": "a@example.test" }),
        json!({ "operation": "import", "secretKey": "key" }),
        json!({ "operation": "import", "secretKey": "key", "passphrase": "secret" }),
        json!({ "operation": "setEnabled", "enabled": true }),
        json!({ "operation": "remove" }),
    ] {
        assert!(validate_commit_signing_request(request).is_ok());
    }
    for request in [
        json!({ "operation": "read" }),
        json!({ "operation": "save", "secretKey": "key" }),
        json!({ "operation": "get", "secretKey": "key" }),
        json!({ "operation": "setEnabled", "enabled": "true" }),
        json!({ "operation": "import", "secretKey": "k".repeat(64 * 1024 + 1) }),
        json!({}),
        json!({ "operation": 1 }),
    ] {
        assert!(validate_commit_signing_request(request).is_err());
    }
}

#[test]
fn generated_keys_return_metadata_and_sign_when_enabled() {
    let store = Store::default();
    assert_eq!(
        store.run(json!({ "operation": "get" })).unwrap(),
        json!({ "enabled": false })
    );
    let generated = store
        .run(json!({ "operation": "generate", "name": "Example Author", "email": "author@example.test" }))
        .unwrap();
    assert_eq!(generated["enabled"], false);
    let key = generated["key"].as_object().unwrap();
    let mut fields = key.keys().map(String::as_str).collect::<Vec<_>>();
    fields.sort_unstable();
    assert_eq!(
        fields,
        ["createdAt", "fingerprint", "keyId", "publicKey", "userIds"]
    );
    assert_eq!(
        key["userIds"],
        json!(["Example Author <author@example.test>"])
    );
    assert_eq!(key["fingerprint"].as_str().unwrap().len(), 40);
    assert!(key["fingerprint"]
        .as_str()
        .unwrap()
        .ends_with(key["keyId"].as_str().unwrap()));
    assert!(key["publicKey"]
        .as_str()
        .unwrap()
        .starts_with("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
    assert!(!generated.to_string().contains("PRIVATE KEY"));

    let stored = || store.handle(json!({ "operation": "read" })).unwrap();
    assert!(commit_signer(stored()).unwrap().is_none());
    let enabled = store
        .run(json!({ "operation": "setEnabled", "enabled": true }))
        .unwrap();
    assert_eq!(enabled["enabled"], true);
    assert_eq!(enabled["key"], generated["key"]);
    let signer = commit_signer(stored()).unwrap().unwrap();
    let signature = signer.sign(b"tree 0000\n\nmessage\n").unwrap();
    assert!(signature.starts_with("-----BEGIN PGP SIGNATURE-----"));
    signer
        .verify(b"tree 0000\n\nmessage\n", &signature)
        .unwrap();
    assert!(signer
        .verify(b"tree 0000\n\nchanged\n", &signature)
        .is_err());

    assert_eq!(
        store.run(json!({ "operation": "remove" })).unwrap(),
        json!({ "enabled": false })
    );
    assert!(commit_signer(stored()).unwrap().is_none());
}

#[test]
fn imports_passphrase_protected_keys() {
    let armored = protected_key("correct horse");
    let store = Store::default();
    let missing = store
        .run(json!({ "operation": "import", "secretKey": armored }))
        .unwrap_err();
    assert!(missing.to_string().contains("passphrase"));
    assert!(store
        .run(json!({ "operation": "import", "secretKey": armored, "passphrase": "wrong" }))
        .is_err());
    let imported = store
        .run(json!({ "operation": "import", "secretKey": armored, "passphrase": "correct horse" }))
        .unwrap();
    assert_eq!(
        imported["key"]["userIds"],
        json!(["Imported Author <imported@example.test>"])
    );
    let saved = store.0.borrow().0.clone().unwrap();
    let signer = CommitSigner::from_armored(&saved).unwrap();
    let signature = signer.sign(b"commit").unwrap();
    CommitSigner::import(&armored, Some("correct horse"))
        .unwrap()
        .verify(b"commit", &signature)
        .unwrap();
}

#[test]
fn rejects_invalid_keys_and_identities() {
    let store = Store::default();
    for secret_key in [
        "not a key",
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n-----END PGP PUBLIC KEY BLOCK-----",
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nAAAA\n-----END PGP PRIVATE KEY BLOCK-----",
    ] {
        assert!(store
            .run(json!({ "operation": "import", "secretKey": secret_key }))
            .is_err());
    }
    for (name, email) in [
        ("", "a@example.test"),
        ("A", ""),
        ("A <b>", "a@example.test"),
        ("A", "no-at"),
    ] {
        assert!(store
            .run(json!({ "operation": "generate", "name": name, "email": email }))
            .is_err());
    }
    assert!(store
        .run(json!({ "operation": "setEnabled", "enabled": true }))
        .is_err());
    assert!(commit_signer(json!({ "secretKey": "broken", "enabled": true })).is_err());
    assert!(
        commit_signer(json!({ "secretKey": "broken", "enabled": false }))
            .unwrap()
            .is_none()
    );
}
