//! Windows 11 客户端使用 x86-64-v3。安装器在启动优化过的程序之前筛查 AVX2。
//! Linux x86_64 保留 x86-64-v2。

#[cfg(all(windows, not(target_arch = "x86_64")))]
compile_error!("Windows 仅支持 x64 构建。");

#[cfg(all(windows, target_arch = "x86_64", not(target_feature = "avx2")))]
compile_error!("Windows x64 构建需要 x86-64-v3，请使用 src-tauri/.cargo/config.toml 的编译配置。");

#[cfg(all(target_os = "linux", target_arch = "x86_64", target_feature = "avx2"))]
compile_error!("Linux x64 构建请保持 -C target-cpu=x86-64-v2。");

pub fn assert_supported_platform() {
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    assert_x86_64_v2();

    #[cfg(windows)]
    assert_windows_version();
}

#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
fn assert_x86_64_v2() {
    if !is_x86_feature_detected!("sse4.2") {
        abort_unsupported(
            "青幕AI写作需要支持 SSE4.2 指令集的 64 位 CPU（Intel Nehalem 2008 年 / AMD Bulldozer 2011 年 或更新）。",
        );
    }
}

#[cfg(any(windows, test))]
fn is_windows_11_client(build: u32, product_type: u8) -> bool {
    const VER_NT_WORKSTATION: u8 = 1;
    build >= 22000 && product_type == VER_NT_WORKSTATION
}

#[cfg(windows)]
fn assert_windows_version() {
    #[repr(C)]
    struct OsVersionInfoExW {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
        service_pack_major: u16,
        service_pack_minor: u16,
        suite_mask: u16,
        product_type: u8,
        reserved: u8,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoExW) -> i32;
    }

    // SAFETY: 所有字段均为整数或整数数组，零是有效初值。
    let mut info: OsVersionInfoExW = unsafe { std::mem::zeroed() };
    info.dw_os_version_info_size = std::mem::size_of::<OsVersionInfoExW>() as u32;
    // SAFETY: 结构布局和大小对应 RTL_OSVERSIONINFOEXW，缓冲区在调用期间有效。
    let status = unsafe { RtlGetVersion(&mut info) };
    if status < 0 || !is_windows_11_client(info.dw_build_number, info.product_type) {
        abort_unsupported("青幕AI写作需要 Windows 11 桌面版（内部版本 22000 或更高）。");
    }
}

#[cfg(any(windows, all(target_arch = "x86_64", target_os = "linux")))]
fn abort_unsupported(message: &str) -> ! {
    eprintln!("{message}");
    #[cfg(windows)]
    show_windows_error(message);
    std::process::exit(1);
}

#[cfg(windows)]
fn show_windows_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;

    let text: Vec<u16> = std::ffi::OsStr::new(message)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let title: Vec<u16> = std::ffi::OsStr::new("青幕AI写作")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            ty: u32,
        ) -> i32;
    }

    const MB_ICONERROR: u32 = 0x0000_0010;
    // SAFETY: `text` and `title` are NUL-terminated UTF-16 buffers that live for the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_ICONERROR,
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_11_requires_a_client_build_at_or_above_22000() {
        assert!(!super::is_windows_11_client(19045, 1));
        assert!(!super::is_windows_11_client(21999, 1));
        assert!(super::is_windows_11_client(22000, 1));
        assert!(super::is_windows_11_client(26100, 1));
        assert!(!super::is_windows_11_client(26100, 2));
        assert!(!super::is_windows_11_client(26100, 3));
    }

    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    #[test]
    fn host_ci_machines_have_x86_64_v2() {
        // 编译目标已降到 x86-64-v2；若连 CI 机器都不满足，说明基线又被人为抬高了。
        assert!(
            is_x86_feature_detected!("sse4.2") && is_x86_feature_detected!("popcnt"),
            "x86_64 Linux builds assume x86-64-v2 (SSE4.2); this host cannot run the release binary"
        );
    }
}
