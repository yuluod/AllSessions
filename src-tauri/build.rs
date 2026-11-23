fn main() {
    tauri_build::build();
    // tauri-build 只把 Windows 应用清单嵌进 [[bin]] 目标（经 winres 资源），
    // 链接 tauri 的库测试二进制会缺 Common Controls v6 声明，启动即
    // STATUS_ENTRYPOINT_NOT_FOUND（上游 tauri#13419）。改由链接器为所有
    // 目标嵌入同一份清单。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // bin 及其测试目标已由 winres 资源携带清单，再经链接器生成会报
        // RT_MANIFEST 重复（CVT1100）；用 /MANIFEST:NO 让 bins 保持原状。
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}
