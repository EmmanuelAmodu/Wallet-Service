import { createHash, timingSafeEqual } from 'node:crypto';
export function token(value: string): string {
  if (value.length < 32) throw new Error('Authentication tokens must be at least 32 characters');
  return value;
}
export function matches(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
