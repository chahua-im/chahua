//! App share links expose note metadata to mobile clients. Preserve their query
//! parameters (including xsec_token) and never use the login page as a preview.

use url::Url;

pub(crate) fn is_login_page(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("www.xiaohongshu.com" | "xiaohongshu.com")
    ) && (url.path() == "/login" || url.path().starts_with("/login/"))
}

// The ci proxy can return 404 while its embedded signed CDN URL still works.
// Preserve the CDN path/signature; discard only the proxy's image transformations.
pub(crate) fn cover_url(page: &Url, image: Url) -> Url {
    if !matches!(
        page.host_str(),
        Some("www.xiaohongshu.com" | "xiaohongshu.com")
    ) || image.host_str() != Some("ci.xiaohongshu.com")
    {
        return image;
    }
    let embedded = image
        .path()
        .strip_prefix("/http://")
        .or_else(|| image.path().strip_prefix("/https://"));
    if let Some(raw) = embedded {
        if let Some(url) = super::super::validate_url(&format!("https://{raw}")) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_uses_https_cdn_without_proxy_transformations() {
        let page = Url::parse("https://www.xiaohongshu.com/discovery/item/123").unwrap();
        let image = Url::parse("https://ci.xiaohongshu.com/http://sns-webpic-qc.xhscdn.com/date/signature/note!h5_1080jpg?imageMogr2/crop/450x300").unwrap();
        assert_eq!(
            cover_url(&page, image).as_str(),
            "https://sns-webpic-qc.xhscdn.com/date/signature/note!h5_1080jpg"
        );
        for raw in [
            "https://ci.xiaohongshu.com/http://127.0.0.1/image",
            "https://ci.xiaohongshu.com/http://evil.test/image",
            "https://ci.xiaohongshu.com/http://user@sns-webpic-qc.xhscdn.com/image",
            "https://ci.xiaohongshu.com/http://@sns-webpic-qc.xhscdn.com/image",
            "https://ci.xiaohongshu.com/http://sns-webpic-qc.xhscdn.com:8443/image",
            "https://sns-webpic-qc.xhscdn.com/original.jpg?signature=test",
        ] {
            let image = Url::parse(raw).unwrap();
            assert_eq!(cover_url(&page, image.clone()), image);
        }
        let image =
            Url::parse("https://ci.xiaohongshu.com/http://sns-webpic-qc.xhscdn.com/image").unwrap();
        assert_eq!(
            cover_url(&Url::parse("https://example.com/").unwrap(), image.clone()),
            image
        );
    }

    #[test]
    fn login_detection_uses_host_and_path_not_title_or_query() {
        for raw in [
            "https://www.xiaohongshu.com/login?redirectPath=note",
            "https://xiaohongshu.com/login/",
        ] {
            assert!(is_login_page(&Url::parse(raw).unwrap()));
        }
        for raw in [
            "https://example.com/login",
            "https://www.xiaohongshu.com/explore/123?next=/login",
            "https://www.xiaohongshu.com/login-example",
        ] {
            assert!(!is_login_page(&Url::parse(raw).unwrap()));
        }
    }
}
