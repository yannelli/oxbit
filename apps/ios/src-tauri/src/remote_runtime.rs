//! The remote runtime manifest that the release workflow pins into the iOS build.

use serde::Deserialize;
use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/remote_runtime_manifest.rs"));

pub const PLATFORMS: [&str; 2] = ["darwin-arm64", "linux-x64"];
const RELEASE_DOWNLOADS: &str = "https://github.com/yannelli/oxbit/releases/download";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub platforms: BTreeMap<String, Payload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// `Ok(None)` when the build had no `OXBIT_REMOTE_RUNTIME_MANIFEST`.
pub fn pinned_manifest() -> Result<Option<Manifest>, String> {
    PINNED_MANIFEST
        .map(|text| parse(text, env!("CARGO_PKG_VERSION")))
        .transpose()
}

pub fn pinned_download(platform: &str) -> Result<Option<Download>, String> {
    pinned_manifest()?
        .map(|manifest| manifest.download(platform))
        .transpose()
}

pub fn parse(text: &str, app_version: &str) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_str(text)
        .map_err(|error| format!("Invalid remote runtime manifest: {error}"))?;
    if manifest.version != app_version {
        return Err(format!(
            "Remote runtime manifest is for {}; this app is {app_version}",
            manifest.version
        ));
    }
    if manifest.platforms.len() != PLATFORMS.len()
        || !PLATFORMS
            .iter()
            .all(|platform| manifest.platforms.contains_key(*platform))
    {
        return Err(format!(
            "Remote runtime manifest must list exactly {}",
            PLATFORMS.join(", ")
        ));
    }
    for (platform, payload) in &manifest.platforms {
        let hex = payload
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if payload.sha256.len() != 64 || !hex {
            return Err(format!("Invalid remote runtime sha256 for {platform}"));
        }
        if payload.size == 0 {
            return Err(format!("Empty remote runtime payload for {platform}"));
        }
    }
    Ok(manifest)
}

impl Manifest {
    pub fn download(&self, platform: &str) -> Result<Download, String> {
        let payload = self
            .platforms
            .get(platform)
            .ok_or_else(|| format!("Unsupported remote runtime platform: {platform}"))?;
        Ok(Download {
            url: format!(
                "{RELEASE_DOWNLOADS}/v{}/remote-runtime-{platform}.tar.gz",
                self.version
            ),
            sha256: payload.sha256.clone(),
            size: payload.size,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DARWIN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const LINUX: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn manifest(version: &str, platforms: &str) -> String {
        format!(r#"{{"version":"{version}","platforms":{{{platforms}}}}}"#)
    }

    fn both() -> String {
        format!(
            r#""darwin-arm64":{{"sha256":"{DARWIN}","size":52000000}},"linux-x64":{{"sha256":"{LINUX}","size":48000000}}"#
        )
    }

    #[test]
    fn parses_a_release_manifest_and_builds_download_urls() {
        let parsed = parse(&manifest("0.4.0-alpha.1", &both()), "0.4.0-alpha.1").unwrap();
        assert_eq!(
            parsed.download("linux-x64").unwrap(),
            Download {
                url: "https://github.com/yannelli/oxbit/releases/download/v0.4.0-alpha.1/remote-runtime-linux-x64.tar.gz".into(),
                sha256: LINUX.into(),
                size: 48_000_000,
            }
        );
        assert_eq!(
            parsed.download("darwin-arm64").unwrap().url,
            "https://github.com/yannelli/oxbit/releases/download/v0.4.0-alpha.1/remote-runtime-darwin-arm64.tar.gz"
        );
        assert!(parsed.download("darwin-x64").is_err());
    }

    #[test]
    fn rejects_a_manifest_for_another_version() {
        let error = parse(&manifest("0.3.3", &both()), "0.3.4").unwrap_err();
        assert!(error.contains("0.3.3"), "{error}");
    }

    #[test]
    fn rejects_missing_or_unknown_platforms() {
        let darwin_only = format!(r#""darwin-arm64":{{"sha256":"{DARWIN}","size":1}}"#);
        assert!(parse(&manifest("0.3.4", &darwin_only), "0.3.4").is_err());
        let with_intel = format!(
            r#"{},"darwin-x64":{{"sha256":"{DARWIN}","size":1}}"#,
            both()
        );
        assert!(parse(&manifest("0.3.4", &with_intel), "0.3.4").is_err());
    }

    #[test]
    fn rejects_malformed_digests_sizes_and_fields() {
        for (digest, size) in [
            (&DARWIN.to_uppercase()[..], "1"),
            (&DARWIN[..63], "1"),
            (&format!("{}g", &DARWIN[..63])[..], "1"),
            (DARWIN, "0"),
        ] {
            let platforms = format!(
                r#""darwin-arm64":{{"sha256":"{digest}","size":{size}}},"linux-x64":{{"sha256":"{LINUX}","size":1}}"#
            );
            assert!(
                parse(&manifest("0.3.4", &platforms), "0.3.4").is_err(),
                "{digest} {size}"
            );
        }
        let extra = format!(
            r#"{{"version":"0.3.4","schema":1,"platforms":{{{}}}}}"#,
            both()
        );
        assert!(parse(&extra, "0.3.4").is_err());
    }

    #[test]
    fn pinned_manifest_matches_the_build() {
        assert_eq!(
            pinned_manifest().unwrap().is_some(),
            PINNED_MANIFEST.is_some()
        );
    }
}
