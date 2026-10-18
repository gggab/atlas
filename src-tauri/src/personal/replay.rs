use std::collections::{HashMap, HashSet};

pub const APP_DATA_OPEN: &str = "--- PERSONAL ASSISTANT DATA ---";
pub const APP_DATA_CLOSE: &str = "--- END PERSONAL ASSISTANT DATA ---";

/// Only restore a real admitted human source whose prefix matches the echoed
/// prompt. A user quoting the same labels remains a human message verbatim.
pub fn human_prose<'a>(
    text: &str,
    sources: &'a HashMap<String, String>,
    originals: &HashSet<&str>,
) -> Option<&'a str> {
    if originals.contains(text) {
        return None;
    }
    let body = text.strip_suffix(APP_DATA_CLOSE)?;
    let (prefix, application) = body.rsplit_once(APP_DATA_OPEN)?;
    let json_line = application.trim().lines().last()?;
    let data: serde_json::Value = serde_json::from_str(json_line).ok()?;
    let source = sources.get(data.get("currentHumanMessageId")?.as_str()?)?;
    (prefix.trim_end() == source.trim_end()).then_some(source.as_str())
}
