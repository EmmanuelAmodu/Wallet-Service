import { z } from 'zod';
import { walletRequest } from '../../../../../packages/shared/src/contracts.js';
export const createWalletSchema = walletRequest;
export type CreateWalletDto = z.infer<typeof createWalletSchema>;
