import { z } from 'zod';
import { transferSchema } from '../../../../../packages/shared/src/contracts.js';
export const createTransactionSchema = transferSchema;
export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;
export const idempotencyKeySchema = z.string().min(1).max(128);
