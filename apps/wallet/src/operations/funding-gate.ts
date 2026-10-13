import { Prisma } from '@prisma/client';
import { lock } from '../../../../packages/database/src/locks.js';
import { SweepDeferral } from '../../../../packages/chain/src/native-sweep-planner.js';
export async function assertManagementFundingEnabled(
  tx: Prisma.TransactionClient,
  domainId: string,
  epoch: string,
) {
  await lock(tx, `management-funding:${domainId}:${epoch}`);
  const gate = await tx.operationsFundingGate.findUnique({
    where: { domain_id_reset_epoch: { domain_id: domainId, reset_epoch: epoch } },
  });
  if (gate && !gate.enabled)
    throw new SweepDeferral(
      'paused_review',
      'Management funding and fee sponsorship are paused by operations',
    );
}
