use super::store::Memory;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MEMORY_CHAR_BUDGET: usize = 4000;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recall {
    pub items: Vec<Value>,
    pub omitted: Vec<Value>,
    pub total: usize,
    pub selected: usize,
}

fn terms(text: &str) -> HashSet<String> {
    let text = text.to_lowercase();
    let mut out = HashSet::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        if word.is_ascii()
            && word.len() >= 2
            && !matches!(
                word,
                "the"
                    | "this"
                    | "that"
                    | "what"
                    | "when"
                    | "with"
                    | "from"
                    | "my"
                    | "is"
                    | "of"
                    | "to"
            )
        {
            out.insert(word.into());
        }
        let chars = word.chars().collect::<Vec<_>>();
        for pair in chars.windows(2) {
            if pair.iter().all(|c| ('\u{4e00}'..='\u{9fff}').contains(c)) {
                let term = pair.iter().collect::<String>();
                if !matches!(
                    term.as_str(),
                    "我的" | "这个" | "那个" | "什么" | "时候" | "一下" | "可以"
                ) {
                    out.insert(term);
                }
            }
        }
    }
    out
}
fn score(memory: &Memory, query: &str, query_terms: &HashSet<String>) -> usize {
    let key = memory.key.to_lowercase();
    let exact = key.chars().count() >= 2 && query.to_lowercase().contains(&key);
    let key_terms = terms(&key);
    let content_terms = terms(&memory.content);
    usize::from(exact) * 100
        + key_terms.intersection(query_terms).count() * 5
        + content_terms.intersection(query_terms).count()
}
pub fn matching<'a>(rows: &'a [Memory], query: &str, ids: Option<&[String]>) -> Vec<&'a Memory> {
    let q = terms(query);
    let mut ranked = rows
        .iter()
        .map(|m| (m, score(m, query, &q)))
        .filter(|(m, s)| ids.map_or(query.trim().is_empty() || *s > 0, |ids| ids.contains(&m.id)))
        .collect::<Vec<_>>();
    ranked.sort_by(|(a, sa), (b, sb)| {
        sb.cmp(sa)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.id.cmp(&b.id))
    });
    ranked.into_iter().map(|(m, _)| m).collect()
}
fn index(m: &Memory) -> Value {
    json!({"id":m.id,"keyPreview":m.key.chars().filter(|c|!c.is_control()).take(24).collect::<String>()})
}
fn fits(pack: &Recall) -> bool {
    serde_json::to_string(pack)
        .expect("memory recall JSON")
        .chars()
        .count()
        <= MEMORY_CHAR_BUDGET
}
pub fn select(rows: &[Memory], query: &str) -> Recall {
    let active = rows
        .iter()
        .filter(|m| m.confirmed)
        .cloned()
        .collect::<Vec<_>>();
    let ranked = matching(&active, query, None);
    let mut core = active.iter().filter(|m| m.core).collect::<Vec<_>>();
    core.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    let mut corrections = ranked
        .iter()
        .copied()
        .filter(|m| m.revision > 1)
        .collect::<Vec<_>>();
    corrections.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    let mut chosen = Vec::new();
    let mut ids = HashSet::new();
    for (group, limit) in [(core, 5), (corrections, 3), (ranked, 10)] {
        let mut added = 0;
        for m in group {
            if ids.insert(m.id.clone()) {
                chosen.push(m);
                added += 1;
            }
            if added == limit {
                break;
            }
        }
    }
    let mut pack = Recall {
        items: vec![],
        omitted: chosen.iter().map(|m| index(m)).collect(),
        total: active.len(),
        selected: chosen.len(),
    };
    for m in chosen {
        let reference = pack.omitted.remove(0);
        let full = json!({"id":m.id,"revision":m.revision,"key":m.key,"kind":m.kind,"content":m.content,"core":m.core,"truncated":false});
        pack.items.push(full);
        if fits(&pack) {
            continue;
        }
        pack.items.pop();
        let mut size = m.content.chars().count().min(240);
        let mut added = false;
        while size > 0 {
            pack.items.push(json!({"id":m.id,"revision":m.revision,"key":m.key,"kind":m.kind,"contentPreview":m.content.chars().take(size).collect::<String>(),"core":m.core,"truncated":true}));
            if fits(&pack) {
                added = true;
                break;
            }
            pack.items.pop();
            size = size.saturating_sub(40);
        }
        if !added {
            pack.omitted.push(reference);
        }
    }
    // Every unexpanded ID remains discoverable, including records that did not fit at all.
    debug_assert!(fits(&pack));
    pack
}
