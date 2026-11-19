import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';

export enum UploadStage {
  Config = 'config',
  Processing = 'processing',
  Signing = 'signing',
  Storage = 'storage',
}

export enum UploadErrorCode {
  TooLarge = 'tooLarge',
  Empty = 'empty',
  FilenameMissing = 'filenameMissing',
  FilenameTooLong = 'filenameTooLong',
  UnsupportedMedia = 'unsupportedMedia',
  InvalidType = 'invalidType',
  Authentication = 'authentication',
  Forbidden = 'forbidden',
  StorageRejected = 'storageRejected',
  RateLimited = 'rateLimited',
  Server = 'server',
  Timeout = 'timeout',
  TransferStalled = 'transferStalled',
  StorageResponseTimeout = 'storageResponseTimeout',
  Network = 'network',
  Unreadable = 'unreadable',
  ProcessingTimeout = 'processingTimeout',
  ProcessingFailed = 'processingFailed',
  Rejected = 'rejected',
  Protocol = 'protocol',
  Unknown = 'unknown',
}

export interface UploadFailure {
  code: UploadErrorCode;
  stage: UploadStage;
  autoRetry: boolean;
  canRetry: boolean;
  maxSizeMiB?: number;
  rpcCode?: RpcErrorCode;
  storage?: StorageFailure;
}

interface StorageFailure {
  status: number;
  code?: string;
  requestId?: string;
  expired?: boolean;
}

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code);
  }
}

export class StorageUploadError extends Error {
  readonly storage: StorageFailure;

  constructor(
    readonly status: number,
    responseText: string,
  ) {
    super('上传失败');
    this.storage = { status };
    if (!responseText) return;
    const root = new DOMParser().parseFromString(responseText, 'application/xml').documentElement;
    if (root.localName !== 'Error') return;
    const fields = Array.from(root.children);
    const read = (name: string) => fields.find((field) => field.localName === name)?.textContent.trim();
    const code = storageIdentifier(read('Code'));
    this.storage = {
      status,
      code,
      requestId: storageIdentifier(read('RequestId')),
      // S3 can report an expired URL with AccessDenied and a specific message.
      expired: code === 'AccessDenied' && /^Request has expired\.?$/i.test(read('Message') ?? ''),
    };
  }
}

function storageIdentifier(value?: string): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
}

const validationErrors = new Map([
  ['Attachment size must be positive', UploadErrorCode.Empty],
  ['Attachment filename is required', UploadErrorCode.FilenameMissing],
  ['Attachment filename is too long', UploadErrorCode.FilenameTooLong],
  ['Media uploads must be images or videos', UploadErrorCode.UnsupportedMedia],
  ['Attachment content type is invalid', UploadErrorCode.InvalidType],
  ['Voice uploads must be audio', UploadErrorCode.InvalidType],
]);

const rpcErrors = new Map<RpcErrorCode, UploadErrorCode>([
  [RpcErrorCode.PayloadTooLarge, UploadErrorCode.TooLarge],
  [RpcErrorCode.Unauthorized, UploadErrorCode.Authentication],
  [RpcErrorCode.Forbidden, UploadErrorCode.Forbidden],
  [RpcErrorCode.Overloaded, UploadErrorCode.RateLimited],
  [RpcErrorCode.Unavailable, UploadErrorCode.Server],
  [RpcErrorCode.Internal, UploadErrorCode.Server],
  [RpcErrorCode.DispatcherInternal, UploadErrorCode.Server],
  [RpcErrorCode.InvalidParams, UploadErrorCode.Protocol],
  [RpcErrorCode.InvalidRequest, UploadErrorCode.Protocol],
  [RpcErrorCode.ParseError, UploadErrorCode.Protocol],
]);

const transportErrors = {
  timeout: UploadErrorCode.Timeout,
  overloaded: UploadErrorCode.RateLimited,
  disconnected: UploadErrorCode.Network,
  protocol: UploadErrorCode.Protocol,
} satisfies Record<RpcTransportError['kind'], UploadErrorCode>;

export function uploadFailure(error: unknown, stage: UploadStage, maximumSize?: number): UploadFailure {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  const detail = error && typeof error === 'object' && 'error' in error ? error.error : undefined;
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  let code: UploadErrorCode;
  if (error instanceof UploadError) code = error.code;
  else if (error instanceof RpcTransportError) code = transportErrors[error.kind];
  else if (error instanceof RpcError) {
    code =
      (error.code === RpcErrorCode.BadRequest ? validationErrors.get(error.message) : rpcErrors.get(error.code)) ??
      UploadErrorCode.Rejected;
  } else if (error instanceof DOMException && (error.name === 'NotReadableError' || error.name === 'NotFoundError'))
    code = UploadErrorCode.Unreadable;
  else if (stage === UploadStage.Processing)
    code = timedOut ? UploadErrorCode.ProcessingTimeout : UploadErrorCode.ProcessingFailed;
  else if (status === 413 || (error instanceof StorageUploadError && error.storage.code === 'EntityTooLarge'))
    code = UploadErrorCode.TooLarge;
  else if (status === 408 || timedOut) code = UploadErrorCode.Timeout;
  else if (status === 429) code = UploadErrorCode.RateLimited;
  else if (status != null && status >= 500) code = UploadErrorCode.Server;
  else if (stage === UploadStage.Storage && status != null && status >= 400) code = UploadErrorCode.StorageRejected;
  else if (status === 401) code = UploadErrorCode.Authentication;
  else if (status === 403) code = UploadErrorCode.Forbidden;
  else if (status === 400 && typeof detail === 'string')
    code = validationErrors.get(detail) ?? UploadErrorCode.Rejected;
  else if (status != null && status >= 400) code = UploadErrorCode.Rejected;
  else if (status === 0) code = UploadErrorCode.Network;
  else code = UploadErrorCode.Unknown;

  const canRetry = ![
    UploadErrorCode.TooLarge,
    UploadErrorCode.Empty,
    UploadErrorCode.FilenameMissing,
    UploadErrorCode.FilenameTooLong,
    UploadErrorCode.UnsupportedMedia,
    UploadErrorCode.InvalidType,
    UploadErrorCode.Unreadable,
  ].includes(code);
  const autoRetry = [
    UploadErrorCode.Timeout,
    UploadErrorCode.TransferStalled,
    UploadErrorCode.StorageResponseTimeout,
    UploadErrorCode.Network,
    UploadErrorCode.RateLimited,
    UploadErrorCode.Server,
  ].includes(code);
  return {
    code,
    stage,
    canRetry,
    autoRetry,
    ...(error instanceof UploadError && code === UploadErrorCode.TooLarge && maximumSize != null
      ? { maxSizeMiB: maximumSize / 1024 / 1024 }
      : {}),
    ...(error instanceof RpcError ? { rpcCode: error.code } : {}),
    ...(error instanceof StorageUploadError ? { storage: error.storage } : {}),
  };
}
