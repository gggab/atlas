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
    for path in ["../Cargo.lock", "Cargo.toml", "build.rs", "tauri.conf.json"] {
        std::fs::read(path)
            .expect("read backend build input")
            .hash(&mut hash);
    }
    println!(
        "cargo:rustc-env=ATLAS_BACKGROUND_BUILD={:016x}",
        hash.finish()
    );
    tauri_build::build()
}
