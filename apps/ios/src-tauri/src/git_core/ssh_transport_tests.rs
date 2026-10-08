use super::ssh_transport::{command, is_ssh_url, parse_ssh_url, SshUrl};

fn url(user: Option<&str>, host: &str, port: u16, path: &str) -> SshUrl {
    SshUrl {
        user: user.map(str::to_string),
        host: host.into(),
        port,
        path: path.into(),
    }
}

#[test]
fn parses_ssh_and_scp_style_remotes() {
    for (input, expected) in [
        (
            "git@github.com:owner/repo.git",
            url(Some("git"), "github.com", 22, "owner/repo.git"),
        ),
        (
            "github.com:owner/repo.git",
            url(None, "github.com", 22, "owner/repo.git"),
        ),
        (
            "git@host.example:/srv/repo.git",
            url(Some("git"), "host.example", 22, "/srv/repo.git"),
        ),
        (
            "ssh://git@github.com/owner/repo.git",
            url(Some("git"), "github.com", 22, "/owner/repo.git"),
        ),
        (
            "ssh://dev@build.example:2222/srv/repo.git",
            url(Some("dev"), "build.example", 2222, "/srv/repo.git"),
        ),
        (
            "ssh://build.example/~/repo.git",
            url(None, "build.example", 22, "~/repo.git"),
        ),
        (
            "ssh://git@[::1]:2222/repo.git",
            url(Some("git"), "::1", 2222, "/repo.git"),
        ),
        (
            "git@[::1]:repo.git",
            url(Some("git"), "::1", 22, "repo.git"),
        ),
    ] {
        assert!(is_ssh_url(input), "{input}");
        assert_eq!(parse_ssh_url(input).unwrap(), expected, "{input}");
    }
}

#[test]
fn refuses_passwords_options_and_malformed_remotes() {
    for input in [
        "ssh://git:secret@github.com/owner/repo.git",
        "ssh://-oProxyCommand=x/repo.git",
        "-oProxyCommand=x:repo.git",
        "ssh://github.com",
        "ssh://github.com/",
        "ssh://github.com:0/repo.git",
        "ssh://github.com:99999/repo.git",
        "ssh://git%40x@github.com/repo.git",
        "git@:repo.git",
        "git@github.com:",
        "a@b@github.com:repo.git",
        "git@github.com:repo .git",
        "git@[not-ipv6]:repo.git",
    ] {
        assert!(parse_ssh_url(input).is_err(), "{input}");
    }
    for input in [
        "https://github.com/owner/repo.git",
        "file:///tmp/repo.git",
        "/tmp/repo.git",
        "owner/repo:file",
    ] {
        assert!(!is_ssh_url(input), "{input}");
    }
}

#[test]
fn quotes_the_repository_path_for_the_remote_shell() {
    assert_eq!(
        command("git-upload-pack", "owner/repo.git"),
        "git-upload-pack 'owner/repo.git'"
    );
    assert_eq!(
        command("git-receive-pack", "it's/$(x).git"),
        "git-receive-pack 'it'\\''s/$(x).git'"
    );
}
