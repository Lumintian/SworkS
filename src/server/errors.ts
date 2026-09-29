/**
 * 统一错误类型。错误码与 HTTP 状态在 `shared/errors.ts`，前后端共用。
 * 数据库的原始报错只写进日志（cause），不返回给页面。
 */
import { ERROR_STATUS, errorBody, type ErrorBody, type ErrorCode } from '../shared/errors.js';

export type { ErrorCode } from '../shared/errors.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.message, this.details);
  }
}

/** 直接构造错误响应（中间件在进入路由之前拒绝请求时用）。 */
export function errorResponse(code: ErrorCode, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(errorBody(code, message)), {
    status: ERROR_STATUS[code],
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

const DISK_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO', 'EMFILE']);

/** 将底层异常归类为用户可理解的错误。 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e?.code === 'string' && DISK_ERRNOS.has(e.code)) {
    return new AppError('DISK_WRITE_FAILED', `磁盘写入失败（${e.code}），数据未保存`, { cause: err });
  }
  if (e?.name === 'SqliteError' || (typeof e?.code === 'string' && e.code.startsWith('SQLITE_'))) {
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'SQLITE_FULL' || code.startsWith('SQLITE_IOERR')) {
      return new AppError('DISK_WRITE_FAILED', '磁盘已满或无法写入，数据未保存', { cause: err });
    }
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return new AppError('BUSY', '数据库正忙，请稍后重试', { cause: err });
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return new AppError('DB_ERROR', '数据库约束冲突，数据未保存', { cause: err });
    }
    return new AppError('DB_ERROR', '数据库操作失败，数据未保存', { cause: err });
  }
  return new AppError('INTERNAL', '服务内部错误', { cause: err });
}
