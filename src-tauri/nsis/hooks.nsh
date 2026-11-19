; 安装后：.md / .markdown 的关联文件图标使用专用 MD 图标，而不是 Plume 应用 Logo。
; 关联本身由 tauri.conf.json 的 bundle.fileAssociations 创建（ProgID 为 "Plume Markdown"），
; 这里只覆盖它的 DefaultIcon；卸载时 APP_UNASSOCIATE 会一并清掉，无需额外清理。
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCR "Plume Markdown\DefaultIcon" "" "$INSTDIR\icons\md.ico,0"
  ; SHCNE_ASSOCCHANGED：通知资源管理器重建关联与图标缓存
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
