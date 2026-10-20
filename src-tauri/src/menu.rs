//! Native macOS application menu.
//!
//! The Window ▸ Close Tab item emits `atlas:close-active-tab` to the main
//! webview rather than closing the application window. Its accelerator follows
//! the user's `tabs.close` binding via `keybindings_set_close_tab_accelerator`.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;

/// Menu item id for the Cmd+W "close tab" action. Matched in the
/// `on_menu_event` handler in `lib.rs`.
pub const CLOSE_TAB_ID: &str = "atlas-close-tab";

/// The Close Tab item, managed so its accelerator can be re-pointed without
/// rebuilding the whole menu. Only exists where the menu does (macOS).
pub struct CloseTabItem(pub MenuItem<tauri::Wry>);

pub fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // App menu (first submenu → becomes the macOS application menu).
    let app_menu = Submenu::with_items(
        app,
        atlas_profile::current().product_name(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Standard Edit menu — provides Cmd+C/V/X/A key equivalents that native
    // webviews rely on.
    //
    // Undo/Redo are DELIBERATELY OMITTED. The predefined items bind Cmd+Z /
    // Cmd+Shift+Z to AppKit's `undo:` / `redo:` editing selectors, which macOS
    // routes straight to WKWebView's native editing-undo via the responder
    // chain — WITHOUT dispatching a JS keydown to the page. That shadowed
    // CodeMirror's own history (`historyKeymap`), so Cmd+Z did nothing in the
    // code editor. Without these items Cmd+Z reaches the page as a normal
    // keydown: CodeMirror handles its own undo history.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu — keep the standard fullscreen toggle (⌃⌘F) that the default
    // menu provided.
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // Window menu — Cmd+W is our custom "close tab" item, NOT the predefined
    // close-window (which would tear down the app from a focused child webview).
    // Starts on the default chord; the renderer re-points it once it has read
    // keybindings.json.
    let close_tab = MenuItem::with_id(app, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    app.manage(CloseTabItem(close_tab.clone()));
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}
