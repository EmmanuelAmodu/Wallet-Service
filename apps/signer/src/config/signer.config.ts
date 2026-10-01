import { registerAs } from '@nestjs/config';
import { required } from '../../../../packages/shared/src/config';
export const signerConfig = registerAs('signer', () => ({
  seedFile: required('SIGNER_SEED_FILE'),
  seedId: required('SIGNER_SEED_ID'),
  ethereumChainId: required('ETH_CHAIN_ID'),
}));
