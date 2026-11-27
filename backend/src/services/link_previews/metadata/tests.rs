use super::*;

fn extract(html: &str) -> FetchedLinkPreview {
    extract_preview(
        &Url::parse("https://example.com/articles/page").unwrap(),
        html.as_bytes(),
    )
    .unwrap()
}

#[test]
fn repeated_itemprops_borrow_content_once_per_supported_property() {
    let content = "x".repeat(65536);
    let keys = "image IMAGE unknown ".repeat(4096);
    let html = format!("<meta itemprop='{keys} headline description' content='{content}'>");
    let document = Html::parse_document(&html);
    let metadata = Metadata::from_document(&document);
    assert_eq!(metadata.items.len(), 3);
    let original = document
        .select(&selector("meta"))
        .next()
        .unwrap()
        .value()
        .attr("content")
        .unwrap();
    for values in metadata.items.values() {
        assert_eq!(values.len(), 1);
        assert!(std::ptr::eq(values[0], original));
    }
    let preview = extract(&html);
    assert_eq!(preview.title, "x".repeat(512));
    assert_eq!(preview.description.as_deref(), Some(preview.title.as_str()));
}

#[test]
fn repeated_image_property_preserves_later_safe_candidates() {
    let preview = extract("<title>Title</title><meta itemprop='image IMAGE' content='http://unsafe.example/a'><meta itemprop='image image' content='/cover.jpg'>");
    assert_eq!(
        preview.image_url.unwrap().as_str(),
        "https://example.com/cover.jpg"
    );
}

#[test]
fn metadata_priority_is_independent_of_document_order() {
    let preview = extract(
        r#"
            <title>Document</title><meta name="title" content="Ordinary">
            <meta name="twitter:title" content="Twitter">
            <meta property="og:title" content="  "><meta name="OG:TITLE" content=" First &amp; best ">
            <meta property="og:title" content="Later">
            <meta name="description" content="Ordinary description">
            <meta name="twitter:description" content="Twitter description">
            <meta property="og:description" content=" "><meta property="og:description" content="OG description">
        "#,
    );
    assert_eq!(preview.title, "First & best");
    assert_eq!(preview.description.as_deref(), Some("OG description"));
}

#[test]
fn title_fallbacks_support_metadata_and_article_headings() {
    for html in [
        "<meta name='twitter:title' content='Title'>",
        "<meta name='title' content='Title'>",
        "<meta itemprop='headline' content='Title'>",
        "<title>Title</title>",
        "<div class='post-title'><span>Title</span></div>",
        "<h2 class='entry-title'>Title</h2>",
        "<h1 class='ArticleTitle'>Title</h1>",
    ] {
        assert_eq!(extract(html).title, "Title", "{html}");
    }
}

#[test]
fn document_title_is_not_overridden_by_author_microdata() {
    let preview = extract("<title>Article</title><meta itemprop='name' content='Author'><meta itemprop='headline' content='Other headline'>");
    assert_eq!(preview.title, "Article");
}

#[test]
fn json_ld_text_is_bounded_by_unicode_characters() {
    let long = "茶".repeat(513);
    let json = serde_json::json!({"headline": long, "description": long});
    let preview = extract(&format!(
        "<script type='application/ld+json'>{json}</script>"
    ));
    assert_eq!(preview.title, "茶".repeat(512));
    assert_eq!(preview.description.unwrap(), "茶".repeat(512));
}

#[test]
fn description_falls_back_without_guessing_body_text() {
    for (tags, expected) in [
        (
            "<meta name='twitter:description' content='Summary'>",
            Some("Summary"),
        ),
        (
            "<meta name='description' content='Summary'>",
            Some("Summary"),
        ),
        (
            "<meta itemprop='description' content='Summary'>",
            Some("Summary"),
        ),
        ("<p>Unrelated body text</p>", None),
    ] {
        assert_eq!(
            extract(&format!("<title>Title</title>{tags}"))
                .description
                .as_deref(),
            expected
        );
    }
}

#[test]
fn json_ld_supports_objects_arrays_graphs_and_main_entities() {
    let article = r#"{"@type":"Article","headline":"Article &amp; title","description":"<p>Short <b>summary</b></p>","articleBody":"Long body","image":{"contentUrl":"../cover.jpg"}}"#;
    for json in [
        article.to_owned(),
        format!("[{article}]"),
        format!("{{\"@graph\":[{article}]}}"),
        format!("{{\"mainEntity\":{article}}}"),
    ] {
        let preview = extract(&format!(
            "<script type='application/ld+json'>{json}</script>"
        ));
        assert_eq!(preview.title, "Article & title");
        assert_eq!(preview.description.as_deref(), Some("Short summary"));
        assert_eq!(
            preview.image_url.unwrap().as_str(),
            "https://example.com/cover.jpg"
        );
    }
}

#[test]
fn malformed_or_irrelevant_json_ld_does_not_block_later_candidates() {
    let preview = extract(
        r#"
            <script type="application/ld+json">invalid</script>
            <script type="application/ld+json">[
              {"@type":"Organization","name":"Publisher","image":"/logo.png"},
              {"@type":"Article","headline":null,"description":42,"author":{"name":"Author"}},
              {"@type":"Article","headline":" ","description":"<p> </p>"},
              {"@type":"Article","headline":"Article","articleBody":"<p>Body &amp; text</p>"}
            ]</script>
        "#,
    );
    assert_eq!(preview.title, "Article");
    assert_eq!(preview.description.as_deref(), Some("Body & text"));
    assert!(preview.image_url.is_none());
}

#[test]
fn unsafe_image_candidates_fall_back_to_safe_relative_urls() {
    for invalid in [
        "http://example.com/image",
        "https://127.0.0.1/image",
        "https://user@example.com/image",
        "https://@example.com/image",
        "javascript:alert(1)",
        "https://example.com:8443/image",
        r"\evil.com\image",
    ] {
        let preview = extract(&format!(
            r#"<title>Title</title><base href="https://evil.com/"><meta property="og:image" content="{invalid}"><meta property="og:image" content="../cover.jpg">"#
        ));
        assert_eq!(
            preview.image_url.unwrap().as_str(),
            "https://example.com/cover.jpg",
            "{invalid}"
        );
    }
}

#[test]
fn image_fallbacks_cover_twitter_schema_and_legacy_links() {
    for tags in [
        "<meta name='twitter:image:src' content='/cover.jpg'>",
        "<meta name='twitter:image' content='/cover.jpg'>",
        "<meta itemprop='image' content='/cover.jpg'>",
        r#"<script type="application/ld+json">{"image":[null,"http://example.com/bad",{"url":"/cover.jpg"}]}</script>"#,
        "<link rel='image_src' href='/cover.jpg'>",
    ] {
        assert_eq!(
            extract(&format!("<title>Title</title>{tags}"))
                .image_url
                .unwrap()
                .as_str(),
            "https://example.com/cover.jpg"
        );
    }
    assert!(extract("<title>Title</title><img src='/logo.png'>")
        .image_url
        .is_none());
}

#[test]
fn secure_og_image_takes_precedence_over_other_images() {
    let preview = extract("<title>Title</title><meta property='og:image' content='/ordinary.jpg'><meta property='og:image:secure_url' content='/secure.jpg'>");
    assert_eq!(preview.image_url.unwrap().path(), "/secure.jpg");
}
