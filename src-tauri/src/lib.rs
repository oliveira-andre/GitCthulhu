mod commands;
#[cfg(target_os = "macos")]
mod menu;
mod state;
#[cfg(test)]
mod tests;

use tauri::Manager;

use crate::state::AppState;

/// Every command the UI can call; shared by the app and the IPC tests.
macro_rules! handlers {
    () => {
        tauri::generate_handler![
            $crate::commands::app_info,
            $crate::commands::load_app_data,
            $crate::commands::save_settings,
            $crate::commands::save_tabs,
            $crate::commands::set_favorite,
            $crate::commands::forget_recent,
            $crate::commands::answer_prompt,
            $crate::commands::open_repo,
            $crate::commands::init_repo,
            $crate::commands::clone_repo,
            $crate::commands::close_repo,
            $crate::commands::snapshot,
            $crate::commands::working_status,
            $crate::commands::load_graph,
            $crate::commands::commit_details,
            $crate::commands::compare_files,
            $crate::commands::file_diff,
            $crate::commands::head_message,
            $crate::commands::worktree_file,
            $crate::commands::stage,
            $crate::commands::unstage,
            $crate::commands::stage_all,
            $crate::commands::unstage_all,
            $crate::commands::discard,
            $crate::commands::apply_lines,
            $crate::commands::commit,
            $crate::commands::checkout_branch,
            $crate::commands::checkout_remote_branch,
            $crate::commands::checkout_commit,
            $crate::commands::create_branch,
            $crate::commands::delete_branch,
            $crate::commands::rename_branch,
            $crate::commands::fast_forward_branch,
            $crate::commands::merge,
            $crate::commands::rebase,
            $crate::commands::cherry_pick,
            $crate::commands::revert,
            $crate::commands::reset,
            $crate::commands::sequence,
            $crate::commands::resolve_with,
            $crate::commands::create_tag,
            $crate::commands::delete_tag,
            $crate::commands::stash_push,
            $crate::commands::stash_apply,
            $crate::commands::stash_drop,
            $crate::commands::fetch,
            $crate::commands::pull,
            $crate::commands::push,
            $crate::commands::push_tag,
            $crate::commands::delete_remote_ref,
            $crate::commands::default_remote,
            $crate::commands::add_remote,
            $crate::commands::remove_remote,
            $crate::commands::reveal,
            $crate::commands::open_terminal,
            $crate::commands::looks_like_repo,
        ]
    };
}
#[cfg(test)]
pub(crate) use handlers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Elsewhere the window has no menu bar; the same commands are shortcuts.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::load(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(handlers!())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
