use super::*;

#[tokio::test]
async fn uploads_use_browser_proxy_only_when_configured() {
    use aws_sdk_s3::config::{Credentials, Region};

    let endpoint = "http://127.0.0.1:19000";
    for proxy_path in [None, Some("/_storage")] {
        let client = aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .region(Region::new("us-west-2"))
                .credentials_provider(Credentials::new("test", "test", None, None, "test"))
                .endpoint_url(endpoint)
                .force_path_style(true)
                .build(),
        );
        let store = MediaStore::new(
            client,
            Arc::new(crate::config::MediaConfig {
                bucket: "local-bucket".into(),
                attachment_prefix: "attachments".into(),
                base_url: Some("/_storage/local-bucket".into()),
                endpoint_url: Some(endpoint.into()),
                upload_proxy_path: proxy_path.map(str::to_owned),
                max_attachment_file_size_bytes: 1024,
            }),
        );
        let upload = store
            .presign_upload(
                "attachments/a b+%.webp",
                "image/webp",
                42,
                None,
                Duration::minutes(15),
            )
            .await
            .unwrap();
        assert!(upload.upload_url.starts_with(&format!(
            "{}/local-bucket/attachments/a%20b%2B%25.webp?",
            proxy_path.unwrap_or(endpoint),
        )));
        assert!(upload.upload_url.contains("X-Amz-Signature="));
        assert_eq!(upload.upload_headers["content-type"], "image/webp");
        assert!(!upload.upload_headers.contains_key("content-length"));
        assert_eq!(
            store.public_url("attachments/photo.webp"),
            "/_storage/local-bucket/attachments/photo.webp"
        );
    }
}

#[tokio::test]
async fn link_preview_storage_operations_timeout_on_stalled_response() {
    use aws_sdk_s3::config::{Credentials, Region};
    use tokio::io::AsyncReadExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = sent.clone();
            tokio::spawn(async move {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..count]);
                sent.send(request.split_whitespace().next().unwrap().to_owned())
                    .unwrap();
                // Keep the connection open without sending response headers.
                std::future::pending::<()>().await;
                drop(socket);
            });
        }
    });
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version_latest()
            .region(Region::new("us-west-2"))
            .credentials_provider(Credentials::new("test", "test", None, None, "test"))
            .endpoint_url(&endpoint)
            .force_path_style(true)
            .build(),
    );
    let store = MediaStore::new(
        client,
        Arc::new(crate::config::MediaConfig {
            bucket: "local-bucket".into(),
            attachment_prefix: "attachments".into(),
            base_url: None,
            endpoint_url: Some(endpoint),
            upload_proxy_path: None,
            max_attachment_file_size_bytes: 1024,
        }),
    );
    let (put, ()) = tokio::time::timeout(
        PREVIEW_STORAGE_TIMEOUT + std::time::Duration::from_secs(3),
        async {
            tokio::join!(
                store.put_preview_object("link-previews/test.webp", "image/webp", vec![1].into()),
                store.delete_preview_object("link-previews/test.webp"),
            )
        },
    )
    .await
    .expect("preview storage operations must finish");
    assert!(put.is_err());
    let first = received.try_recv().unwrap();
    let second = received.try_recv().unwrap();
    assert!(matches!(
        (first.as_str(), second.as_str()),
        ("PUT", "DELETE") | ("DELETE", "PUT")
    ));
    server.abort();
}

#[test]
fn storage_key_uses_file_extension() {
    assert_eq!(
        build_storage_key("attachments", "clip.OGG", "abc"),
        "attachments/abc.OGG"
    );
}

#[test]
fn storage_key_falls_back_to_bin_without_extension() {
    assert_eq!(
        build_storage_key("stickers", "noextension", "abc"),
        "stickers/abc.bin"
    );
}

#[test]
fn attachment_disposition_uses_safe_fallback_and_utf8_filename() {
    assert_eq!(
            attachment_content_disposition("résumé \"draft\".pdf"),
            "attachment; filename=\"r_sum_ _draft_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22.pdf"
        );
}
