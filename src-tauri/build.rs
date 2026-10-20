fn main() {
    use std::hash::{Hash, Hasher};
    fn hash_sources(dir: &std::path::Path, hash: &mut std::collections::hash_map::DefaultHasher) {
        let mut paths: Vec<_> = std::fs::read_dir(dir)
            .expect("read backend sources")
            .map(|entry| entry.unwrap().path())
            .collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name != "target") {
                    hash_sources(&path, hash);
                }
            } else if path.extension().is_some_and(|ext| ext == "rs")
                || path.file_name().is_some_and(|name| name == "Cargo.toml")
            {
                path.hash(hash);
                std::fs::read(path).expect("read backend source").hash(hash);
            }
        }
    }
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../crates");
    println!("cargo:rerun-if-changed=../Cargo.lock");
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    hash_sources(std::path::Path::new("src"), &mut hash);
    hash_sources(std::path::Path::new("../crates"), &mut hash);
    for path in [
        "../Cargo.lock",
        "Cargo.toml",
        "build.rs",
        "tauri.conf.json",
        "windows-app-manifest.xml",
    ] {
        std::fs::read(path)
            .expect("read backend build input")
            .hash(&mut hash);
    }
    println!(
        "cargo:rustc-env=ATLAS_BACKGROUND_BUILD={:016x}",
        hash.finish()
    );
    let mut windows = tauri_build::WindowsAttributes::new();
    if embed_windows_manifest_with_linker() {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    }
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

// Library test executables need Common Controls v6 as well as the app binary.
fn embed_windows_manifest_with_linker() -> bool {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return false;
    }
    let manifest = std::env::current_dir()
        .expect("build scripts run in the package directory")
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}
