/**
 * 服务端与前端共用的错误码。前端依据 code 区分下载失败、磁盘不可写、数据库失败、保存冲突等情况；
 * 安全中间件的拒绝（Host、Origin、CSRF、MCP 令牌）也在这里，前端据此决定是否刷新令牌重试。
 */

export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'FORBIDDEN_HOST',
  'FORBIDDEN_ORIGIN',
  'CSRF',
  'UNAUTHORIZED',
  'UNSUPPORTED_MEDIA',
  'TOO_LARGE',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_BLOCKED',
  'DISK_WRITE_FAILED',
  'DB_ERROR',
  'BUSY',
  'BACKUP_INVALID',
  'BACKUP_UNSUPPORTED',
  'RESTORE_TARGET_INVALID',
  'DATA_DIR_INVALID',
  'DATA_DIR_LOCKED',
  'SCHEMA_TOO_NEW',
  'MIGRATION_BACKUP_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  FORBIDDEN_HOST: 403,
  FORBIDDEN_ORIGIN: 403,
  CSRF: 403,
  UNAUTHORIZED: 401,
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

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}
