import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { TokenPlanner } from '../../../../packages/chain/src/token-planner.js';
import { tokenCertificateSchema, tokenAsset } from '../../../../packages/shared/src/token-contracts.js';
import { canonical, MessageAuth, QUEUES } from '../../../../packages/queue/src/messages.js';
import { exchangeEventSchema } from '../../../../packages/queue/src/exchange-contracts.js';
import { enqueue } from '../../../../packages/queue/src/outbox.service.js';
import { lock } from '../../../../packages/database/src/locks.js';
import { executionConfig, ExecutionSettings } from '../config/execution.config.js';
import { exchangeApiConfig } from '../config/exchange-api.config.js';

export const tokenAssetConfigurationSchema = z.object({
 certificate:tokenCertificateSchema,configurationRevision:z.number().int().positive(),symbol:z.string().min(1).max(24),name:z.string().min(1).max(128),
 observationEnabled:z.boolean().default(false),creditEnabled:z.boolean().default(false),sweepEnabled:z.boolean().default(false),withdrawalEnabled:z.boolean().default(false),
}).strict().superRefine((r,ctx)=>{if((r.creditEnabled&&!r.observationEnabled)||(r.sweepEnabled&&!r.creditEnabled))ctx.addIssue({code:'custom',message:'Credit requires observation and sweeping requires credit'});});

/** A transfer-semantic certificate never permits general contract interaction. */
@Injectable()
export class TokenAssetsService {
 constructor(private readonly db:WalletPrismaService,private readonly rpc:ChainRpcService,private readonly auth:MessageAuth,
  @Inject(exchangeApiConfig.KEY) private readonly config:{domainId:string}, @Inject(executionConfig.KEY) private readonly execution:ExecutionSettings) {}
 async configure(input:z.infer<typeof tokenAssetConfigurationSchema>) {
  const data=tokenAssetConfigurationSchema.parse(input),asset=tokenAsset(data.certificate);
  if((data.creditEnabled||data.sweepEnabled||data.withdrawalEnabled)&&!this.execution.tokensEnabled)throw new ConflictException('Token execution is disabled');
  await new TokenPlanner(this.rpc).validateCertificate(data.certificate);
  return this.db.$transaction(async tx=>{
   await lock(tx,`token-configuration:${this.config.domainId}:${asset.assetId}`);
   const domain=await tx.custodyDomain.findUniqueOrThrow({where:{id:this.config.domainId}});
   if(domain.reset_epoch!==this.auth.resetEpoch||domain.status!=='active')throw new ConflictException('Custody domain is not active');
   const key={domain_id:this.config.domainId,chain:asset.chain,network:asset.network,asset_id:asset.assetId};
   const existing=await tx.assetConfiguration.findUnique({where:{domain_id_chain_network_asset_id:key}});
   if(existing&&(canonical(existing.transfer_certificate)!==canonical(data.certificate)||existing.symbol!==data.symbol||existing.name!==data.name))throw new ConflictException('Certified asset identity is immutable');
   if(existing&&data.configurationRevision<existing.configuration_revision)throw new ConflictException('Asset revision cannot regress');
   const flags={observation_enabled:data.observationEnabled,credit_enabled:data.creditEnabled,sweep_enabled:data.sweepEnabled,withdrawal_enabled:data.withdrawalEnabled,configuration_revision:data.configurationRevision};
   if(existing&&data.configurationRevision===existing.configuration_revision&&Object.entries(flags).some(([k,v])=>existing[k as keyof typeof existing]!==v))throw new ConflictException('Asset revision cannot be reused with different flags');
   await tx.assetConfiguration.upsert({where:{domain_id_chain_network_asset_id:key},update:flags,create:{...key,...flags,standard:data.certificate.standard,decimals:data.certificate.decimals,symbol:data.symbol,name:data.name,
    contract_address:data.certificate.standard==='erc20'?data.certificate.contract:null,mint:data.certificate.standard==='spl'?data.certificate.mint:null,token_program:data.certificate.standard==='spl'?data.certificate.programId:null,
    transfer_certificate:data.certificate,minimum_credit_units:'1',minimum_sweep_units:'1',maximum_fee_units:asset.chain==='ethereum'?'5000000000000000':'100000',policy_version:'exchange-financial-v1'}});
   const event=exchangeEventSchema.parse({eventId:randomUUID(),schemaVersion:1,resetEpoch:this.auth.resetEpoch,occurredAt:new Date().toISOString(),domainId:this.config.domainId,correlationId:randomUUID(),causationId:null,aggregateId:asset.assetId,revision:data.configurationRevision,
    type:'asset.transfer.registry.requested.v1',data:{certificate:data.certificate,configurationRevision:data.configurationRevision,observationEnabled:data.observationEnabled,creditEnabled:data.creditEnabled}});
   await enqueue(tx,QUEUES.activity,event,`token-asset:${this.config.domainId}:${this.auth.resetEpoch}:${asset.assetId}:${data.configurationRevision}`);
   return {asset,configurationRevision:data.configurationRevision,certificate:data.certificate,flags,status:'awaiting_token_watch_coverage'};
  });
 }
}
