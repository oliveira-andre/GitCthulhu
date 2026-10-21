// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git and ssh run this same executable to ask for credentials.
    if let Some(code) = gitcthulhu_core::askpass::run_if_helper() {
        std::process::exit(code);
    }
    gitcthulhu_lib::run()
}
