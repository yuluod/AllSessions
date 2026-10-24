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
