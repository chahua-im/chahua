use super::payload::RecipientNotification;
use super::PushService;
use crate::models::{PushProvider, PushSubscription};
use tracing::{error, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DeliveryFailureAction {
    None,
    Counted,
    PruneImmediate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DeliveryFailureClass {
    InvalidSubscription,
    ProviderRejected,
    ProviderTransient,
    BackendConfig,
    PayloadBuild,
}

impl DeliveryFailureClass {
    pub(super) fn as_metrics_label(self) -> &'static str {
        match self {
            Self::InvalidSubscription => "invalid_subscription",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderTransient => "provider_transient",
            Self::BackendConfig => "backend_config",
            Self::PayloadBuild => "payload_build",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DeliveryFailureDetails {
    pub(super) class: DeliveryFailureClass,
    pub(super) reason: String,
    pub(super) action: DeliveryFailureAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DeliveryFailure {
    pub(super) subscription_id: i64,
    pub(super) user_id: i32,
    pub(super) provider: PushProvider,
    pub(super) class: DeliveryFailureClass,
    pub(super) reason: String,
    pub(super) action: DeliveryFailureAction,
}

impl DeliveryFailure {
    fn from_details(sub: &PushSubscription, details: DeliveryFailureDetails) -> Self {
        Self {
            subscription_id: sub.id,
            user_id: sub.user_id,
            provider: sub.provider,
            class: details.class,
            reason: details.reason,
            action: details.action,
        }
    }
}

impl PushService {
    pub(super) async fn send_to_subscription(
        &self,
        sub: &PushSubscription,
        input: &RecipientNotification<'_>,
    ) -> Result<(), DeliveryFailure> {
        let result = match sub.provider {
            PushProvider::WebPush => match &self.web_push_sender {
                Some(sender) => sender.send(sub, input).await,
                None => Err(not_configured("web_push_not_configured")),
            },
            PushProvider::Apns => match &self.apns_sender {
                Some(sender) => sender.send(sub, input).await,
                None => Err(not_configured("apns_not_configured")),
            },
            PushProvider::Fcm => match &self.fcm_sender {
                Some(sender) => sender.send(sub, input).await,
                None => Err(not_configured("fcm_not_configured")),
            },
        };
        self.metrics
            .record_notification(sub.provider.as_metrics_label(), result.is_ok());
        result.map_err(|details| {
            if details.action == DeliveryFailureAction::PruneImmediate {
                warn!(provider = sub.provider.as_metrics_label(), subscription_id = sub.id,
                    user_id = sub.user_id, failure_class = details.class.as_metrics_label(),
                    reason = %details.reason, action = "prune", "push delivery failed");
            } else {
                error!(provider = sub.provider.as_metrics_label(), subscription_id = sub.id,
                    user_id = sub.user_id, failure_class = details.class.as_metrics_label(),
                    reason = %details.reason, action = "retry", "push delivery failed");
            }
            DeliveryFailure::from_details(sub, details)
        })
    }
}

fn not_configured(reason: &str) -> DeliveryFailureDetails {
    DeliveryFailureDetails {
        class: DeliveryFailureClass::BackendConfig,
        reason: reason.to_owned(),
        action: DeliveryFailureAction::None,
    }
}
