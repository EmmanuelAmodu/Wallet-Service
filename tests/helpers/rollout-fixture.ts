import { RolloutSettings } from '../../packages/shared/src/rollout.config.js';
// Explicitly enable the isolated fixture environment; production configuration defaults closed.
export const acceptanceRollout: RolloutSettings = {
  mode: 'full',
  addresses: true,
  credits: true,
  sweeps: true,
  withdrawals: true,
};
