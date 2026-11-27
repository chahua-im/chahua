use super::{
    batches::{flush_batch, BatchAssembly},
    controls::{generation_checks, handle_lifecycle_failure},
    execution::{schedule_call, ResultDestination, ScheduledCall, SessionExecution, WorkResult},
    io::RpcOutputSink,
    response::record_rejection,
    MAX_BATCH_ITEMS,
};
use crate::rpc::{
    error::RpcErrorCode,
    protocol::{parse_message, RpcCall, RpcId, RpcItem, RpcMessage, RpcResponse},
};
use std::collections::{HashMap, HashSet};
use tokio::time::Instant;

// The session loop alone owns request IDs, batch assembly, and handshake gating.
pub(super) struct SessionLoop {
    pub(super) execution: SessionExecution,
    pub(super) sink: RpcOutputSink,
    pub(super) first_message: bool,
    pub(super) handshake_pending: bool,
    pub(super) next_batch: u64,
    pub(super) batches: HashMap<u64, BatchAssembly>,
    pub(super) outstanding: HashSet<RpcId>,
}

impl SessionLoop {
    pub(super) async fn handle_work_result(
        &mut self,
        result: WorkResult,
    ) -> std::ops::ControlFlow<()> {
        if matches!(result.destination, ResultDestination::Single) {
            if let Some(id) = result.id {
                self.outstanding.remove(&id);
            }
        }
        match result.destination {
            ResultDestination::Single => {
                if let Some(response) = result.response {
                    let lifecycle = response.lifecycle;
                    let success = response.success;
                    if lifecycle.is_some() {
                        self.execution.shared.suspend_authorized_work().await;
                    }
                    if self.sink.send_text(response.text).await.is_err() {
                        self.execution.shared.transport.close();
                        return std::ops::ControlFlow::Break(());
                    }
                    if result.activate_after_success && success {
                        self.activate_bound_session().await;
                    }
                    if let Some(failure) = lifecycle {
                        handle_lifecycle_failure(failure, &self.execution.shared, &self.sink).await;
                        return std::ops::ControlFlow::Break(());
                    }
                    if result.close_after_error && !success {
                        self.execution.shared.transport.close();
                        return std::ops::ControlFlow::Break(());
                    }
                } else if result.activate_after_success {
                    self.activate_bound_session().await;
                }
            }
            ResultDestination::Batch(batch_id) => {
                let response_lifecycle = result
                    .response
                    .as_ref()
                    .and_then(|response| response.lifecycle);
                if response_lifecycle.is_some() {
                    self.execution.shared.suspend_authorized_work().await;
                }
                let mut ready = None;
                if let Some(batch) = self.batches.get_mut(&batch_id) {
                    let activate_after_success = result.activate_after_success
                        && match &result.response {
                            Some(response) => response.success,
                            None => true,
                        };
                    batch.activate_after_success |= activate_after_success;
                    if result.counts_toward_batch {
                        batch.pending = batch.pending.saturating_sub(1);
                    }
                    if let Some(response) = result.response {
                        batch.push(response, result.close_after_error);
                    }
                    if batch.pending == 0 {
                        ready = self.batches.remove(&batch_id);
                    }
                }
                if let Some(batch) = ready {
                    let completed = self.finish_batch(batch).await;
                    if completed.is_break() {
                        return completed;
                    }
                }
            }
        }

        self.handshake_pending = false;
        std::ops::ControlFlow::Continue(())
    }
    pub(super) async fn handle_input_frame(
        &mut self,
        text: String,
        started: Instant,
    ) -> std::ops::ControlFlow<()> {
        let message = match parse_message(&text, MAX_BATCH_ITEMS) {
            Ok(message) => message,
            Err(response) => {
                let code = match &response.outcome {
                    crate::rpc::protocol::RpcOutcome::Failure { error } => error.code,
                    crate::rpc::protocol::RpcOutcome::Success { .. } => {
                        RpcErrorCode::InvalidRequest
                    }
                };
                match record_rejection(
                    &self.execution.services,
                    "unknown",
                    started,
                    Some(response),
                    code,
                ) {
                    Ok(Some(response)) => {
                        if self.sink.send_text(response.text).await.is_err() {
                            self.execution.shared.transport.close();
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                    _ => {
                        self.execution.shared.transport.close();
                        return std::ops::ControlFlow::Break(());
                    }
                }
                return std::ops::ControlFlow::Continue(());
            }
        };

        let opening_handshake = self.first_message;
        if self.first_message {
            self.first_message = false;
            let valid_open = matches!(
                &message,
                RpcMessage::Single(RpcItem::Call(RpcCall {
                    id: Some(RpcId::String(_) | RpcId::Number(_)),
                    method,
                    ..
                })) if method == "session.open"
            );
            if !valid_open {
                if let Ok(Some(response)) = record_rejection(
                    &self.execution.services,
                    "unknown",
                    started,
                    Some(RpcResponse::invalid_request()),
                    RpcErrorCode::InvalidRequest,
                ) {
                    let _ = self.sink.send_text(response.text).await;
                }
                self.execution.shared.transport.close();
                return std::ops::ControlFlow::Break(());
            }
            // Do not admit another frame until the first identity and
            // its response are settled, even if work tasks poll out of order.
            self.handshake_pending = true;
        }

        match message {
            RpcMessage::Single(RpcItem::Response) => {}
            RpcMessage::Single(RpcItem::Invalid(response)) => {
                match record_rejection(
                    &self.execution.services,
                    "unknown",
                    started,
                    Some(response),
                    RpcErrorCode::InvalidRequest,
                ) {
                    Ok(Some(response)) => {
                        if self.sink.send_text(response.text).await.is_err() {
                            self.execution.shared.transport.close();
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                    _ => {
                        self.execution.shared.transport.close();
                        return std::ops::ControlFlow::Break(());
                    }
                }
            }
            RpcMessage::Single(RpcItem::Call(call)) => {
                return self
                    .handle_single_call(call, started, opening_handshake)
                    .await;
            }
            RpcMessage::Batch(items) => {
                return self.handle_batch(items, started).await;
            }
        }
        std::ops::ControlFlow::Continue(())
    }
    async fn handle_single_call(
        &mut self,
        call: RpcCall,
        started: Instant,
        opening_handshake: bool,
    ) -> std::ops::ControlFlow<()> {
        let close_after_error = opening_handshake;
        match schedule_call(
            call,
            started,
            ResultDestination::Single,
            close_after_error,
            &mut self.execution,
            &mut self.outstanding,
        )
        .await
        {
            ScheduledCall::Pending => {}
            ScheduledCall::Immediate(Some(response)) => {
                if self.sink.send_text(response.text).await.is_err() {
                    self.execution.shared.transport.close();
                    return std::ops::ControlFlow::Break(());
                }
            }
            ScheduledCall::Immediate(None) => {}
            ScheduledCall::Duplicate(response) => {
                if let Some(response) = response {
                    let _ = self.sink.send_text(response.text).await;
                }
                self.execution.shared.transport.close();
                return std::ops::ControlFlow::Break(());
            }
        }
        std::ops::ControlFlow::Continue(())
    }
    async fn handle_batch(
        &mut self,
        items: Vec<RpcItem>,
        started: Instant,
    ) -> std::ops::ControlFlow<()> {
        let batch_id = self.next_batch;
        self.next_batch = self.next_batch.wrapping_add(1);
        let mut batch = BatchAssembly::new();
        for item in items {
            match item {
                RpcItem::Response => {}
                RpcItem::Invalid(response) => {
                    match record_rejection(
                        &self.execution.services,
                        "unknown",
                        started,
                        Some(response),
                        RpcErrorCode::InvalidRequest,
                    ) {
                        Ok(Some(response)) => batch.push(response, false),
                        _ => {
                            self.execution.shared.transport.close();
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                }
                RpcItem::Call(call) => {
                    if let Some(id) = &call.id {
                        batch.request_ids.push(id.clone());
                    }
                    let counts_toward_batch = call.id.is_some()
                        || matches!(
                            call.method.as_str(),
                            "session.open"
                                | "auth.createDevSession"
                                | "messageSync.resume"
                                | "messageSync.page"
                        );
                    if counts_toward_batch {
                        batch.pending += 1;
                    }
                    match schedule_call(
                        call,
                        started,
                        ResultDestination::Batch(batch_id),
                        false,
                        &mut self.execution,
                        &mut self.outstanding,
                    )
                    .await
                    {
                        ScheduledCall::Pending => {}
                        ScheduledCall::Immediate(response) => {
                            if counts_toward_batch {
                                batch.pending = batch.pending.saturating_sub(1);
                                if let Some(response) = response {
                                    batch.push(response, false);
                                }
                            }
                        }
                        ScheduledCall::Duplicate(response) => {
                            if let Some(response) = response {
                                let _ = self.sink.send_text(response.text).await;
                            }
                            self.execution.shared.transport.close();
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                }
            }
        }
        if batch.pending == 0 {
            return self.finish_batch(batch).await;
        } else {
            self.batches.insert(batch_id, batch);
        }
        std::ops::ControlFlow::Continue(())
    }
    async fn finish_batch(&mut self, mut batch: BatchAssembly) -> std::ops::ControlFlow<()> {
        let close_after_error = batch.close_after_error;
        let activate_after_success = batch.activate_after_success;
        let request_ids = std::mem::take(&mut batch.request_ids);
        match flush_batch(batch, &self.sink).await {
            Ok(lifecycle) => {
                for id in request_ids {
                    self.outstanding.remove(&id);
                }
                if let Some(failure) = lifecycle {
                    handle_lifecycle_failure(failure, &self.execution.shared, &self.sink).await;
                    return std::ops::ControlFlow::Break(());
                }
                if activate_after_success {
                    self.activate_bound_session().await;
                }
                if close_after_error {
                    self.execution.shared.transport.close();
                    return std::ops::ControlFlow::Break(());
                }
            }
            Err(_) => {
                self.execution.shared.transport.close();
                return std::ops::ControlFlow::Break(());
            }
        }
        std::ops::ControlFlow::Continue(())
    }
    async fn activate_bound_session(&self) {
        self.execution
            .shared
            .activate(&self.execution.services, &self.sink)
            .await;
        if let Some((session, _)) = self.execution.shared.bound_identity().await {
            tokio::spawn(generation_checks(
                self.execution.shared.clone(),
                self.execution.services.clone(),
                session,
                self.execution.guard_failures.clone(),
            ));
        }
    }
}
