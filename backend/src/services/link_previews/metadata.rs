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

struct Metadata<'a> {
    tags: HashMap<String, Vec<&'a str>>,
    items: HashMap<&'static str, Vec<&'a str>>,
    json_ld: Vec<Value>,
}

impl<'doc> Metadata<'doc> {
    fn from_document(document: &'doc Html) -> Self {
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
                    .push(content);
            }
            if let Some(keys) = value.attr("itemprop") {
                // Only the three consumed properties can retain this borrowed value.
                // Repeated or unknown itemprop tokens cannot amplify content allocations.
                for key in ["headline", "description", "image"] {
                    if keys
                        .split_whitespace()
                        .any(|part| part.eq_ignore_ascii_case(key))
                    {
                        metadata.items.entry(key).or_default().push(content);
                    }
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
        keys.iter()
            .flat_map(|key| self.tags.get(*key).into_iter().flatten().copied())
    }

    fn item(&self, key: &str) -> impl Iterator<Item = &str> {
        self.items.get(key).into_iter().flatten().copied()
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

pub(super) fn normalize(value: &str) -> Option<String> {
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
    extract_preview_with_image_fallback(base, bytes, None)
}

pub(super) fn extract_preview_with_image_fallback(
    base: &Url,
    bytes: &[u8],
    image_fallback: Option<fn(&str) -> Option<Url>>,
) -> Result<FetchedLinkPreview, PreviewFetchError> {
    let document = Html::parse_document(&String::from_utf8_lossy(bytes));
    extract_document_preview(base, &document, image_fallback)
}

pub(super) fn extract_document_preview(
    base: &Url,
    document: &Html,
    image_fallback: Option<fn(&str) -> Option<Url>>,
) -> Result<FetchedLinkPreview, PreviewFetchError> {
    let metadata = Metadata::from_document(document);
    let objects = metadata.objects();
    let title = metadata
        .meta(TITLE_META)
        .find_map(normalize)
        .or_else(|| element_text(document, "title"))
        .or_else(|| metadata.item("headline").find_map(normalize))
        .or_else(|| json_text(&objects, &["headline", "name"]))
        .or_else(|| element_text(document, ".post-title"))
        .or_else(|| element_text(document, ".entry-title"))
        .or_else(|| element_text(document, "h1[class*=title i]"))
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
        })
        .or_else(|| metadata.meta(IMAGE_META).find_map(image_fallback?));
    Ok(FetchedLinkPreview {
        title,
        description,
        image_url,
    })
}

#[cfg(test)]
mod tests;
