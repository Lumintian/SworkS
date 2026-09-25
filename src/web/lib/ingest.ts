import type { RemoteImageCreateDTO, RemoteImageDTO, TextFileImportDTO, UploadResultDTO } from '@shared/api';
import { sendJSON, uploadFile } from './api';

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

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function extFor(mime: string): string {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mime] ?? 'bin';
}

export function isSingleUrl(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) && !t.includes('\n');
}
