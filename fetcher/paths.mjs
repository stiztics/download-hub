import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stateRoot = path.join(root, 'fetcher/.state');
export const libraryRoot = path.join(root, 'Anime');
export const now = () => new Date().toISOString();
export function inputError(message) { return Object.assign(new Error(message), { status: 400 }); }
