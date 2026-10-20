use atlas_terminal::command::OutputBuffer;

#[test]
fn unicode_windows_are_identical_across_chunking_and_compaction() {
    let text = "a中🙂\n".repeat(100);
    let mut once = OutputBuffer::new(17);
    once.push(text.as_bytes());
    let mut chunks = OutputBuffer::new(17);
    for bytes in text.as_bytes().chunks(2) {
        chunks.push(bytes);
        assert!(chunks.len() <= 17);
    }
    assert_eq!(chunks.text(), once.text());
    assert_eq!(chunks.end(), text.len());
    assert_eq!(chunks.dropped() + chunks.len(), text.len());
    assert!(!chunks.text().contains('\u{fffd}'));
    assert!(chunks.truncated());
}
