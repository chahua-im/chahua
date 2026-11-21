use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    io,
    sync::Arc,
};

use diesel::prelude::*;

use crate::{
    dto::{
        message_sync::{
            MessageSyncBatch, MessageSyncPageParams, MessageSyncPageResult, MessageSyncReady,
            MessageSyncReset, MessageSyncResumeParams, MessageSyncRevoked,
        },
        messages::ListMessagesQuery,
        ws::ServerWsMessage,
    },
    errors::AppError,
    rpc::session::MAX_FRAME_BYTES,
    schema::group_membership,
    services::{api::chats::messages::get_messages, sync_projection::check_projection},
};

use super::{Advance, ReplayService, SyncSubscription};

const CHUNK_LIMIT: usize = 128;

#[derive(Debug)]
pub(crate) enum SyncError {
    Protocol(&'static str),
    Backend(AppError),
    Delivery,
}

impl From<AppError> for SyncError {
    fn from(error: AppError) -> Self {
        Self::Backend(error)
    }
}

pub(crate) trait SyncSink {
    fn send(
        &mut self,
        frame: &ServerWsMessage,
    ) -> impl Future<Output = Result<(), SyncError>> + Send;
}

#[derive(Default)]
struct Manifest {
    bytes: usize,
    named: BTreeMap<i64, (Option<String>, bool)>,
    priority: Option<i64>,
}

/// Both transports serialize operations on this driver, including enqueuing
/// their results. Registry wakes never need to take the driver's lock.
pub(crate) struct SyncDriver {
    uid: i32,
    replay: ReplayService,
    subscription: Arc<SyncSubscription>,
    manifest: Option<Manifest>,
    installed: HashMap<i64, String>,
}

impl SyncDriver {
    pub(crate) fn new(
        uid: i32,
        replay: ReplayService,
        subscription: Arc<SyncSubscription>,
    ) -> Self {
        Self {
            uid,
            replay,
            subscription,
            manifest: Some(Manifest::default()),
            installed: HashMap::new(),
        }
    }

    pub(crate) fn is_resumed(&self) -> bool {
        self.manifest.is_none()
    }

    pub(crate) async fn resume(
        &mut self,
        params: MessageSyncResumeParams,
        mut send: impl SyncSink,
    ) -> Result<(), SyncError> {
        let manifest = self
            .manifest
            .as_mut()
            .ok_or(SyncError::Protocol("message sync was already resumed"))?;
        if params.chats.len() > CHUNK_LIMIT {
            return Err(SyncError::Protocol(
                "message sync resume chunk has more than 128 chats",
            ));
        }
        let mut budget = ManifestBudget(MAX_FRAME_BYTES - manifest.bytes);
        serde_json::to_writer(&mut budget, &params)
            .map_err(|_| SyncError::Protocol("message sync manifest exceeds the frame limit"))?;
        manifest.bytes = MAX_FRAME_BYTES - budget.0;
        if let Some(priority) = params.priority_chat_id {
            manifest.priority = Some(priority);
        }
        manifest.named.extend(
            params
                .chats
                .into_iter()
                .map(|entry| (entry.chat_id, (entry.cursor, true))),
        );
        if !params.last {
            return Ok(());
        }

        let mut manifest = self
            .manifest
            .take()
            .expect("resume manifest exists until last chunk");
        let uid = self.uid;
        let memberships = self
            .replay
            .snapshot(move |_, conn| {
                Ok(group_membership::table
                    .filter(group_membership::uid.eq(uid))
                    .select(group_membership::chat_id)
                    .load::<i64>(conn)?)
            })
            .await?;
        for chat_id in memberships {
            manifest.named.entry(chat_id).or_insert((None, false));
        }
        self.subscription.attach(manifest.named.keys().copied());
        if let Some(chat_id) = manifest.priority {
            if let Some((cursor, named)) = manifest.named.remove(&chat_id) {
                self.resume_chat(chat_id, cursor, named, &mut send).await?;
            }
        }
        for (chat_id, (cursor, named)) in manifest.named {
            self.resume_chat(chat_id, cursor, named, &mut send).await?;
        }
        // The RPC worker may have received a notification before resume. The
        // dirty IDs were left alone and must run now, even without another wake.
        self.subscription.notify_if_dirty();
        Ok(())
    }

    async fn resume_chat(
        &mut self,
        chat_id: i64,
        cursor: Option<String>,
        named: bool,
        send: &mut impl SyncSink,
    ) -> Result<(), SyncError> {
        let advance = self
            .replay
            .advance(self.uid, chat_id, cursor.clone())
            .await?;
        match advance {
            Advance::Unchanged => {
                let frame = ServerWsMessage::MessageSyncReady(MessageSyncReady {
                    chat_id,
                    cursor: cursor.expect("continuous resume requires a cursor"),
                });
                send.send(&frame).await?;
                let ServerWsMessage::MessageSyncReady(payload) = frame else {
                    unreachable!()
                };
                self.installed.insert(chat_id, payload.cursor);
            }
            Advance::Batch { .. } => {
                self.apply(chat_id, cursor, advance, named, send).await?;
                send.send(&ServerWsMessage::MessageSyncReady(MessageSyncReady {
                    chat_id,
                    cursor: self.installed[&chat_id].clone(),
                }))
                .await?;
            }
            _ => self.apply(chat_id, cursor, advance, named, send).await?,
        }
        Ok(())
    }

    pub(crate) async fn drain(&mut self, mut send: impl SyncSink) -> Result<(), SyncError> {
        if self.subscription.is_closed() {
            return Err(SyncError::Delivery);
        }
        if !self.is_resumed() {
            return Ok(());
        }
        for chat_id in self.subscription.take_dirty() {
            let cursor = self.installed.get(&chat_id).cloned();
            let attached = cursor.is_some();
            // Attach before checking membership. A concurrent settings change
            // must see either this attachment or the read's newer snapshot.
            if !attached {
                self.subscription.attach([chat_id]);
            }
            let advance = self
                .replay
                .advance(self.uid, chat_id, cursor.clone())
                .await?;
            self.apply(chat_id, cursor, advance, attached, &mut send)
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn page(
        &mut self,
        params: MessageSyncPageParams,
        mut send: impl SyncSink,
    ) -> Result<(), SyncError> {
        if !self.is_resumed() {
            return Err(SyncError::Protocol("message sync resume is not complete"));
        }
        let MessageSyncPageParams {
            request_id,
            chat_id,
            thread_id,
            before,
            after,
            around,
            max,
        } = params;
        let mut result = MessageSyncPageResult {
            request_id,
            chat_id,
            at: None,
            page: None,
        };
        if let Some(cursor) = self.installed.get(&chat_id).cloned() {
            let uid = self.uid;
            let (advance, cursor, page) = self
                .replay
                .snapshot(move |service, conn| {
                    let advance = service.advance_in_snapshot(conn, uid, chat_id, Some(&cursor))?;
                    let page = if matches!(advance, Advance::Revoked) {
                        None
                    } else {
                        let page = futures::executor::block_on(get_messages(
                            uid,
                            chat_id,
                            ListMessagesQuery {
                                before,
                                after,
                                around,
                                max,
                                thread_id,
                            },
                            conn,
                            &service.media,
                            &service.avatars,
                        ))?;
                        check_projection(conn)?;
                        Some(page)
                    };
                    Ok((advance, cursor, page))
                })
                .await?;
            self.apply(chat_id, Some(cursor), advance, true, &mut send)
                .await?;
            result.at = self.installed.get(&chat_id).cloned();
            result.page = page;
        }
        send.send(&ServerWsMessage::MessageSyncPageResult(result))
            .await
    }

    async fn apply(
        &mut self,
        chat_id: i64,
        from: Option<String>,
        advance: Advance,
        report_revoked: bool,
        send: &mut impl SyncSink,
    ) -> Result<(), SyncError> {
        let event = match advance {
            Advance::Revoked => {
                if report_revoked {
                    send.send(&ServerWsMessage::MessageSyncRevoked(MessageSyncRevoked {
                        chat_id,
                    }))
                    .await?;
                }
                self.subscription.detach(chat_id);
                self.installed.remove(&chat_id);
                return Ok(());
            }
            Advance::Unchanged => {
                // A continuous resume without a batch installs at Ready instead.
                return Ok(());
            }
            Advance::Reset { cursor, reason } => {
                ServerWsMessage::MessageSyncReset(MessageSyncReset {
                    chat_id,
                    cursor,
                    reason,
                })
            }
            Advance::Batch { to, changes } => ServerWsMessage::MessageSyncBatch(MessageSyncBatch {
                chat_id,
                from: from.expect("batch requires a previous cursor"),
                to,
                changes,
            }),
        };
        send.send(&event).await?;
        let cursor = match event {
            ServerWsMessage::MessageSyncReset(payload) => payload.cursor,
            ServerWsMessage::MessageSyncBatch(payload) => payload.to,
            _ => unreachable!(),
        };
        self.installed.insert(chat_id, cursor);
        Ok(())
    }
}

struct ManifestBudget(usize);

impl io::Write for ManifestBudget {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(buf.len())
            .ok_or(io::ErrorKind::FileTooLarge)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
