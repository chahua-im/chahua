//! Mainland and overseas share pages expose note metadata to mobile clients.
//! Preserve share parameters and reject login and note error pages.

use scraper::{Html, Selector};
use serde_json::Value;
use url::Url;

use super::super::{
    fetch::{FetchedLinkPreview, PreviewFetchError},
    metadata::{extract_document_preview, normalize},
    validate_url,
};

// The fetcher selects this handler from the configured hostname before calling.
pub(crate) fn is_unavailable_page(url: &Url) -> bool {
    matches!(
        url.path_segments().and_then(|mut segments| segments.next()),
        Some("login" | "404")
    )
}

pub(crate) fn extract_preview(
    page: &Url,
    bytes: &[u8],
) -> Result<FetchedLinkPreview, PreviewFetchError> {
    let document = Html::parse_document(&String::from_utf8_lossy(bytes));
    let generic = extract_document_preview(page, &document, None).map(|mut preview| {
        preview.image_url = preview.image_url.map(cover_url);
        preview
    });
    let Some(note) = embedded_note(page, &document) else {
        return generic;
    };

    let title = note["title"].as_str().and_then(normalize);
    let mut preview = match generic {
        Ok(mut preview) => {
            if let Some(title) = title {
                preview.title = title;
            }
            preview
        }
        Err(error) => FetchedLinkPreview {
            title: title.ok_or(error)?,
            description: None,
            image_url: None,
        },
    };
    preview.description = preview
        .description
        .or_else(|| note["desc"].as_str().and_then(normalize));
    preview.image_url = preview.image_url.or_else(|| {
        [
            note["cover"]["url"].as_str(),
            note["imageList"][0]["url"].as_str(),
        ]
        .into_iter()
        .flatten()
        .find_map(note_cover_url)
    });
    Ok(preview)
}

fn embedded_note(page: &Url, document: &Html) -> Option<Value> {
    let path = page.path().trim_end_matches('/');
    let id = path
        .strip_prefix("/discovery/item/")
        .or_else(|| path.strip_prefix("/explore/"))?;
    if id.len() != 24 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let scripts = Selector::parse("script:not([src])").expect("static script selector");
    document.select(&scripts).find_map(|script| {
        let source = script
            .text()
            .next()?
            .trim_start()
            .strip_prefix("window.__INITIAL_STATE__")?
            .trim_start()
            .strip_prefix('=')?
            .trim()
            .trim_end_matches(';');
        let mut state = parse_state(source)?;
        let note = state.pointer_mut("/noteData/data/noteData")?;
        note["noteId"]
            .as_str()?
            .eq_ignore_ascii_case(id)
            .then(|| note.take())
    })
}

// The embedded JSON object can contain bare undefined values for absent fields.
fn parse_state(source: &str) -> Option<Value> {
    let mut json = String::with_capacity(source.len());
    let mut chars = source.chars();
    let mut quoted = false;
    let mut escaped = false;
    while let Some(character) = chars.next() {
        if !quoted && character == 'u' {
            if let Some(rest) = chars.as_str().strip_prefix("ndefined") {
                json.push_str("null");
                chars = rest.chars();
                continue;
            }
        }
        if character == '"' && !escaped {
            quoted = !quoted;
        }
        escaped = quoted && character == '\\' && !escaped;
        json.push(character);
    }
    serde_json::from_str(&json).ok()
}

fn note_cover_url(raw: &str) -> Option<Url> {
    let raw = raw.trim();
    let image = if let Some(target) = raw.strip_prefix("http://") {
        validate_url(&format!("https://{target}"))
    } else {
        validate_url(raw)
    }?;
    let image = cover_url(image);
    image
        .host_str()
        .is_some_and(|host| host.ends_with(".xhscdn.com") || host.ends_with(".rednotecdn.com"))
        .then_some(image)
}

// The ci proxy can return 404 while its embedded signed CDN URL still works.
// Preserve the CDN path/signature; discard only the proxy's image transformations.
fn cover_url(image: Url) -> Url {
    if image.host_str() != Some("ci.xiaohongshu.com") {
        return image;
    }
    let embedded = image
        .path()
        .strip_prefix("/http://")
        .or_else(|| image.path().strip_prefix("/https://"));
    if let Some(raw) = embedded {
        if let Some(url) = validate_url(&format!("https://{raw}")) {
            if url
                .host_str()
                .is_some_and(|host| host.ends_with(".xhscdn.com"))
            {
                return url;
            }
        }
    }
    image
}
