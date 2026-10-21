//! The macOS menu bar. Each item of ours sends a `menu` event with its id,
//! and the UI runs the same action as the matching shortcut or button.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// `(id, label, accelerator)`; the ids are the UI's command names.
const FILE: &[(&str, &str, Option<&str>)] = &[
    ("newTab", "New Tab", Some("CmdOrCtrl+T")),
    ("openRepo", "Open Repository…", Some("CmdOrCtrl+O")),
    ("cloneRepo", "Clone Repository…", None),
    ("initRepo", "New Repository…", None),
    ("-", "", None),
    ("reopenTab", "Reopen Closed Tab", Some("CmdOrCtrl+Shift+T")),
    ("-", "", None),
    ("closeTab", "Close Tab", Some("CmdOrCtrl+W")),
];

const VIEW: &[(&str, &str, Option<&str>)] = &[
    ("palette", "Command Palette…", Some("CmdOrCtrl+P")),
    ("search", "Find Commits…", Some("CmdOrCtrl+F")),
    ("-", "", None),
    ("toggleLeft", "Toggle Left Panel", Some("CmdOrCtrl+J")),
    ("toggleRight", "Toggle Commit Panel", Some("CmdOrCtrl+K")),
    ("-", "", None),
    ("refresh", "Refresh", Some("CmdOrCtrl+R")),
];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let items = |mut submenu: SubmenuBuilder<'_, R, AppHandle<R>>,
                 entries: &[(&str, &str, Option<&str>)]| {
        for &(id, label, accelerator) in entries {
            if id == "-" {
                submenu = submenu.separator();
                continue;
            }
            let mut item = MenuItemBuilder::with_id(id, label);
            if let Some(accelerator) = accelerator {
                item = item.accelerator(accelerator);
            }
            submenu = submenu.item(&item.build(app)?);
        }
        submenu.build()
    };

    let preferences = MenuItemBuilder::with_id("settings", "Preferences…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "GitCthulhu")
        .about(Some(AboutMetadata {
            name: Some("GitCthulhu".into()),
            ..Default::default()
        }))
        .separator()
        .item(&preferences)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = items(SubmenuBuilder::new(app, "File"), FILE)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = items(SubmenuBuilder::new(app, "View"), VIEW)?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()
}

/// Forwards our own items to the UI; predefined ones (copy, quit…) are
/// handled by the system.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    let ours = id == "settings" || FILE.iter().chain(VIEW).any(|(item, _, _)| *item == id);
    if ours {
        let _ = app.emit("menu", id);
    }
}
