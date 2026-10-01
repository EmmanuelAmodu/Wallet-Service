interface LockDatabase {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export async function lock(db: LockDatabase, key: string) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export async function lockTransaction(db: LockDatabase, id: string) {
  await db.$queryRaw`SELECT id FROM transactions WHERE id=${id}::uuid FOR UPDATE`;
}
