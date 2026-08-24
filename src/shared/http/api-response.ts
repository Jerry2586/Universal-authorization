export interface ApiSuccess<T> {
  request_id: string;
  success: true;
  code: 'OK';
  message: string;
  server_time: string;
  data: T;
}

export interface ApiFailure {
  request_id: string;
  success: false;
  code: string;
  message: string;
  server_time: string;
  data: {
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
}

export function successResponse<T>(
  requestId: string,
  data: T,
  message = '操作成功',
  now = new Date(),
): ApiSuccess<T> {
  return {
    request_id: requestId,
    success: true,
    code: 'OK',
    message,
    server_time: now.toISOString(),
    data,
  };
}

export function failureResponse(options: {
  requestId: string;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
  now?: Date;
}): ApiFailure {
  const data: ApiFailure['data'] = {
    retryable: options.retryable ?? false,
  };

  if (options.details !== undefined) {
    data.details = options.details;
  }

  return {
    request_id: options.requestId,
    success: false,
    code: options.code,
    message: options.message,
    server_time: (options.now ?? new Date()).toISOString(),
    data,
  };
}
