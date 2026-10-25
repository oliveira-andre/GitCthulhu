//! The app's own data: recent repositories, open tabs and preferences, in
//! one versioned JSON file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

const VERSION: u32 = 3;
const MAX_RECENT: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// How many commits the graph loads.
    pub commit_limit: usize,
    /// Fetch every remote of an open repository this often; 0 turns it off.
    pub auto_fetch_minutes: u32,
    /// Lines of context around each change in diffs.
    pub diff_context: u32,
    pub date_format: DateFormat,
    /// Hide the author column's avatars.
    pub show_avatars: bool,
    /// Width of the left and right panels, in pixels.
    pub left_panel_width: u32,
    pub right_panel_width: u32,
    pub diff_layout: DiffLayout,
    /// Diffs hide whitespace-only changes (staging hunks is then off).
    pub ignore_whitespace: bool,
    /// The command that opens files and folders, for example `code` or
    /// `zed`; empty uses the system's default app.
    pub editor: String,
    /// The UI's color theme.
    pub theme: Theme,
    /// Zoom factor for the whole window.
    pub zoom: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    /// The violet-dark palette with neon accents; the default.
    Dracula,
    /// Near-black and achromatic, with green accents.
    Dark,
    Light,
    /// Follows the system's appearance: Dracula or light.
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffLayout {
    /// One row per line: a changed line shows once, with its removed and
    /// added words inline. The default.
    Compact,
    /// Removed and added lines on rows of their own ("Detailed").
    Unified,
    /// Old and new side by side.
    Split,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DateFormat {
    Relative,
    Absolute,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            commit_limit: 2000,
            auto_fetch_minutes: 0,
            diff_context: 3,
            date_format: DateFormat::Relative,
            show_avatars: true,
            left_panel_width: 260,
            right_panel_width: 380,
            diff_layout: DiffLayout::Compact,
            ignore_whitespace: false,
            editor: String::new(),
            theme: Theme::Dracula,
            zoom: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: PathBuf,
    pub name: String,
    /// Seconds since the epoch.
    pub opened_at: u64,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppData {
    pub version: u32,
    pub recent: Vec<RecentRepo>,
    /// Repositories open in tabs, in tab order.
    pub tabs: Vec<PathBuf>,
    pub active_tab: Option<PathBuf>,
    pub settings: Settings,
}

impl Default for AppData {
    fn default() -> AppData {
        AppData {
            version: VERSION,
            recent: Vec::new(),
            tabs: Vec::new(),
            active_tab: None,
            settings: Settings::default(),
        }
    }
}

impl AppData {
    /// Reads the file, or starts empty when it doesn't exist yet.
    pub fn load(path: &Path) -> Result<AppData> {
        let mut data: AppData = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppData::default()),
            Err(e) => return Err(e.into()),
        };
        // Version 1's dark theme is the one now called Dracula.
        if data.version < 2 && data.settings.theme == Theme::Dark {
            data.settings.theme = Theme::Dracula;
        }
        // Before version 3, unified was the default and compact didn't exist.
        if data.version < 3 && data.settings.diff_layout == DiffLayout::Unified {
            data.settings.diff_layout = DiffLayout::Compact;
        }
        data.version = VERSION;
        Ok(data)
    }

    /// Writes to a temporary file and renames it into place, so a crash
    /// never leaves half a file.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn touch_recent(&mut self, path: &Path, name: &str, now: u64) {
        let favorite = self.recent.iter().any(|r| r.path == path && r.favorite);
        self.recent.retain(|r| r.path != path);
        self.recent.insert(
            0,
            RecentRepo {
                path: path.to_owned(),
                name: name.to_owned(),
                opened_at: now,
                favorite,
            },
        );
        // Favorites are never pushed out.
        while self.recent.len() > MAX_RECENT {
            match self.recent.iter().rposition(|r| !r.favorite) {
                Some(i) => {
                    self.recent.remove(i);
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_fills_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        assert_eq!(AppData::load(&path).unwrap(), AppData::default());

        let mut data = AppData::default();
        data.touch_recent(Path::new("/r/a"), "a", 1);
        data.touch_recent(Path::new("/r/b"), "b", 2);
        data.touch_recent(Path::new("/r/a"), "a", 3);
        assert_eq!(
            data.recent
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        data.save(&path).unwrap();
        assert_eq!(AppData::load(&path).unwrap(), data);

        std::fs::write(&path, r#"{"version":1,"settings":{"commitLimit":50}}"#).unwrap();
        let loaded = AppData::load(&path).unwrap();
        assert_eq!(loaded.settings.commit_limit, 50);
        assert_eq!(loaded.settings.diff_context, 3);

        assert_eq!(loaded.settings.theme, Theme::Dracula);

        // Version 1's "dark" was the look now called Dracula.
        std::fs::write(&path, r#"{"version":1,"settings":{"theme":"dark"}}"#).unwrap();
        assert_eq!(AppData::load(&path).unwrap().settings.theme, Theme::Dracula);
        std::fs::write(&path, r#"{"version":2,"settings":{"theme":"dark"}}"#).unwrap();
        assert_eq!(AppData::load(&path).unwrap().settings.theme, Theme::Dark);

        // Unified was the default before compact; split was a choice.
        std::fs::write(
            &path,
            r#"{"version":2,"settings":{"diffLayout":"unified"}}"#,
        )
        .unwrap();
        let layout = |path: &Path| AppData::load(path).unwrap().settings.diff_layout;
        assert_eq!(layout(&path), DiffLayout::Compact);
        std::fs::write(&path, r#"{"version":2,"settings":{"diffLayout":"split"}}"#).unwrap();
        assert_eq!(layout(&path), DiffLayout::Split);
        std::fs::write(
            &path,
            r#"{"version":3,"settings":{"diffLayout":"unified"}}"#,
        )
        .unwrap();
        assert_eq!(layout(&path), DiffLayout::Unified);
    }
}
