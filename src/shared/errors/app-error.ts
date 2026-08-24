export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(options: {
    code: string;
    message: string;
    statusCode: number;
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
