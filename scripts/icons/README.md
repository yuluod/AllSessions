# 图标源文件

`app-icon-amber.svg` 是「琥珀」运行时图标的源文件（与应用 v3 经典图标同一设计语言）。
修改后重新生成各尺寸：

```sh
rsvg-convert -w 1024 -h 1024 scripts/icons/app-icon-amber.svg -o src-tauri/icons/runtime/amber.png
sips -z 256 256 src-tauri/icons/runtime/amber.png --out public/assets/allsessions-icon-amber.png
```

`src-tauri/icons/runtime/` 下的 PNG 会在编译期由 `src-tauri/src/app_icon.rs` 内嵌，
用于设置里的运行时图标切换；`default.png` 是经典图标（由
`public/assets/allsessions-icon-v3.png` 缩放而来）。应用包本身的安装图标
（`src-tauri/icons/icon.icns` 等）不受运行时切换影响。

Windows 切换偏好时同时更新系统托盘；经典变体恢复原有透明托盘图标，
琥珀变体复用 `public/assets/allsessions-icon-amber.png` 的 256px 预览资产，
不将 1024px 程序坞图标直接用于托盘。重启后沿用已保存的图标偏好。
macOS 菜单栏图标继续使用原有模板图标，不随程序坞图标变体变化。

Windows 图标偏好保存成功且确实发生切换后，提供可选重启提示，供托盘图标尚未刷新时使用。
选择「稍后」不会重启；选择「立即重启」才发送确认后的重启请求。
如有未保存的来源目录修改，弹窗会提示重启将丢弃这些修改。
