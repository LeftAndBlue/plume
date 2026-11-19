// 调试构建保留控制台，便于观察启动日志；发布构建为纯窗口子系统。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    plume_lib::run()
}
