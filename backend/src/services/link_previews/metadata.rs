//! Pure HTML metadata extraction. Rule ordering is informed by metascraper 5.58.6
//! (MIT), commit 1a98097c1878ced8ef6a07913a9b988370d8a0e7, packages
//! metascraper-{title,description,image}/src/index.js. This is a deliberately
//! smaller Rust implementation: no site plugins, body-image guessing or network IO.

use std::collections::HashMap;

use scraper::{Html, Selector};
use serde_json::Value;
use url::Url;

use super::fetch::{resolve_reference, FetchedLinkPreview, PreviewFetchError};

const TITLE_META: &[&str] = &["og:title", "twitter:title", "title"];
const DESCRIPTION_META: &[&str] = &["og:description", "twitter:description", "description"];
const IMAGE_META: &[&str] = &[
    "og:image:secure_url",
    "og:image:url",
    "og:image",
    "twitter:image:src",
    "twitter:image",
];

struct Metadata {
    tags: HashMap<String, Vec<String>>,
    items: HashMap<String, Vec<String>>,
    json_ld: Vec<Value>,
}

impl Metadata {
    fn from_document(document: &Html) -> Self {
        let mut metadata = Self {
            tags: HashMap::new(),
            items: HashMap::new(),
            json_ld: Vec::new(),
        };
        for element in document.select(&selector("meta[content]")) {
            let value = element.value();
            let content = value.attr("content").expect("selected content");
            if content.trim().is_empty() {
                continue;
            }
            for key in ["property", "name"]
                .into_iter()
                .filter_map(|key| value.attr(key))
            {
                metadata
                    .tags
                    .entry(key.trim().to_ascii_lowercase())
                    .or_default()
                    .push(content.into());
            }
            if let Some(keys) = value.attr("itemprop") {
                for key in keys.split_whitespace() {
                    metadata
                        .items
                        .entry(key.to_ascii_lowercase())
                        .or_default()
                        .push(content.into());
                }
            }
        }
        for element in document.select(&selector("script[type]")) {
            if element
                .value()
                .attr("type")
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/ld+json"))
            {
                if let Ok(value) = serde_json::from_str(&element.text().collect::<String>()) {
                    metadata.json_ld.push(value);
                }
            }
        }
        metadata
    }

    fn meta<'a>(&'a self, keys: &'a [&'a str]) -> impl Iterator<Item = &'a str> {
        keys.iter().flat_map(|key| {
            self.tags
                .get(*key)
                .into_iter()
                .flatten()
                .map(String::as_str)
        })
    }

    fn item(&self, key: &str) -> impl Iterator<Item = &str> {
        self.items
            .get(key)
            .into_iter()
            .flatten()
            .map(String::as_str)
    }

    fn objects(&self) -> Vec<&Value> {
        fn collect<'a>(value: &'a Value, objects: &mut Vec<&'a Value>) {
            match value {
                Value::Array(values) => {
                    for value in values {
                        collect(value, objects);
                    }
                }
                Value::Object(object) => {
                    // Traverse page entities, not arbitrary nested authors, publishers or breadcrumbs.
                    if !ancillary(value) {
                        objects.push(value);
                    }
                    for key in ["@graph", "mainEntity"] {
                        if let Some(value) = object.get(key) {
                            collect(value, objects);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut objects = Vec::new();
        for value in &self.json_ld {
            collect(value, &mut objects);
        }
        objects
    }
}

fn ancillary(value: &Value) -> bool {
    fn excluded(kind: &str) -> bool {
        matches!(
            kind.rsplit(['/', '#']).next().unwrap_or(kind),
            "Organization" | "Person" | "BreadcrumbList" | "ListItem" | "ImageObject"
        )
    }
    match &value["@type"] {
        Value::String(kind) => excluded(kind),
        Value::Array(kinds) => {
            !kinds.is_empty() && kinds.iter().all(|kind| kind.as_str().is_some_and(excluded))
        }
        _ => false,
    }
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static metadata selector")
}

fn normalize(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then(|| value.chars().take(512).collect())
}

fn element_text(document: &Html, query: &str) -> Option<String> {
    document
        .select(&selector(query))
        .find_map(|element| normalize(&element.text().collect::<Vec<_>>().join(" ")))
}

fn json_text(objects: &[&Value], keys: &[&str]) -> Option<String> {
    for key in keys {
        for object in objects {
            if let Some(value) = object.get(*key).and_then(Value::as_str) {
                // JSON-LD can contain escaped entities and HTML (especially articleBody).
                let fragment = Html::parse_fragment(value);
                if let Some(text) =
                    normalize(&fragment.root_element().text().collect::<Vec<_>>().join(" "))
                {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn json_image(base: &Url, value: &Value) -> Option<Url> {
    match value {
        Value::String(raw) => resolve_reference(base, raw),
        Value::Array(values) => values.iter().find_map(|value| json_image(base, value)),
        Value::Object(object) => ["url", "contentUrl"]
            .iter()
            .filter_map(|key| object.get(*key))
            .find_map(|value| json_image(base, value)),
        _ => None,
    }
}

pub(super) fn extract_preview(
    base: &Url,
    bytes: &[u8],
) -> Result<FetchedLinkPreview, PreviewFetchError> {
    let document = Html::parse_document(&String::from_utf8_lossy(bytes));
    let metadata = Metadata::from_document(&document);
    let objects = metadata.objects();
    let title = metadata
        .meta(TITLE_META)
        .find_map(normalize)
        .or_else(|| element_text(&document, "title"))
        .or_else(|| metadata.item("headline").find_map(normalize))
        .or_else(|| json_text(&objects, &["headline", "name"]))
        .or_else(|| element_text(&document, ".post-title"))
        .or_else(|| element_text(&document, ".entry-title"))
        .or_else(|| element_text(&document, "h1[class*=title i]"))
        .ok_or(PreviewFetchError::MissingTitle)?;
    // Prefer an explicit summary to a potentially long articleBody.
    let description = metadata
        .meta(DESCRIPTION_META)
        .find_map(normalize)
        .or_else(|| metadata.item("description").find_map(normalize))
        .or_else(|| json_text(&objects, &["description", "articleBody"]));
    let image_url = metadata
        .meta(IMAGE_META)
        .chain(metadata.item("image"))
        .find_map(|raw| resolve_reference(base, raw))
        .or_else(|| {
            objects
                .iter()
                .filter_map(|object| object.get("image"))
                .find_map(|value| json_image(base, value))
        })
        .or_else(|| {
            document
                .select(&selector("link[rel~=image_src i][href]"))
                .filter_map(|element| element.value().attr("href"))
                .find_map(|raw| resolve_reference(base, raw))
        });
    Ok(FetchedLinkPreview {
        title,
        description,
        image_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(html: &str) -> FetchedLinkPreview {
        extract_preview(
            &Url::parse("https://example.com/articles/page").unwrap(),
            html.as_bytes(),
        )
        .unwrap()
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
}
