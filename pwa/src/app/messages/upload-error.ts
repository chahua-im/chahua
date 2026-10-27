export enum UploadStage {
  Config = 'config',
  Processing = 'processing',
  Signing = 'signing',
  Storage = 'storage',
}

export enum UploadErrorCode {
  Offline = 'offline',
  TooLarge = 'tooLarge',
  Empty = 'empty',
  Filename = 'filename',
  UnsupportedMedia = 'unsupportedMedia',
  InvalidType = 'invalidType',
  Authentication = 'authentication',
  Forbidden = 'forbidden',
  StorageRejected = 'storageRejected',
  RateLimited = 'rateLimited',
  Server = 'server',
  Timeout = 'timeout',
  Network = 'network',
  Unreadable = 'unreadable',
  ProcessingTimeout = 'processingTimeout',
  ProcessingFailed = 'processingFailed',
  Rejected = 'rejected',
  Unknown = 'unknown',
}

export interface UploadFailure {
  code: UploadErrorCode;
  stage: UploadStage;
  autoRetry: boolean;
  canRetry: boolean;
  maxSizeMiB?: number;
}

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code);
  }
}

export function uploadFailure(error: unknown, stage: UploadStage, maximumSize?: number): UploadFailure {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  const detail = error && typeof error === 'object' && 'error' in error ? error.error : undefined;
  let code: UploadErrorCode;
  if (error instanceof UploadError) code = error.code;
  else if (navigator.onLine === false) code = UploadErrorCode.Offline;
  else if (error instanceof DOMException && (error.name === 'NotReadableError' || error.name === 'NotFoundError'))
    code = UploadErrorCode.Unreadable;
  else if (stage === UploadStage.Processing) code = UploadErrorCode.ProcessingFailed;
  else if (status === 413) code = UploadErrorCode.TooLarge;
  else if (status === 408 || (error instanceof Error && error.name === 'TimeoutError')) code = UploadErrorCode.Timeout;
  else if (status === 429) code = UploadErrorCode.RateLimited;
  else if (status != null && status >= 500) code = UploadErrorCode.Server;
  else if (stage === UploadStage.Storage && status != null && status >= 400) code = UploadErrorCode.StorageRejected;
  else if (status === 401) code = UploadErrorCode.Authentication;
  else if (status === 403) code = UploadErrorCode.Forbidden;
  else if (status === 400 && detail === 'Attachment size must be positive') code = UploadErrorCode.Empty;
  else if (
    status === 400 &&
    (detail === 'Attachment filename is required' || detail === 'Attachment filename is too long')
  )
    code = UploadErrorCode.Filename;
  else if (status === 400 && detail === 'Media uploads must be images or videos')
    code = UploadErrorCode.UnsupportedMedia;
  else if (
    status === 400 &&
    (detail === 'Attachment content type is invalid' || detail === 'Voice uploads must be audio')
  )
    code = UploadErrorCode.InvalidType;
  else if (status != null && status >= 400) code = UploadErrorCode.Rejected;
  else if (status === 0) code = UploadErrorCode.Network;
  else code = UploadErrorCode.Unknown;

  const canRetry = ![
    UploadErrorCode.TooLarge,
    UploadErrorCode.Empty,
    UploadErrorCode.Filename,
    UploadErrorCode.UnsupportedMedia,
    UploadErrorCode.InvalidType,
    UploadErrorCode.Unreadable,
  ].includes(code);
  const autoRetry = [
    UploadErrorCode.Offline,
    UploadErrorCode.Timeout,
    UploadErrorCode.Network,
    UploadErrorCode.RateLimited,
    UploadErrorCode.Server,
  ].includes(code);
  return {
    code,
    stage,
    canRetry,
    autoRetry,
    ...(code === UploadErrorCode.TooLarge && maximumSize != null ? { maxSizeMiB: maximumSize / 1024 / 1024 } : {}),
  };
}
