/** Base class for all framework errors. The CLI maps `code` to exit codes.
 * `options.cause` carries the underlying error (never auth content). */
export class ChatBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH_REQUIRED", message, options);
  }
}

export class AuthExpiredError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH_EXPIRED", message, options);
  }
}

export class ResponseTimeoutError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("RESPONSE_TIMEOUT", message, options);
  }
}

export class ProviderLoadError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROVIDER_LOAD", message, options);
  }
}

/** The provider's `name` cannot be used as an auth-state file name. */
export class InvalidProviderError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_PROVIDER", message, options);
  }
}

/** A ChatSession method was called in a state that does not allow it
 * (send while a send is pending, or after close). Caller bug, not a user
 * condition. */
export class InvalidStateError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_STATE", message, options);
  }
}

/** The service blocked the automated browser (bot challenge, IdP refusing
 * automation); logging in again would not help. The message suggests
 * --headful. */
export class BlockedError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("BLOCKED", message, options);
  }
}
