mod common;

use common::Fixture;
use gitcthulhu_core::profile;

#[test]
fn signing_out_forgets_the_identity_and_saved_passwords() {
    // The fixture's git has its own global config, never the developer's.
    let f = Fixture::new();
    let saved = profile::load(&f.git).unwrap();
    assert_eq!(saved.name.as_deref(), Some("Test User"));
    assert_eq!(saved.email.as_deref(), Some("test@example.com"));

    let store = f.dir.path().join("credentials");
    std::fs::write(
        &store,
        "https://me:secret@example.com\nhttps://me:other@elsewhere.org\n",
    )
    .unwrap();
    f.git(&[
        "config",
        "--global",
        "credential.helper",
        &format!("store --file={}", store.display()),
    ]);
    f.git(&[
        "remote",
        "add",
        "origin",
        "https://me@Example.com/team/app.git",
    ]);
    f.git(&["remote", "add", "mirror", "git@example.com:team/app.git"]);
    f.git(&[
        "config",
        "remote.origin.pushurl",
        "https://example.com/team/app.git",
    ]);
    assert_eq!(
        profile::remote_hosts(&f.repo).unwrap(),
        ["https://example.com"]
    );

    profile::sign_out(&f.git, true, &["https://example.com".into()]).unwrap();
    assert_eq!(profile::load(&f.git).unwrap(), profile::Profile::default());
    assert_eq!(
        std::fs::read_to_string(&store).unwrap(),
        "https://me:other@elsewhere.org\n"
    );
    // Signing out again finds nothing to forget, which is fine.
    profile::sign_out(&f.git, true, &[]).unwrap();
    assert!(profile::sign_out(&f.git, false, &["git@example.com".into()]).is_err());

    let back = profile::save(&f.git, " Ada ", "ada@example.com").unwrap();
    assert_eq!(back.name.as_deref(), Some("Ada"));
    assert!(profile::save(&f.git, "", "ada@example.com").is_err());
}
