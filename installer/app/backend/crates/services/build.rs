//! Compiles the staged Clippity application into the installer binary.
//!
//! The installer ships as a single `Clippity Setup.exe` with no sibling
//! files, so the payload cannot be a Tauri bundle resource — it has to be
//! part of the executable itself. This script looks for the staged files
//! in `installer/payload/` and generates a small module that either
//! `include_bytes!`-es them or declares them absent.
//!
//! An absent payload is a normal state, not an error: it is what a clean
//! checkout looks like before the app has ever been built, and `cargo
//! check` has to work there. The failure surfaces at install time with a
//! message naming the staging step.

use std::path::{Path, PathBuf};

fn main() {
    // crates/services → crates → backend → app → installer
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let payload_dir = manifest_dir
        .join("../../../../payload")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join("../../../../payload"));

    let exe = payload_dir.join("Clippity.exe");
    let manifest = payload_dir.join("payload.json");

    // Rebuild whenever the staging script re-runs, so a freshly staged
    // payload is never missed in an incremental build.
    println!("cargo:rerun-if-changed={}", exe.display());
    println!("cargo:rerun-if-changed={}", manifest.display());

    let staged = exe.is_file() && manifest.is_file();
    let generated = if staged {
        println!(
            "cargo:warning=embedding Clippity payload ({} MB)",
            exe.metadata().map(|m| m.len()).unwrap_or(0) / 1_000_000
        );
        format!(
            "pub const PAYLOAD: Option<&[u8]> = Some(include_bytes!(r\"{}\"));\n\
             pub const MANIFEST_JSON: Option<&str> = Some(include_str!(r\"{}\"));\n",
            exe.display(),
            manifest.display(),
        )
    } else {
        println!(
            "cargo:warning=no Clippity payload staged in {} — \
             this installer will not be able to install anything \
             (run `pnpm stage:payload`)",
            payload_dir.display()
        );
        "pub const PAYLOAD: Option<&[u8]> = None;\n\
         pub const MANIFEST_JSON: Option<&str> = None;\n"
            .to_string()
    };

    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("payload_embed.rs");
    std::fs::write(&out, generated).expect("write payload_embed.rs");
}
