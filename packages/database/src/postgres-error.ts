// Prisma's pg adapter nests SQLSTATE under driverAdapterError, while older
// clients expose it directly on meta. Keep service error handling version-neutral.
export function postgresErrorCode(error: unknown): string | undefined {
  const value = error as
    | {
        meta?: {
          code?: string;
          driverAdapterError?: {
            cause?: { originalCode?: string; code?: string };
          };
        };
      }
    | undefined;
  return (
    value?.meta?.code ??
    value?.meta?.driverAdapterError?.cause?.originalCode ??
    value?.meta?.driverAdapterError?.cause?.code
  );
}
