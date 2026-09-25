/**
 * 工程默认值：集中配置，并在“数据目录与运行信息”页展示。
 */
export interface Limits {
  maxImageBytes: number;
  remoteTimeoutMs: number;
  maxRedirects: number;
  maxTextFileBytes: number;
  maxRequestBytes: number;
  /** 恢复时允许的最大解压总量 */
  maxRestoreBytes: number;
  maxRestoreEntries: number;
  maxRecordsBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxImageBytes: 20 * 1024 * 1024,
  remoteTimeoutMs: 30_000,
  maxRedirects: 3,
  maxTextFileBytes: 5 * 1024 * 1024,
  maxRequestBytes: 32 * 1024 * 1024,
  maxRestoreBytes: 50 * 1024 * 1024 * 1024,
  maxRestoreEntries: 500_000,
  maxRecordsBytes: 1024 * 1024 * 1024,
};

export const DEFAULT_PORT = 4821;
export const DEFAULT_HOST = '127.0.0.1';
