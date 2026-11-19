import { RpcErrorCode } from '../../generated/rpc-models';

export { RpcErrorCode } from '../../generated/rpc-models';

/** A JSON-RPC application or protocol error returned by the server. */
export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isGroupChatWriteRestrictedError(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    error.code === RpcErrorCode.Forbidden &&
    typeof error.data === 'object' &&
    error.data != null &&
    'reason' in error.data &&
    error.data.reason === 'groupChatWriteRestricted'
  );
}

/** A local transport failure, before a JSON-RPC error response exists. */
export class RpcTransportError extends Error {
  constructor(
    readonly kind: 'disconnected' | 'timeout' | 'overloaded' | 'protocol',
    message: string = kind,
    readonly sent = kind !== 'overloaded',
  ) {
    super(message);
    this.name = 'RpcTransportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
