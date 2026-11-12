use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkPreviewHandler {
    Xiaohongshu,
    Weixin,
    Zhihu,
}
#[derive(Debug)]
struct Site {
    headers: HeaderMap,
    handler: Option<LinkPreviewHandler>,
}
#[derive(Debug)]
pub(crate) struct LinkPreviewConfig {
    sites: HashMap<String, Site>,
}
impl LinkPreviewConfig {
    fn insert(
        &mut self,
        host: &str,
        handler: Option<LinkPreviewHandler>,
        headers: &[(&str, &str)],
    ) {
        let headers = headers
            .iter()
            .map(|(name, value)| {
                let mut value = HeaderValue::from_str(value).expect("valid built-in header");
                value.set_sensitive(true);
                (
                    HeaderName::from_bytes(name.as_bytes()).expect("valid built-in header name"),
                    value,
                )
            })
            .collect();
        self.sites.insert(host.into(), Site { headers, handler });
    }
    pub(super) fn headers_for(&self, host: &str) -> Option<&HeaderMap> {
        self.sites.get(host).map(|s| &s.headers)
    }
    pub(super) fn handler_for(&self, host: &str) -> Option<LinkPreviewHandler> {
        self.sites.get(host).and_then(|s| s.handler)
    }
    #[cfg(test)]
    pub(super) fn empty() -> Self {
        Self {
            sites: HashMap::new(),
        }
    }
    #[cfg(test)]
    pub(super) fn with_site(
        mut self,
        host: &str,
        handler: Option<LinkPreviewHandler>,
        headers: &[(&str, &str)],
    ) -> Self {
        self.insert(host, handler, headers);
        self
    }
}
impl Default for LinkPreviewConfig {
    fn default() -> Self {
        let mut config = Self {
            sites: HashMap::new(),
        };
        const ZHIHU_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/3.14.4 Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36";
        const XIAOHONGSHU_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        for host in ["www.zhihu.com", "zhuanlan.zhihu.com"] {
            config.insert(
                host,
                Some(LinkPreviewHandler::Zhihu),
                &[("User-Agent", ZHIHU_USER_AGENT)],
            );
        }
        config.insert(
            "static.zhihu.com",
            None,
            &[("User-Agent", ZHIHU_USER_AGENT)],
        );
        for host in [
            "www.xiaohongshu.com",
            "xiaohongshu.com",
            "xhslink.cn",
            "xhslink.com",
        ] {
            config.insert(
                host,
                Some(LinkPreviewHandler::Xiaohongshu),
                &[("User-Agent", XIAOHONGSHU_USER_AGENT)],
            );
        }
        config.insert("mp.weixin.qq.com", Some(LinkPreviewHandler::Weixin), &[("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"), ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")]);
        config
    }
}

pub(super) mod weixin;
pub(super) mod xiaohongshu;
pub(super) mod zhihu;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_profiles_are_scoped_to_exact_hosts() {
        let config = LinkPreviewConfig::default();
        for (host, handler) in [
            ("www.zhihu.com", LinkPreviewHandler::Zhihu),
            ("zhuanlan.zhihu.com", LinkPreviewHandler::Zhihu),
            ("www.xiaohongshu.com", LinkPreviewHandler::Xiaohongshu),
            ("xiaohongshu.com", LinkPreviewHandler::Xiaohongshu),
            ("xhslink.cn", LinkPreviewHandler::Xiaohongshu),
            ("xhslink.com", LinkPreviewHandler::Xiaohongshu),
            ("mp.weixin.qq.com", LinkPreviewHandler::Weixin),
        ] {
            assert_eq!(config.handler_for(host), Some(handler));
            assert!(config.headers_for(host).unwrap().contains_key("user-agent"));
        }
        assert!(config.headers_for("static.zhihu.com").is_some());
        assert_eq!(config.handler_for("static.zhihu.com"), None);
        for host in [
            "example.com",
            "other.xiaohongshu.com",
            "www.zhihu.com.evil.test",
            "sub.www.zhihu.com",
        ] {
            assert!(config.headers_for(host).is_none());
            assert_eq!(config.handler_for(host), None);
        }
    }
}
