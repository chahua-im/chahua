use super::{
    validate_client_message_type, AppError, MessageType, FORWARDED_MESSAGE_TYPE_FORBIDDEN,
    INVITE_MESSAGE_TYPE_FORBIDDEN, SYSTEM_MESSAGE_TYPE_FORBIDDEN,
};

#[test]
fn rejects_system_message_type_from_clients() {
    let err =
        validate_client_message_type(&MessageType::System).expect_err("system should be rejected");
    assert!(matches!(err, AppError::BadRequest(msg) if msg == SYSTEM_MESSAGE_TYPE_FORBIDDEN));
}

#[test]
fn allows_standard_message_types_from_clients() {
    assert!(validate_client_message_type(&MessageType::Text).is_ok());
    assert!(validate_client_message_type(&MessageType::Audio).is_ok());
    assert!(validate_client_message_type(&MessageType::File).is_ok());
    assert!(validate_client_message_type(&MessageType::Sticker).is_ok());
}

#[test]
fn rejects_invite_message_type_from_generic_message_api() {
    let err =
        validate_client_message_type(&MessageType::Invite).expect_err("invite should be rejected");
    assert!(matches!(err, AppError::BadRequest(msg) if msg == INVITE_MESSAGE_TYPE_FORBIDDEN));
}

#[test]
fn rejects_forwarded_message_type_from_generic_message_api() {
    let err = validate_client_message_type(&MessageType::Forwarded)
        .expect_err("forwarded should be rejected");
    assert!(matches!(err, AppError::BadRequest(msg) if msg == FORWARDED_MESSAGE_TYPE_FORBIDDEN));
}
