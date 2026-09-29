/** 与本机服务通信。只有服务端确认落盘（2xx）才算成功。 */
import type { ApiErrorBody, ErrorCode, SessionDTO } from '@shared/api';
import { CLIENT_HEADER, CSRF_HEADER } from '@shared/constants';
import { TAB_ID } from './broadcast';

/** 服务端错误码，加上只在前端出现的：连不上服务、取不到会话、响应不是约定的错误格式、页面自身的异常。 */
export type ApiErrorCode = ErrorCode | 'NETWORK' | 'SESSION' | 'UNKNOWN' | `HTTP_${number}`;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let session: SessionDTO | null = null;
let sessionPromise: Promise<SessionDTO> | null = null;

export async function loadSession(force = false): Promise<SessionDTO> {
  if (session && !force) return session;
  if (!sessionPromise || force) {
    sessionPromise = fetch('/api/session', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new ApiError('SESSION', '无法获取会话信息', res.status);
        session = (await res.json()) as SessionDTO;
        return session;
      })
      .catch((err: unknown) => {
        sessionPromise = null;
        if (err instanceof ApiError) throw err;
        throw new ApiError('NETWORK', '无法连接到 SworkS 服务，请确认服务仍在运行', 0);
      });
  }
  return sessionPromise;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiError(body.error.code, body.error.message, res.status, body.error.details);
  } catch {
    return new ApiError(`HTTP_${res.status}`, `请求失败（HTTP ${res.status}）`, res.status);
  }
}

async function send(method: string, url: string, init: { body?: BodyInit; json?: boolean }, retried = false): Promise<Response> {
  const s = await loadSession();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        [CSRF_HEADER]: s.csrfToken,
        [CLIENT_HEADER]: TAB_ID,
        ...(init.json ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('NETWORK', '无法连接到 SworkS 服务，内容仍保留在页面上，可稍后重试', 0);
  }
  if (res.status === 403 && !retried) {
    // 服务重启后令牌会变化：刷新一次再重试
    const err = await toError(res.clone());
    if (err.code === 'CSRF') {
      await loadSession(true);
      return send(method, url, init, true);
    }
  }
  if (!res.ok) throw await toError(res);
  return res;
}

export async function getJSON<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('NETWORK', '无法连接到 SworkS 服务', 0);
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export async function sendJSON<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body !== undefined ? { body: JSON.stringify(body), json: true } : {});
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function uploadFile<T>(url: string, file: Blob, filename: string, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  form.append('file', file, filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await send('POST', url, { body: form });
  return (await res.json()) as T;
}

export async function postForBlob(url: string, body: unknown): Promise<{ blob: Blob; fileName: string; headers: Headers }> {
  const res = await send('POST', url, { body: JSON.stringify(body), json: true });
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  return { blob: await res.blob(), fileName: m?.[1] ?? 'download.zip', headers: res.headers };
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
