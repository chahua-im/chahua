use super::*;
#[test]
fn search_limit_defaults_to_twenty_and_caps_to_message_max() {
    assert_eq!(search_limit(None), 20);
    assert_eq!(search_limit(Some(500)), 100);
    assert_eq!(search_limit(Some(0)), 1);
}

#[test]
fn search_offset_rejects_requests_outside_result_window() {
    assert_eq!(search_offset(None, 20).unwrap(), 0);
    assert_eq!(
        search_offset(Some(MAX_SEARCH_RESULT_WINDOW - 20), 20).unwrap(),
        980
    );
    assert!(matches!(
        search_offset(Some(MAX_SEARCH_RESULT_WINDOW - 19), 20),
        Err(AppError::BadRequest("Search offset is too large"))
    ));
}

#[test]
fn search_next_offset_stops_at_result_window() {
    assert_eq!(
        search_next_offset(Some(MAX_SEARCH_RESULT_WINDOW - 20), 20),
        Some(980)
    );
    assert_eq!(
        search_next_offset(Some(MAX_SEARCH_RESULT_WINDOW - 19), 20),
        None
    );
    assert_eq!(search_next_offset(None, 20), None);
}

#[test]
fn search_sort_rejects_unknown_values() {
    assert!(serde_json::from_str::<MessageSearchSort>("\"oldest\"").is_err());
    assert_eq!(
        serde_json::from_str::<MessageSearchSort>("\"newest\"").unwrap(),
        MessageSearchSort::Newest
    );
}
