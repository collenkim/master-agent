import { resolve } from 'node:path';

export function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
