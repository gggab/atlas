use super::{recall::*, store::*};
fn memory(id: &str, key: &str, text: &str, core: bool, revision: u64, time: i64) -> Memory {
    serde_json::from_value(serde_json::json!({"id":id,"key":key,"content":text,"kind":"fact","confirmed":true,"core":core,"revision":revision,"sourceMessageId":"h","sourceThreadId":"chat","updatedAt":time})).unwrap()
}
#[test]
fn relevant_corrections_beat_unrelated_recent_facts_and_selection_is_stable() {
    let mut rows = (0..40)
        .map(|i| {
            memory(
                &format!("noise-{i}"),
                "hobby",
                "喜欢徒步",
                false,
                1,
                100 + i,
            )
        })
        .collect::<Vec<_>>();
    rows.push(memory("rent", "房租缴费日", "每月15日交房租", false, 3, 10));
    rows.push(memory("language", "回答语言", "使用中文", true, 1, 1));
    let result = select(&rows, "这个月房租什么时候交");
    assert!(result.items.iter().any(|i| i["id"] == "rent"));
    assert!(result.items.iter().any(|i| i["id"] == "language"));
    assert!(!result
        .items
        .iter()
        .any(|i| i["id"].as_str().unwrap().starts_with("noise")));
    rows.reverse();
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::to_value(select(&rows, "这个月房租什么时候交")).unwrap()
    );
}
#[test]
fn aggregate_budget_includes_escaped_metadata_and_omitted_entries_are_explicit() {
    let rows = (0..30)
        .map(|i| {
            memory(
                &format!("m-{i}"),
                &format!("rent-{i}"),
                &format!("Rent {}", "\\\"北京".repeat(500)),
                i < 5,
                2,
                i as i64,
            )
        })
        .collect::<Vec<_>>();
    let r = select(&rows, "Rent");
    let text = serde_json::to_string(&r).unwrap();
    assert!(
        text.chars().count() <= MEMORY_CHAR_BUDGET,
        "{}",
        text.chars().count()
    );
    assert!(r.selected <= 18);
    assert_eq!(r.selected, r.items.len() + r.omitted.len());
    assert!(r.items.iter().any(|i| i["truncated"] == true) || !r.omitted.is_empty());
    assert_eq!(r.total, rows.len());
}
#[test]
fn unverified_entries_are_not_authoritative_and_long_content_is_expandable() {
    let mut uncertain = memory("unverified", "rent", "Rent ten", true, 1, 5);
    uncertain.confirmed = false;
    let rows = vec![uncertain, memory("known", "rent", "Rent ten", false, 1, 1)];
    let r = select(&rows, "rent");
    assert!(r.items.iter().all(|i| i["id"] != "unverified"));
    assert!(r.items.iter().any(|i| i["id"] == "known"));
}

#[test]
fn explicit_ids_expand_the_record_even_when_the_query_does_not_match() {
    let rows = vec![memory("known", "rent", "Rent fifteen", false, 1, 1)];
    assert!(matching(&rows, "birthday", None).is_empty());
    assert_eq!(
        matching(&rows, "birthday", Some(&["known".into()]))[0].id,
        "known"
    );
}
