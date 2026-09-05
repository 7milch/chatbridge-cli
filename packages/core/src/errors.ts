/** Base class for all framework errors. The CLI maps `code` to exit codes. */
export class ChatBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends ChatBridgeError {
  constructor(message: string) {
    super("AUTH_REQUIRED", message);
  }
}

export class AuthExpiredError extends ChatBridgeError {
  constructor(message: string) {
    super("AUTH_EXPIRED", message);
  }
}

export class ResponseTimeoutError extends ChatBridgeError {
  constructor(message: string) {
    super("RESPONSE_TIMEOUT", message);
  }
}

export class ProviderLoadError extends ChatBridgeError {
  constructor(message: string) {
    super("PROVIDER_LOAD", message);
  }
}
