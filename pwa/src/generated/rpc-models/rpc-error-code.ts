/** Generated from OpenRPC x-error-codes by scripts/api-codegen.ts. */
export enum RpcErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  DispatcherInternal = -32603,
  BadRequest = 1000,
  Unauthorized = 1001,
  Forbidden = 1003,
  NotFound = 1004,
  Conflict = 1009,
  Gone = 1010,
  PayloadTooLarge = 1013,
  SpeakingRestricted = 1103,
  Unavailable = 1503,
  Internal = 1500,
  Overloaded = 1429,
}
