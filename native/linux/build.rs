// Versi aplikasi dibaca dari package.json di akar repo (satu sumber, sama dengan macOS/Windows).
fn main() {
    println!("cargo:rerun-if-changed=../../package.json");
    let text = std::fs::read_to_string("../../package.json").unwrap_or_default();
    let version = text
        .split("\"version\"")
        .nth(1)
        .and_then(|r| r.split('"').nth(1))
        .unwrap_or("dev")
        .to_string();
    println!("cargo:rustc-env=JEJAK_VERSION={version}");
}
