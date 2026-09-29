import type { RemoteImageCreateDTO, RemoteImageDTO, TextFileImportDTO, UploadResultDTO } from '@shared/api';
import { MIME_EXTENSIONS, type AssetMime } from '@shared/constants';
import { sendJSON, uploadFile } from './api';
import { formatBytes } from './format';

export function uploadImageFile(file: File, blockId?: string): Promise<UploadResultDTO> {
  return uploadFile<UploadResultDTO>('/api/uploads/image', file, file.name || 'pasted-image', blockId ? { blockId } : {});
}

export function recordPastedText(text: string, blockId?: string): Promise<{ rawInputId: string }> {
  return sendJSON('POST', '/api/raw-inputs/text', { text, ...(blockId ? { blockId } : {}) });
}

export function addRemoteImage(url: string, blockId?: string): Promise<RemoteImageCreateDTO> {
  return sendJSON('POST', '/api/remote-images', { url, ...(blockId ? { blockId } : {}) });
}

export function retryRemoteImage(id: string): Promise<RemoteImageDTO> {
  return sendJSON('POST', `/api/remote-images/${id}/retry`);
}

export function manualRemoteImage(id: string, file: File): Promise<RemoteImageDTO> {
  return uploadFile<RemoteImageDTO>(`/api/remote-images/${id}/manual`, file, file.name || 'manual-image');
}

export function importTextFile(file: File, blockId?: string): Promise<TextFileImportDTO> {
  return uploadFile<TextFileImportDTO>('/api/uploads/text-file', file, file.name, blockId ? { blockId } : {});
}

export { IMAGE_ACCEPT, imageMimeOfFile } from '@shared/constants';

export function extFor(mime: string): string {
  return MIME_EXTENSIONS[mime as AssetMime] ?? 'bin';
}

/** .md / .txt 文件（File.type 常为空，按扩展名判断） */
export function isTextImportFile(f: File): boolean {
  return /\.(md|markdown|txt)$/i.test(f.name) || f.type === 'text/markdown' || f.type === 'text/plain';
}

/** 收录时做了格式转换的提示文字，例如“已转换：HEIC 3.1 MB → WebP 0.9 MB” */
export function conversionMessage(r: UploadResultDTO): string | null {
  const c = r.conversion;
  return c ? `已转换：${c.from} ${formatBytes(c.originalSize)} → ${c.to} ${formatBytes(c.storedSize)}` : null;
}

export function isSingleUrl(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) && !t.includes('\n');
}
