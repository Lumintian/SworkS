/** 页面启动时读取的会话信息：CSRF 令牌、版本、数据目录与限制。 */
import type { SessionDTO } from '../../shared/api.js';
import { APP_VERSION } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { lastBackupAt } from './backup.js';

export function getSession(ctx: AppContext): SessionDTO {
  return {
    csrfToken: ctx.csrfToken,
    appVersion: APP_VERSION,
    schemaVersion: schemaVersion(ctx.db),
    libraryId: ctx.libraryId,
    dataDir: ctx.paths.root,
    address: ctx.security.address,
    lastBackupAt: lastBackupAt(ctx),
    limits: {
      maxImageBytes: ctx.limits.maxImageBytes,
      remoteTimeoutMs: ctx.limits.remoteTimeoutMs,
      maxRedirects: ctx.limits.maxRedirects,
      allowFakeIpDns: ctx.fetchPolicy.allowFakeIpRange === true,
    },
  };
}
