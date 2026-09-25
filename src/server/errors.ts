/**
 * 统一错误类型。前端依据 code 区分下载失败、磁盘不可写、数据库失败、保存冲突等情况。
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_MEDIA'
  | 'TOO_LARGE'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOAD_BLOCKED'
  | 'DISK_WRITE_FAILED'
  | 'DB_ERROR'
  | 'BUSY'
  | 'BACKUP_INVALID'
  | 'BACKUP_UNSUPPORTED'
  | 'RESTORE_TARGET_INVALID'
  | 'DATA_DIR_INVALID'
  | 'DATA_DIR_LOCKED'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_BACKUP_FAILED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  UNSUPPORTED_MEDIA: 415,
  TOO_LARGE: 413,
  DOWNLOAD_FAILED: 502,
  DOWNLOAD_BLOCKED: 400,
  DISK_WRITE_FAILED: 507,
  DB_ERROR: 500,
  BUSY: 503,
  BACKUP_INVALID: 400,
  BACKUP_UNSUPPORTED: 400,
  RESTORE_TARGET_INVALID: 400,
  DATA_DIR_INVALID: 500,
  DATA_DIR_LOCKED: 409,
  SCHEMA_TOO_NEW: 500,
  MIGRATION_BACKUP_FAILED: 500,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options?.details;
  }
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
    return new AppError('DB_ERROR', `数据库操作失败：${String(e.message ?? '')}`, { cause: err });
  }
  return new AppError('INTERNAL', '服务内部错误', { cause: err });
}
