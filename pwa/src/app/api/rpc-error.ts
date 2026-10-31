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

/** A local transport failure, before a JSON-RPC error response exists. */
export class RpcTransportError extends Error {
  constructor(
    readonly kind: 'disconnected' | 'timeout' | 'overloaded' | 'protocol',
    message: string = kind,
  ) {
    super(message);
    this.name = 'RpcTransportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
