use super::{
    io::{RpcIoError, RpcOutputSink},
    response::PreparedResponse,
    MAX_FRAME_BYTES,
};
use crate::rpc::{error::RpcLifecycleFailure, protocol::RpcId};

pub(super) struct BatchAssembly {
    pub(super) pending: usize,
    pub(super) responses: Vec<PreparedResponse>,
    pub(super) request_ids: Vec<RpcId>,
    pub(super) lifecycle: Option<RpcLifecycleFailure>,
    pub(super) close_after_error: bool,
    pub(super) activate_after_success: bool,
}

impl BatchAssembly {
    pub(super) fn new() -> Self {
        Self {
            pending: 0,
            responses: Vec::new(),
            request_ids: Vec::new(),
            lifecycle: None,
            close_after_error: false,
            activate_after_success: false,
        }
    }

    pub(super) fn push(&mut self, response: PreparedResponse, close_after_error: bool) {
        self.lifecycle = self.lifecycle.or(response.lifecycle);
        self.close_after_error |= close_after_error && !response.success;
        self.responses.push(response);
    }
}

pub(super) async fn flush_batch(
    batch: BatchAssembly,
    sink: &RpcOutputSink,
) -> Result<Option<RpcLifecycleFailure>, RpcIoError> {
    if batch.responses.is_empty() {
        return Ok(batch.lifecycle);
    }
    let bytes = 2
        + batch
            .responses
            .iter()
            .map(|response| response.text.len())
            .sum::<usize>()
        + batch.responses.len().saturating_sub(1);
    if bytes > MAX_FRAME_BYTES {
        return Err(RpcIoError::FrameTooLarge);
    }
    let mut text = String::with_capacity(bytes);
    text.push('[');
    for (index, response) in batch.responses.iter().enumerate() {
        if index != 0 {
            text.push(',');
        }
        text.push_str(&response.text);
    }
    text.push(']');
    let lifecycle = batch.lifecycle;
    drop(batch);
    sink.send_text(text).await?;
    Ok(lifecycle)
}
