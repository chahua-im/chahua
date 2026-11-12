//! WeChat article pages inline megabytes of application JS after the share meta.
//! Read only a bounded HTML prefix, stopping at complete share tags or head end.
use std::cell::Cell;

use html5ever::tokenizer::{
    states::RawKind, BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
};
// Re-tokenize the bounded prefix rather than retaining a non-Send HTML tokenizer
// across network awaits. Do not call end(): an incomplete tag must not count.
pub(crate) fn head_complete(bytes: &[u8]) -> bool {
    let tokenizer = Tokenizer::new(Head::default(), Default::default());
    let input = BufferQueue::default();
    input.push_back(String::from_utf8_lossy(bytes).as_ref().into());
    let _ = tokenizer.feed(&input);
    tokenizer.sink.complete()
}

#[derive(Default)]
struct Head {
    title: Cell<bool>,
    image: Cell<bool>,
    description: Cell<bool>,
    ended: Cell<bool>,
}

impl Head {
    fn complete(&self) -> bool {
        self.ended.get() || (self.title.get() && self.image.get() && self.description.get())
    }
}

impl TokenSink for Head {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let Token::TagToken(tag) = token else {
            return TokenSinkResult::Continue;
        };
        if self.complete() {
            return TokenSinkResult::Continue;
        }
        if (tag.kind == TagKind::EndTag && tag.name.as_ref() == "head")
            || (tag.kind == TagKind::StartTag && tag.name.as_ref() == "body")
        {
            self.ended.set(true);
        }
        if tag.kind != TagKind::StartTag {
            return TokenSinkResult::Continue;
        }
        match tag.name.as_ref() {
            "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
            "style" | "noscript" => return TokenSinkResult::RawData(RawKind::Rawtext),
            "title" => return TokenSinkResult::RawData(RawKind::Rcdata),
            "meta" => {
                let content = tag
                    .attrs
                    .iter()
                    .find(|a| a.name.local.as_ref() == "content");
                if let Some(content) = content {
                    for attr in &tag.attrs {
                        if !matches!(attr.name.local.as_ref(), "property" | "name") {
                            continue;
                        }
                        match attr.value.trim().to_ascii_lowercase().as_str() {
                            "og:title" if !content.value.trim().is_empty() => self.title.set(true),
                            "og:image" | "og:image:secure_url"
                                if !content.value.trim().is_empty() =>
                            {
                                self.image.set(true)
                            }
                            "og:description" => self.description.set(true),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stops_only_after_complete_tags_and_allows_empty_description() {
        let html = "<head><meta property='og:title' content='标题'><meta property='og:image' content='https://example.com/a.jpg'><meta property='og:description' content=''>";
        assert!(head_complete(html.as_bytes()));
        assert!(!head_complete(&html.as_bytes()[..html.len() - 1]));
        assert!(!head_complete(b"<meta property='og:title' content=''>"));
        assert!(head_complete(b"<head><title>Fallback</title></head>"));
    }
    #[test]
    fn ignores_markup_inside_scripts_comments_and_attributes() {
        for html in [
            "<head><script>const text = '</head>';</script>",
            "<head><!-- </head> -->",
            "<head><meta content='</head>'>",
            "<head><style>/* </head> */</style>",
        ] {
            assert!(!head_complete(html.as_bytes()), "{html}");
        }
    }
}
