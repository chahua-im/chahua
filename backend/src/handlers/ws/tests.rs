use super::selects_rpc;
use crate::services::presence::parse_legacy_presence_watch;

#[test]
fn first_object_with_jsonrpc_selects_rpc_without_falling_back_to_legacy() {
    assert!(selects_rpc(
        r#"{"jsonrpc":"2.0","method":"session.open","id":"1"}"#
    ));
    assert!(selects_rpc(
        r#"{"jsonrpc":null,"type":"auth","ticket":"legacy"}"#
    ));
    assert!(!selects_rpc(r#"{"type":"auth","ticket":"legacy"}"#));
    assert!(!selects_rpc(r#"["jsonrpc"]"#));
    assert!(!selects_rpc(r#"{"jsonrpc""2.0"}"#));
}

#[test]
fn legacy_presence_watch_replaces_with_empty_scope_without_publication() {
    assert!(matches!(
        parse_legacy_presence_watch(Some(4), Some(Vec::new()), Some(Vec::new())),
        Some(None)
    ));
}

#[test]
fn legacy_presence_watch_rejects_scopes_above_protocol_bounds() {
    assert!(parse_legacy_presence_watch(Some(4), Some((0..101).collect()), None).is_none());
}

#[tokio::test]
async fn oversized_ws_frames_close_with_1009_via_axum_downcast() {
    use axum::{extract::ws::WebSocketUpgrade, routing::get, Router};
    use futures::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{
            protocol::frame::{
                coding::{CloseCode, Data, OpCode},
                Frame,
            },
            Message as ClientMessage,
        },
    };

    let limit = crate::rpc::session::MAX_FRAME_BYTES;
    let app = Router::new().route(
        "/ws",
        get(move |ws: WebSocketUpgrade| async move {
            ws.max_message_size(limit)
                .max_frame_size(limit)
                .on_upgrade(|mut socket| async move {
                    while let Some(incoming) = socket.recv().await {
                        if let Err(error) = incoming {
                            if super::is_message_too_big(&error) {
                                let _ = socket.send(super::message_too_big_close()).await;
                            }
                            break;
                        }
                    }
                })
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("ws://{addr}/ws");

    for fragmented in [false, true] {
        let (mut client, _) = connect_async(&url).await.unwrap();
        let oversized = "x".repeat(limit + 1);
        if fragmented {
            let bytes = oversized.into_bytes();
            let split = bytes.len() / 2;
            client
                .send(ClientMessage::Frame(Frame::message(
                    bytes[..split].to_vec(),
                    OpCode::Data(Data::Text),
                    false,
                )))
                .await
                .unwrap();
            let _ = client
                .send(ClientMessage::Frame(Frame::message(
                    bytes[split..].to_vec(),
                    OpCode::Data(Data::Continue),
                    true,
                )))
                .await;
        } else {
            let _ = client.send(ClientMessage::Text(oversized.into())).await;
        }

        let close = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            match client.next().await.expect("close frame").expect("ws frame") {
                ClientMessage::Close(Some(frame)) => frame,
                other => panic!("expected close frame, got {other:?}"),
            }
        })
        .await
        .expect("close frame deadline");
        assert_eq!(close.code, CloseCode::Size);
    }

    server.abort();
}
