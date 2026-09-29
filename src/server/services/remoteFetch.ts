/**
 * 受控的远程图片下载：
 * - 只接受 http/https，拒绝带凭证的 URL；
 * - 每一跳（含重定向）都重新解析并校验地址，只允许公网单播地址；
 * - 实际连接通过自定义 lookup 使用已校验的地址，避免 DNS 重绑定；
 * - 超时、重定向次数、大小上限、按文件头校验图片格式；不转发任何浏览器凭证。
 */
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { INPUT_ONLY_IMAGE_MIMES, STORABLE_IMAGE_MIMES, type InputImageMime } from '../../shared/constants.js';
import { AppError } from '../errors.js';
import { SNIFF_BYTES, sniffImageInput, SUPPORTED_IMAGE_HINT } from './imageSniff.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchPolicy {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** 地址校验；默认只允许公网单播地址 */
  isAddressAllowed?: (ip: string) => boolean;
  /**
   * 额外允许 198.18.0.0/15（fake-ip DNS 使用的保留段，常见于代理软件或部分网络网关）。
   * 默认关闭；仅在所用 DNS 把外部域名解析到该段时由用户显式开启。
   */
  allowFakeIpRange?: boolean;
  /** DNS 解析；测试可注入 */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface DownloadResult {
  sha256: string;
  size: number;
  /** 可能是只能输入的格式（HEIC/AVIF），由归档器转换后再存 */
  mime: InputImageMime;
  finalUrl: string;
}

const FAKE_IP_RANGE = ipaddr.parseCIDR('198.18.0.0/15');

export function isFakeIpAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (!v6.isIPv4MappedAddress()) return false;
    addr = v6.toIPv4Address();
  }
  return (addr as ipaddr.IPv4).match(FAKE_IP_RANGE as [ipaddr.IPv4, number]);
}

function defaultAllowed(policy: FetchPolicy): (ip: string) => boolean {
  return (ip) => isPublicAddress(ip) || (policy.allowFakeIpRange === true && isFakeIpAddress(ip));
}

const FAKE_IP_HINT = '（该地址属于 198.18.0.0/15，常见于代理软件或网络网关的 fake-ip DNS；如确认如此，可用 --allow-fake-ip-dns 启动 SworkS）';

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() === 'unicast';
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

function describeUrlForError(url: URL): string {
  // 不在错误里回显查询参数，避免泄露签名等敏感信息
  return `${url.protocol}//${url.host}${url.pathname.length > 60 ? `${url.pathname.slice(0, 60)}…` : url.pathname}`;
}

export function parseRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('DOWNLOAD_BLOCKED', '图片地址不是有效的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('DOWNLOAD_BLOCKED', '只支持 http/https 图片地址');
  }
  if (url.username || url.password) throw new AppError('DOWNLOAD_BLOCKED', '不支持在 URL 中携带用户名或密码');
  if (!url.hostname) throw new AppError('DOWNLOAD_BLOCKED', '图片地址缺少主机名');
  return url;
}

async function resolveAndValidate(url: URL, policy: FetchPolicy): Promise<ResolvedAddress> {
  const allowed = policy.isAddressAllowed ?? defaultAllowed(policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!allowed(host)) throw new AppError('DOWNLOAD_BLOCKED', `拒绝访问非公网地址：${host}`);
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError('DOWNLOAD_BLOCKED', '拒绝访问本机地址');
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await (policy.resolve ?? defaultResolve)(host);
  } catch (err) {
    throw new AppError('DOWNLOAD_FAILED', `无法解析域名 ${host}`, { cause: err });
  }
  if (addrs.length === 0) throw new AppError('DOWNLOAD_FAILED', `无法解析域名 ${host}`);
  const bad = addrs.find((a) => !allowed(a.address));
  if (bad) {
    const hint = isFakeIpAddress(bad.address) && !policy.allowFakeIpRange ? FAKE_IP_HINT : '';
    throw new AppError('DOWNLOAD_BLOCKED', `域名 ${host} 解析到非公网地址 ${bad.address}，已拒绝${hint}`);
  }
  return addrs[0]!;
}

function requestOnce(url: URL, target: ResolvedAddress, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const lookup = ((_host: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
      if (options?.all) cb(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    }) as unknown as net.LookupFunction;
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      lookup,
      signal,
      headers: {
        'user-agent': 'SworkS/0.1 (local image archiver)',
        accept: `${[...STORABLE_IMAGE_MIMES, ...INPUT_ONLY_IMAGE_MIMES].join(',')},image/*;q=0.8`,
      },
    });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

/** 下载图片到 destPath（调用方负责清理/提交）。 */
export async function downloadImage(rawUrl: string, policy: FetchPolicy, destPath: string): Promise<DownloadResult> {
  let url = parseRemoteUrl(rawUrl);
  const signal = AbortSignal.timeout(policy.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      const target = await resolveAndValidate(url, policy);
      const res = await requestOnce(url, target, signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= policy.maxRedirects) {
          throw new AppError('DOWNLOAD_FAILED', `重定向次数超过 ${policy.maxRedirects} 次`);
        }
        url = parseRemoteUrl(new URL(res.headers.location, url).toString());
        continue;
      }
      if (status !== 200) {
        res.resume();
        throw new AppError('DOWNLOAD_FAILED', `服务器返回 HTTP ${status}（${describeUrlForError(url)}）`);
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > policy.maxBytes) {
        res.destroy();
        throw new AppError('TOO_LARGE', `图片超过 ${Math.round(policy.maxBytes / 1024 / 1024)} MiB 上限`);
      }
      const ctype = String(res.headers['content-type'] ?? '').toLowerCase();
      if (ctype && !ctype.startsWith('image/') && !ctype.startsWith('application/octet-stream') && !ctype.startsWith('binary/')) {
        res.destroy();
        throw new AppError('UNSUPPORTED_MEDIA', `链接返回的不是图片（${ctype.split(';')[0]}）`);
      }
      return await streamToFile(res, destPath, policy.maxBytes, url.toString());
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || signal.aborted) {
      throw new AppError('DOWNLOAD_FAILED', `下载超时（${Math.round(policy.timeoutMs / 1000)} 秒）`, { cause: err });
    }
    if (e.code && ['EACCES', 'EROFS', 'ENOSPC', 'EPERM'].includes(e.code)) throw err;
    throw new AppError('DOWNLOAD_FAILED', `下载失败：${e.code ?? e.message}`, { cause: err });
  }
}

async function streamToFile(
  res: http.IncomingMessage,
  destPath: string,
  maxBytes: number,
  finalUrl: string,
): Promise<DownloadResult> {
  const hash = createHash('sha256');
  const out = fs.createWriteStream(destPath, { flags: 'wx' });
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of res) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) {
        res.destroy();
        throw new AppError('TOO_LARGE', `图片超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`);
      }
      if (head.length < SNIFF_BYTES) head = Buffer.concat([head, buf.subarray(0, SNIFF_BYTES - head.length)]);
      hash.update(buf);
      if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    const fd = await fs.promises.open(destPath, 'r+');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (err) {
    out.destroy();
    throw err;
  }
  const mime = sniffImageInput(head);
  if (!mime) throw new AppError('UNSUPPORTED_MEDIA', `下载内容不是受支持的图片。${SUPPORTED_IMAGE_HINT}`);
  return { sha256: hash.digest('hex'), size, mime, finalUrl };
}
