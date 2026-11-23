use std::{
    collections::HashSet,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{Arc, LazyLock},
};

use futures::FutureExt;
use tokio::{
    sync::{mpsc, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::{self, Instant},
};

use super::{
    admission,
    controls::{RpcControlCommand, SyncControlSlot},
    io::TransportState,
    response::{prepare_recorded, record_rejection, PreparedResponse},
    state::SessionShared,
    MAX_GLOBAL_IN_FLIGHT,
};
use crate::rpc::{
    error::{RpcError, RpcErrorCode, RpcLifecycleFailure},
    methods::{self, ExecutionClass},
    protocol::{RpcCall, RpcId, RpcResponse},
    RpcCallContext, RpcServices,
};

pub(super) static GLOBAL_ADMISSION: LazyLock<Arc<admission::Admission>> = LazyLock::new(|| {
    admission::Admission::new(
        MAX_GLOBAL_IN_FLIGHT,
        admission::MAX_ACCOUNT_IN_FLIGHT,
        admission::MAX_WAITING,
        admission::MAX_ACCOUNT_WAITING,
    )
});

// The executor outlives individual sessions and owns every admitted task.
// Reap completed handles on submission rather than tying a background reaper
// to one Tokio runtime (tests and embedders can create more than one runtime).
static ADMITTED_WORK: LazyLock<std::sync::Mutex<JoinSet<()>>> =
    LazyLock::new(|| std::sync::Mutex::new(JoinSet::new()));

fn supervise(work: impl Future<Output = ()> + Send + 'static, transport: Arc<TransportState>) {
    let mut jobs = ADMITTED_WORK.lock().expect("RPC executor lock");
    while let Some(result) = jobs.try_join_next() {
        if let Err(error) = result {
            tracing::error!(?error, "RPC supervised task failed");
        }
    }
    jobs.spawn(async move {
        if AssertUnwindSafe(work).catch_unwind().await.is_err() {
            // Do not log a panic payload: application input can appear in it.
            tracing::error!("RPC supervised operation panicked");
            transport.close();
        }
    });
}

pub(super) struct SessionAdmission {
    pub(super) ordinary: Arc<Semaphore>,
    pub(super) controls: Arc<Semaphore>,
}

#[derive(Clone, Copy)]
pub(super) enum ResultDestination {
    Single,
    Batch(u64),
}

pub(super) struct WorkResult {
    pub(super) id: Option<RpcId>,
    pub(super) destination: ResultDestination,
    pub(super) response: Option<PreparedResponse>,
    pub(super) close_after_error: bool,
    pub(super) activate_after_success: bool,
    pub(super) counts_toward_batch: bool,
}

pub(super) enum ScheduledCall {
    Pending,
    Immediate(Option<PreparedResponse>),
    Duplicate(Option<PreparedResponse>),
}

pub(super) struct SessionExecution {
    pub(super) shared: Arc<SessionShared>,
    pub(super) services: RpcServices,
    pub(super) controls: mpsc::Sender<RpcControlCommand>,
    pub(super) guard_failures: mpsc::UnboundedSender<RpcLifecycleFailure>,
    pub(super) results: mpsc::Sender<WorkResult>,
    pub(super) admission: SessionAdmission,
    pub(super) ordinary_admission: Arc<admission::Admission>,
    pub(super) next_sync_seq: u64,
}

struct CallMetadata {
    id: Option<RpcId>,
    api: &'static str,
    started: Instant,
    destination: ResultDestination,
}

struct CallAdmission {
    ordinary_request: Option<admission::Request>,
    control_permit: Option<OwnedSemaphorePermit>,
    deadline: Instant,
}

struct ScheduledWork {
    call: RpcCall,
    context: RpcCallContext,
    metadata: CallMetadata,
    admission: CallAdmission,
    close_after_error: bool,
    activate_after_success: bool,
    sync_control: bool,
}

impl SessionExecution {
    fn reject_call(
        &self,
        metadata: CallMetadata,
        error: RpcError,
        outstanding: &mut HashSet<RpcId>,
    ) -> ScheduledCall {
        let CallMetadata {
            id,
            api,
            started,
            destination,
        } = metadata;
        if let Some(id) = &id {
            if matches!(destination, ResultDestination::Single) {
                outstanding.remove(id);
            }
        }
        let code = error.code;
        let response = id.map(|id| RpcResponse::error(id, error));
        match record_rejection(&self.services, api, started, response, code) {
            Ok(response) => ScheduledCall::Immediate(response),
            Err(_) => {
                self.shared.transport.close();
                ScheduledCall::Immediate(None)
            }
        }
    }

    fn reject_control_overload(&self, metadata: &CallMetadata) -> ScheduledCall {
        let _ = record_rejection(
            &self.services,
            metadata.api,
            metadata.started,
            None,
            RpcErrorCode::Overloaded,
        );
        self.shared.transport.close();
        ScheduledCall::Immediate(None)
    }

    fn reserve_call_admission(
        &self,
        class: ExecutionClass,
        context: &RpcCallContext,
    ) -> Result<CallAdmission, RpcError> {
        let mut admission = CallAdmission {
            ordinary_request: None,
            control_permit: None,
            deadline: Instant::now() + admission::MAX_WAIT,
        };
        match class {
            ExecutionClass::Read | ExecutionClass::Mutation => {
                let session = context.session.as_ref().expect("validated ordinary call");
                admission.ordinary_request = Some(
                    self.ordinary_admission
                        .request(
                            session.uid,
                            &self.admission.ordinary,
                            admission.deadline,
                            &self.services.metrics.rpc_admission,
                        )
                        .ok_or_else(|| RpcError::new(RpcErrorCode::Overloaded))?,
                );
            }
            ExecutionClass::Session | ExecutionClass::Control => {
                admission.control_permit = Some(
                    self.admission
                        .controls
                        .clone()
                        .try_acquire_owned()
                        .map_err(|_| RpcError::new(RpcErrorCode::Overloaded))?,
                );
            }
        }
        Ok(admission)
    }

    fn reserve_sync_control(&mut self, context: &mut RpcCallContext) -> Result<(), RpcError> {
        let permit = context
            .controls
            .clone()
            .try_reserve_owned()
            .map_err(|_| RpcError::new(RpcErrorCode::Overloaded))?;
        context.sync_control = Some(Arc::new(SyncControlSlot {
            seq: self.next_sync_seq,
            permit: std::sync::Mutex::new(Some(permit)),
        }));
        self.next_sync_seq += 1;
        Ok(())
    }
}

fn validate_call(method: &str, context: &RpcCallContext) -> Result<ExecutionClass, RpcError> {
    match (methods::method_class(method), context.session.is_some()) {
        (None, true) => Err(RpcError::new(RpcErrorCode::MethodNotFound)),
        (None | Some(ExecutionClass::Read | ExecutionClass::Mutation), false) => Err(
            RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required"),
        ),
        (Some(class), _) => Ok(class),
    }
}

pub(super) async fn schedule_call(
    call: RpcCall,
    started: Instant,
    destination: ResultDestination,
    close_after_error: bool,
    execution: &mut SessionExecution,
    outstanding: &mut HashSet<RpcId>,
) -> ScheduledCall {
    let metadata = CallMetadata {
        id: call.id.clone(),
        api: methods::registered_name(&call.method),
        started,
        destination,
    };
    if let Some(id) = &metadata.id {
        if !outstanding.insert(id.clone()) {
            let response = record_rejection(
                &execution.services,
                metadata.api,
                started,
                Some(RpcResponse::invalid_request()),
                RpcErrorCode::InvalidRequest,
            )
            .ok()
            .flatten();
            return ScheduledCall::Duplicate(response);
        }
    }
    let Some(mut context) = execution
        .shared
        .call_context(
            execution.controls.clone(),
            metadata.id.clone(),
            execution.guard_failures.clone(),
        )
        .await
    else {
        if let Some(id) = &metadata.id {
            outstanding.remove(id);
        }
        let _ = record_rejection(
            &execution.services,
            metadata.api,
            started,
            None,
            RpcErrorCode::Unavailable,
        );
        return ScheduledCall::Immediate(None);
    };
    let class = match validate_call(&call.method, &context) {
        Ok(class) => class,
        Err(error) => return execution.reject_call(metadata, error, outstanding),
    };
    let admission = match execution.reserve_call_admission(class, &context) {
        Ok(admission) => admission,
        Err(error) => {
            return match class {
                ExecutionClass::Read | ExecutionClass::Mutation => {
                    execution.reject_call(metadata, error, outstanding)
                }
                ExecutionClass::Session | ExecutionClass::Control => {
                    execution.reject_control_overload(&metadata)
                }
            };
        }
    };
    let activate_after_success = matches!(
        call.method.as_str(),
        "session.open" | "auth.createDevSession"
    );
    let sync_control = matches!(
        call.method.as_str(),
        "messageSync.resume" | "messageSync.page"
    );
    if sync_control
        && context.message_sync_enabled
        && execution.reserve_sync_control(&mut context).is_err()
    {
        return execution.reject_control_overload(&metadata);
    }
    let work = ScheduledWork {
        call,
        context,
        metadata,
        admission,
        close_after_error,
        activate_after_success,
        sync_control,
    };
    supervise(
        run_scheduled_call(
            work,
            execution.shared.clone(),
            execution.services.clone(),
            execution.results.clone(),
        ),
        execution.shared.transport.clone(),
    );
    ScheduledCall::Pending
}

// None means the queued call was cancelled or its session stopped accepting work.
async fn wait_for_admission(
    request: admission::Request,
    deadline: Instant,
    shared: &Arc<SessionShared>,
    context: &mut RpcCallContext,
) -> Result<Option<admission::Permit>, RpcError> {
    if !request.is_waiting() {
        return Ok(Some(request.wait().await));
    }
    let mut close = shared.transport.close_subscription();
    // Wait outside the session loop so results, controls, and disconnects keep moving.
    let permit = tokio::select! {
        biased;
        _ = shared.transport.wait_closed(&mut close) => return Ok(None),
        result = time::timeout_at(deadline, request.wait()) => {
            result.map_err(|_| RpcError::new(RpcErrorCode::Overloaded))?
        }
    };
    let Some(current) = shared
        .call_context(
            context.controls.clone(),
            context.rpc_id.clone(),
            context
                .guard_failures
                .clone()
                .expect("session guard sender"),
        )
        .await
    else {
        return Ok(None);
    };
    *context = current;
    Ok(Some(permit))
}

async fn run_scheduled_call(
    work: ScheduledWork,
    shared: Arc<SessionShared>,
    services: RpcServices,
    results: mpsc::Sender<WorkResult>,
) {
    let ScheduledWork {
        call,
        mut context,
        metadata,
        admission,
        close_after_error,
        activate_after_success,
        sync_control,
    } = work;
    let CallMetadata {
        id,
        api,
        started,
        destination,
    } = metadata;
    let CallAdmission {
        ordinary_request,
        control_permit: _control_permit,
        deadline,
    } = admission;
    let counts_toward_batch = id.is_some() || activate_after_success || sync_control;
    let mut admission_error = None;
    // Running permits stay owned by this task through completion.
    let _ordinary_permit = if let Some(request) = ordinary_request {
        match wait_for_admission(request, deadline, &shared, &mut context).await {
            Ok(Some(permit)) => Some(permit),
            Ok(None) => return,
            Err(error) => {
                admission_error = Some(error);
                None
            }
        }
    } else {
        None
    };
    let (response, error) = if let Some(error) = admission_error {
        let code = error.code;
        (
            id.clone().map(|id| RpcResponse::error(id, error)),
            Some(code),
        )
    } else {
        match AssertUnwindSafe(methods::dispatch_call(&context, call, &services))
            .catch_unwind()
            .await
        {
            Ok(result) => result,
            Err(_) => {
                tracing::error!("RPC supervised operation panicked");
                let _ = record_rejection(
                    &services,
                    api,
                    started,
                    None,
                    RpcErrorCode::DispatcherInternal,
                );
                shared.transport.close();
                return;
            }
        }
    };
    let message_sync_enabled = context.message_sync_enabled;
    drop(context);
    let response = match prepare_recorded(&services, api, started, response, error) {
        Ok(response) => response,
        Err(_) => {
            shared.transport.close();
            return;
        }
    };
    if id.is_none()
        && sync_control
        && message_sync_enabled
        && error == Some(RpcErrorCode::InvalidParams)
    {
        shared.transport.close();
        return;
    }
    let result = WorkResult {
        id,
        destination,
        close_after_error: close_after_error
            || (sync_control && message_sync_enabled && error == Some(RpcErrorCode::InvalidParams)),
        response,
        activate_after_success,
        counts_toward_batch,
    };
    let _ = results.send(result).await;
}
