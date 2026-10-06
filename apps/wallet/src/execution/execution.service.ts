import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CustodyExecution, Prisma, Wallet } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { lock } from '../../../../packages/database/src/locks.js';
import { ChainRpcService } from '../../../../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner, SweepDeferral } from '../../../../packages/chain/src/native-sweep-planner.js';
import { ExchangeEvent, exchangeEventSchema } from '../../../../packages/queue/src/exchange-contracts.js';
import { Message, MessageAuth, QUEUES, canonical } from '../../../../packages/queue/src/messages.js';
import { enqueue, enqueueFanOut } from '../../../../packages/queue/src/outbox.service.js';
import { SignRequest, signSchema } from '../../../../packages/shared/src/contracts.js';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { executionDigest, executionRequestDigest, signExecutionAuthorization, verifySignerAttestation } from '../../../../packages/shared/src/execution-authorization.js';
import { WalletPrismaService } from '../prisma/prisma.service.js';
import { CustodyService } from '../custody/custody.service.js';
import { walletConfig, WalletConfig } from '../config/wallet.config.js';
import { executionConfig, ExecutionSettings } from '../config/execution.config.js';

type Plan = Extract<ExchangeEvent, { type: 'sweep.plan.requested.v1' }>;
type Execute = Extract<ExchangeEvent, { type: 'sweep.execute.requested.v1' }>;
type Result = Extract<Message, { type: 'transaction.custody.signed' | 'transaction.custody.rejected' }>;
const json = (value: unknown) => value as Prisma.InputJsonValue;
function eventId(value: unknown) {
  const hex = executionDigest(value);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

@Injectable()
export class CustodyExecutionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly db: WalletPrismaService,
    private readonly custody: CustodyService,
    private readonly rpc: ChainRpcService,
    @Inject(walletConfig.KEY) private readonly walletConfig: WalletConfig,
    @Inject(executionConfig.KEY) private readonly config: ExecutionSettings,
    private readonly auth: MessageAuth,
  ) {}
  private get planner() { return new NativeSweepPlanner(this.rpc); }
  onModuleInit() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    this.tick();
  }
  private tick() {
    if (!this.running) this.running = this.repairDue().catch(() => undefined).finally(() => { this.running = undefined; });
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }

  async handle(message: Message): Promise<boolean> {
    if (message.type === 'sweep.plan.requested.v1') { await this.plan(message); return true; }
    if (message.type === 'sweep.execute.requested.v1') { await this.execute(message); return true; }
    if (message.type === 'transaction.custody.signed' || message.type === 'transaction.custody.rejected') {
      await this.signed(message); return true;
    }
    if (message.type === 'execution.reconcile') { await this.reconcile(message.transactionId); return true; }
    if (message.type === 'settlement.committed.v1' || message.type === 'settlement.reversed.v1') {
      const execution = await this.db.custodyExecution.findUnique({ where: { operation_id: message.operationId } });
      if (!execution) return false;
      await this.ledgerResult(message, execution); return true;
    }
    if (message.type === 'broadcast.updated') {
      const execution = await this.db.custodyExecution.findUnique({ where: { transaction_id: message.transactionId } });
      if (!execution) return false;
      const binding = message.execution;
      if (!binding || binding.operationId !== execution.operation_id || binding.attemptId !== execution.attempt_id ||
        binding.requestDigest !== execution.request_digest || binding.preparationDigest !== execution.preparation_digest)
        throw new ActionRejectedError('Broadcast result execution binding mismatch');
      await this.db.$transaction(async tx => {
        await lock(tx, `custody-source:${execution.source_wallet_id}`);
        const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: execution.transaction_id } });
        if (transaction.broadcast_generation !== message.generation || transaction.broadcast_revision >= message.revision) return;
        await tx.transaction.update({ where: { id: transaction.id }, data: {
          broadcast_revision: message.revision, broadcast_attempts: message.attempts, last_error: message.lastError,
          ...(message.status === 'submitted' || message.status === 'attention' ? { status: message.status } : {}),
        } });
        const current = await tx.custodyExecution.findUniqueOrThrow({ where: { id: execution.id } });
        if (!current.retired_at && ['queued','submitted','attention'].includes(current.state)) {
          const next = await tx.custodyExecution.update({ where: { id: current.id }, data: {
            ...(message.status === 'submitted' || message.status === 'attention' ? { state: message.status } : {}),
            revision: { increment: 1 }, next_check_at: new Date(), last_error: message.lastError,
          } });
          await this.emitAttempt(tx, next, false);
        }
      });
      await this.reconcile(message.transactionId); return true;
    }
    return false;
  }

  private validatePlan(event: Plan) {
    if (event.domainId !== this.walletConfig.domainId || event.resetEpoch !== this.auth.resetEpoch ||
      event.policyVersion !== 'exchange-financial-v1') throw new ActionRejectedError('Custody execution domain, epoch or policy mismatch');
    const expected = executionDigest({ domainId:event.domainId,resetEpoch:event.resetEpoch,customerId:event.customerId,
      operationId:event.operationId,attemptId:event.attemptId,policyVersion:event.policyVersion,data:event.data });
    if (event.requestDigest !== expected) throw new ActionRejectedError('Sweep planning digest mismatch');
  }
  private async authority(tx: Prisma.TransactionClient, plan: Plan): Promise<{source:Wallet;hot:Wallet}> {
    if (!this.config.enabled || !this.config.authorityPrivateKey || !this.config.signerPublicKey)
      throw new SweepDeferral('disabled', 'Native sweep execution is disabled');
    const source = await tx.wallet.findUnique({ where: { id: plan.data.sourceWalletId } });
    const hot = await tx.wallet.findUnique({ where: { id: plan.data.destinationWalletId } });
    if (!source || !hot || source.custody_role !== 'customer_deposit' || source.account < 10 ||
      source.customer_id !== plan.customerId || source.hot_wallet_id !== hot.id || hot.custody_role !== 'hot' || hot.account !== 0 ||
      source.seed_id !== hot.seed_id || source.chain !== plan.data.asset.chain || source.network !== plan.data.asset.network ||
      hot.chain !== source.chain || hot.network !== source.network || !source.address || !hot.address ||
      !source.published_at || !hot.published_at || source.registry_revision !== plan.data.sourceRegistryRevision ||
      hot.registry_revision !== plan.data.hotRegistryRevision || !await this.custody.publicationAllowed(tx, source) ||
      !await this.custody.publicationAllowed(tx, hot)) throw new SweepDeferral('paused_review', 'Custody source or hot authority is not ready');
    const customer = await tx.exchangeCustomer.findUnique({ where: { customer_id: plan.customerId } });
    const registry = await tx.exchangeWalletRegistry.findUnique({ where: { wallet_id: source.id } });
    const hotRegistry = await tx.exchangeWalletRegistry.findUnique({ where: { wallet_id: hot.id } });
    const asset = await tx.assetConfiguration.findUnique({ where: { domain_id_chain_network_asset_id: {
      domain_id:plan.domainId,chain:source.chain,network:source.network,asset_id:plan.data.asset.assetId,
    } } });
    if (!customer || customer.state !== 'active' || customer.ledger_status !== 'ready' ||
      !registry?.ready || registry.registry_revision !== source.registry_revision || registry.address !== source.address ||
      registry.hot_wallet_id !== hot.id || !registry.start_cursor || registry.ledger_status !== 'ready' || registry.listener_status !== 'ready' ||
      hotRegistry?.ledger_status !== 'ready' || hotRegistry.registry_revision !== hot.registry_revision ||
      hotRegistry.address !== hot.address || !asset?.sweep_enabled)
      throw new SweepDeferral('paused_review', 'Customer, registry coverage or native sweep capability is not enabled');
    if (plan.data.asset.assetId !== `token:${source.chain}:native`) throw new ActionRejectedError('Unsupported sweep asset');
    return { source, hot };
  }
  private output(execution: CustodyExecution, type: string, data: unknown, revision = 1): ExchangeEvent {
    const plan = execution.plan as unknown as Plan;
    return exchangeEventSchema.parse({ ...plan, type, data, eventId:eventId([execution.id,type,revision]),
      revision, occurredAt:execution.created_at.toISOString(), causationId:plan.eventId });
  }
  private async deferred(plan: Plan, code: string, reason: string) {
    const response = exchangeEventSchema.parse({ ...plan, type:'sweep.plan.deferred.v1', eventId:eventId([plan.attemptId,'deferred']),
      causationId:plan.eventId, revision:1, data:{code,reason:reason.slice(0,500),retryAfter:new Date(Date.parse(plan.occurredAt)+this.config.pollIntervalMs).toISOString()} });
    await this.db.$transaction(tx => enqueueFanOut(tx, response, [QUEUES.sweep]));
  }
  private async plan(plan: Plan) {
    this.validatePlan(plan);
    let execution: CustodyExecution;
    try {
      execution = await this.db.$transaction(async tx => {
        await lock(tx, `custody-source:${plan.data.sourceWalletId}`);
        const previous = await tx.custodyExecution.findUnique({ where: { operation_id:plan.operationId } });
        if (previous) {
          if (previous.attempt_id !== plan.attemptId || previous.request_digest !== plan.requestDigest ||
            canonical((previous.plan as unknown as Plan).data) !== canonical(plan.data)) throw new ActionRejectedError('Sweep operation identity changed');
          return previous;
        }
        const { source } = await this.authority(tx, plan);
        if (await tx.custodyExecution.findFirst({ where: { source_wallet_id:source.id,retired_at:null } }) ||
          await tx.transaction.findFirst({ where: { wallet_id:source.id,status:{in:['preparing','signing','signed','queued','broadcasting','submitted','attention']} } }))
          throw new SweepDeferral('waiting_resources','Source execution slot is retained by another attempt');
        await tx.transaction.create({ data:{id:plan.attemptId,wallet_id:source.id,idempotency_key:`custody:${plan.attemptId}`,
          request_hash:plan.requestDigest,intent:json(plan.data),status:'preparing'} });
        return tx.custodyExecution.create({ data:{id:plan.attemptId,operation_id:plan.operationId,attempt_id:plan.attemptId,
          transaction_id:plan.attemptId,domain_id:plan.domainId,reset_epoch:plan.resetEpoch,customer_id:plan.customerId,
          source_wallet_id:source.id,hot_wallet_id:plan.data.destinationWalletId,request_digest:plan.requestDigest,plan:json(plan),state:'planning'} });
      });
    } catch(error) {
      if (error instanceof SweepDeferral) { await this.deferred(plan,error.code,error.message); return; }
      throw error;
    }
    if (execution.state === 'planning') await this.prepare(execution);
  }
  private async prepare(execution: CustodyExecution) {
    const plan = execution.plan as unknown as Plan;
    try {
      const wallets = await this.db.$transaction(tx => this.authority(tx,plan));
      const prepared = await this.planner.plan({ chain:plan.data.asset.chain,network:plan.data.asset.network,
        sourceAddress:wallets.source.address!,hotAddress:wallets.hot.address! });
      const request = signSchema.parse({wallet:{chain:plan.data.asset.chain,network:plan.data.asset.network,seedId:wallets.source.seed_id,
        account:wallets.source.account,address:wallets.source.address},transaction:prepared.request});
      await this.db.$transaction(async tx => {
        await lock(tx, `custody-source:${execution.source_wallet_id}`);
        const current = await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
        if(current.state !== 'planning') return;
        await this.authority(tx,plan);
        const keys = prepared.resourceKeys.map(key=>`${plan.domainId}:${plan.resetEpoch}:${plan.data.asset.chain}:${plan.data.asset.network}:${key}`).sort();
        for(const key of keys) {
          await lock(tx,`execution-resource:${key}`);
          if(await tx.executionResourceClaim.findFirst({where:{resource_key:key,active:true}})) throw new SweepDeferral('waiting_resources','Canonical resource is reserved by another attempt');
        }
        for(const key of keys) await tx.executionResourceClaim.create({data:{id:randomUUID(),resource_key:key,execution_id:current.id}});
        const updated = await tx.custodyExecution.update({where:{id:current.id},data:{state:'prepared',prepared_request:json(request),
          preparation_digest:executionRequestDigest(request),principal_units:prepared.amount,maximum_fee_units:prepared.maxFeeUnits,
          expires_at:new Date(prepared.expiresAt),next_check_at:new Date(prepared.expiresAt)}});
        await tx.transaction.update({where:{id:current.transaction_id},data:{prepared:json(request.transaction)}});
        await enqueueFanOut(tx,this.output(updated,'sweep.plan.prepared.v1',{sourceWalletId:current.source_wallet_id,destinationWalletId:current.hot_wallet_id,
          amount:{asset:plan.data.asset,amount:prepared.amount},preparationDigest:updated.preparation_digest,maxFeeUnits:prepared.maxFeeUnits,expiresAt:prepared.expiresAt}),[QUEUES.sweep]);
      });
    } catch(error) {
      if(error instanceof ActionRejectedError) throw error;
      await this.unsignedFailure(execution,error instanceof SweepDeferral?error.code:'preparation_failed',
        error instanceof SweepDeferral?error.message:'Canonical resource preparation failed; retry from a fresh plan');
    }
  }
  private async unsignedFailure(execution: CustodyExecution, code:string, reason:string) {
    await this.db.$transaction(async tx=>{
      await lock(tx,`custody-source:${execution.source_wallet_id}`);
      const current=await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
      if(!['planning','prepared'].includes(current.state) || current.authorization) return;
      await tx.custodyExecution.update({where:{id:current.id},data:{state:'deferred',retired_at:new Date(),last_error:reason,next_check_at:new Date(Date.now()+this.config.pollIntervalMs)}});
      await tx.transaction.update({where:{id:current.transaction_id},data:{status:'rejected',last_error:reason}});
      await tx.executionResourceClaim.updateMany({where:{execution_id:current.id,active:true},data:{active:false,released_at:new Date()}});
      const plan=current.plan as unknown as Plan;
      const response=exchangeEventSchema.parse({...plan,type:'sweep.plan.deferred.v1',eventId:eventId([plan.attemptId,'deferred']),causationId:plan.eventId,
        revision:1,data:{code,reason:reason.slice(0,500),retryAfter:new Date(Date.parse(plan.occurredAt)+this.config.pollIntervalMs).toISOString()}});
      await enqueueFanOut(tx,response,[QUEUES.sweep]);
    });
  }
  private async validateResources(request: SignRequest, fee: string) {
    const chain=request.wallet.chain;
    await this.rpc.verifyNetwork(chain);
    if(request.transaction.chain==='ethereum') {
      const [nonce,balance]=await Promise.all([this.rpc.call(chain,'eth_getTransactionCount',[request.wallet.address,'pending']),this.rpc.call(chain,'eth_getBalance',[request.wallet.address,'pending'])]);
      if(BigInt(String(nonce))!==BigInt(request.transaction.nonce) || BigInt(String(balance))<BigInt(request.transaction.amount)+BigInt(fee))
        throw new SweepDeferral('waiting_funds','Nonce or available source balance changed before signing');
    } else if(request.transaction.chain==='bitcoin') {
      for(const input of request.transaction.utxos) {
        const value=await this.rpc.call('bitcoin','gettxout',[input.txid,input.vout,true]) as {confirmations?:number;coinbase?:boolean;scriptPubKey?:{hex?:string;address?:string}} | null;
        if(!value || (value.confirmations??0)<6 || (value.coinbase && (value.confirmations??0)<100) || value.scriptPubKey?.hex!==input.script || value.scriptPubKey?.address!==request.wallet.address)
          throw new SweepDeferral('waiting_resources','Reserved Bitcoin input is spent, immature or no longer canonical');
      }
    } else if(request.transaction.chain==='solana') {
      const [height,balance]=await Promise.all([this.rpc.call('solana','getBlockHeight',[{commitment:'finalized'}]),this.rpc.call('solana','getBalance',[request.wallet.address,{commitment:'finalized'}])]);
      const amount=request.transaction.outputs.reduce((n,o)=>n+BigInt(o.amount),0n);
      if(Number(height)>request.transaction.lastValidBlockHeight || BigInt(String((balance as {value:number}).value))<amount+BigInt(fee))
        throw new SweepDeferral('waiting_funds','Solana resources or blockhash changed before signing');
    } else throw new ActionRejectedError('Unsupported custody adapter');
  }
  private async execute(event: Execute) {
    const execution=await this.db.custodyExecution.findUnique({where:{operation_id:event.operationId}});
    if(!execution) throw new Error('Prepared sweep has not arrived');
    this.checkIdentity(execution,event);
    const plan=execution.plan as unknown as Plan;
    if(event.data.sourceWalletId!==execution.source_wallet_id || event.data.destinationWalletId!==execution.hot_wallet_id ||
      event.data.amount.amount!==execution.principal_units || canonical(event.data.amount.asset)!==canonical(plan.data.asset) ||
      event.data.preparationDigest!==execution.preparation_digest || event.policyVersion!==plan.policyVersion)
      throw new ActionRejectedError('Sweep execution differs from reserved preparation');
    if(execution.state!=='prepared') return;
    const request=signSchema.parse(execution.prepared_request);
    try {
      if(!execution.expires_at || execution.expires_at.getTime()<=Date.now()) throw new SweepDeferral('preparation_expired','Unsigned preparation expired');
      await this.validateResources(request,execution.maximum_fee_units!);
      await this.db.$transaction(async tx=>{
        await lock(tx,`custody-source:${execution.source_wallet_id}`);
        const current=await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
        if(current.state!=='prepared') return;
        const {source,hot}=await this.authority(tx,plan);
        if(current.expires_at!.getTime()<=Date.now()) throw new SweepDeferral('preparation_expired','Unsigned preparation expired');
        const authorization=signExecutionAuthorization({version:1,purpose:'native_sweep',domainId:plan.domainId,resetEpoch:plan.resetEpoch,
          seedId:source.seed_id,customerId:plan.customerId,source:{walletId:source.id,role:'customer_deposit',account:source.account,path:source.path,address:source.address!,registryRevision:source.registry_revision},
          target:{walletId:hot.id,role:'hot',account:0,path:hot.path,address:hot.address!,seedId:hot.seed_id,domainId:plan.domainId,registryRevision:hot.registry_revision},
          asset:plan.data.asset,policyVersion:'exchange-financial-v1',operationId:current.operation_id,attemptId:current.attempt_id,
          requestDigest:current.request_digest,preparationDigest:current.preparation_digest!,principalUnits:current.principal_units!,maxFeeUnits:current.maximum_fee_units!,
          expiresAt:current.expires_at!.toISOString(),requestHash:executionRequestDigest(request)},this.config.authorityPrivateKey!);
        const updated=await tx.custodyExecution.update({where:{id:current.id},data:{state:'signing',authorization:json(authorization),revision:{increment:1},next_check_at:new Date(Date.now()+this.config.pollIntervalMs)}});
        await tx.transaction.update({where:{id:current.transaction_id},data:{status:'signing'}});
        await enqueue(tx,QUEUES.signer,{type:'transaction.custody.sign',transactionId:current.transaction_id,operationId:current.operation_id,attemptId:current.attempt_id,
          requestDigest:current.request_digest,preparationDigest:current.preparation_digest!,request,authorization},`custody-sign:${current.attempt_id}`);
        await this.emitAttempt(tx,updated,false);
      });
    } catch(error) {
      if(error instanceof SweepDeferral) { await this.unsignedFailure(execution,error.code,error.message); return; }
      throw error;
    }
  }
  private checkIdentity(execution:CustodyExecution,event:{domainId:string;resetEpoch:string;attemptId:string;requestDigest:string;customerId?:string}) {
    if(execution.domain_id!==event.domainId || execution.reset_epoch!==event.resetEpoch || event.resetEpoch!==this.auth.resetEpoch ||
      execution.attempt_id!==event.attemptId || execution.request_digest!==event.requestDigest || (event.customerId && execution.customer_id!==event.customerId))
      throw new ActionRejectedError('Execution result identity mismatch');
  }
  private async emitAttempt(tx:Prisma.TransactionClient,execution:CustodyExecution,terminalSafe:boolean) {
    const transaction=await tx.transaction.findUniqueOrThrow({where:{id:execution.transaction_id}});
    await enqueueFanOut(tx,this.output(execution,'execution.attempt.updated.v1',{state:execution.state,
      ...(transaction.tx_hash?{transactionHash:transaction.tx_hash}:{}),...(execution.last_error?{reason:execution.last_error}:{}),terminalSafe},execution.revision),[QUEUES.ledger,QUEUES.activity,QUEUES.sweep]);
  }
  private async signed(result:Result) {
    if(!this.config.signerPublicKey) throw new ActionRejectedError('Signer attestation verifier is unavailable');
    const {signerAttestation,...body}=result;
    let claims;
    try { claims=verifySignerAttestation(signerAttestation,body,this.config.signerPublicKey); }
    catch { throw new ActionRejectedError('Invalid independent Signer result attestation'); }
    const execution=await this.db.custodyExecution.findUnique({where:{transaction_id:result.transactionId}});
    if(!execution) throw new ActionRejectedError('Execution attempt not found');
    this.checkIdentity(execution,claims);
    if(claims.transactionId!==execution.transaction_id || result.operationId!==execution.operation_id || result.attemptId!==execution.attempt_id ||
      result.requestDigest!==execution.request_digest || result.preparationDigest!==execution.preparation_digest || claims.preparationDigest!==execution.preparation_digest ||
      claims.status!==(result.type==='transaction.custody.signed'?'signed':'rejected')) throw new ActionRejectedError('Signer result preparation binding mismatch');
    await this.db.$transaction(async tx=>{
      await lock(tx,`custody-source:${execution.source_wallet_id}`);
      const current=await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
      const transaction=await tx.transaction.findUniqueOrThrow({where:{id:execution.transaction_id}});
      if(current.state!=='signing') {
        if(result.type==='transaction.custody.signed' && transaction.signed && canonical(transaction.signed)!==canonical(result.signed))
          throw new ActionRejectedError('Signed custody bytes are immutable');
        return;
      }
      if(result.type==='transaction.custody.rejected') {
        const updated=await tx.custodyExecution.update({where:{id:current.id},data:{state:'failed',revision:{increment:1},retired_at:new Date(),last_error:'Trusted Signer rejected unsigned execution'}});
        await tx.transaction.update({where:{id:transaction.id},data:{status:'rejected',last_error:updated.last_error}});
        await tx.executionResourceClaim.updateMany({where:{execution_id:current.id,active:true},data:{active:false,released_at:new Date()}});
        await this.emitAttempt(tx,updated,true); return;
      }
      const request=signSchema.parse(current.prepared_request);
      let ready=true;
      try { await this.authority(tx,current.plan as unknown as Plan); } catch { ready=false; }
      const updated=await tx.custodyExecution.update({where:{id:current.id},data:{state:ready?'queued':'attention',revision:{increment:1},
        next_check_at:new Date(),last_error:ready?null:'Custody policy paused after signing; bytes and source fence retained'}});
      await tx.transaction.update({where:{id:transaction.id},data:{status:ready?'queued':'attention',signed:json(result.signed),tx_hash:result.signed.txHash,broadcast_generation:1}});
      if(ready) await enqueue(tx,QUEUES.broadcast,{type:'broadcast.requested',transactionId:transaction.id,generation:1,snapshot:{chain:request.wallet.chain,
        network:request.wallet.network!,signed:result.signed,...(request.transaction.chain==='solana'?{lastValidBlockHeight:request.transaction.lastValidBlockHeight}:{}),
        execution:{domainId:current.domain_id,resetEpoch:current.reset_epoch,operationId:current.operation_id,attemptId:current.attempt_id,requestDigest:current.request_digest,
          preparationDigest:current.preparation_digest!,preparedRequest:request,signerAttestation}}},`custody-broadcast:${current.attempt_id}`);
      await this.emitAttempt(tx,updated,false);
    });
  }
  private async ledgerResult(event:Extract<ExchangeEvent,{type:'settlement.committed.v1'|'settlement.reversed.v1'}>,execution:CustodyExecution) {
    this.checkIdentity(execution,event);
    await this.db.$transaction(async tx=>{
      await lock(tx,`custody-source:${execution.source_wallet_id}`);
      const current=await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
      if(event.revision<=current.ledger_ack_revision) return;
      if(event.type==='settlement.committed.v1') {
        const transaction=await tx.transaction.findUniqueOrThrow({where:{id:current.transaction_id}});
        if(event.data.transactionHash!==transaction.tx_hash || event.revision!==current.settlement_revision || current.reversed)
          throw new ActionRejectedError('Ledger settlement does not match canonical execution');
        await tx.custodyExecution.update({where:{id:current.id},data:{ledger_ack_revision:event.revision,ledger_batch_id:event.data.ledgerBatchId,next_check_at:new Date()}});
      } else {
        await tx.custodyExecution.update({where:{id:current.id},data:{ledger_ack_revision:event.revision,ledger_batch_id:event.data.ledgerBatchId,next_check_at:new Date(),last_error:'Custody settlement reversed; reconciliation required'}});
      }
    });
    await this.reconcile(execution.transaction_id);
  }
  async reconcile(transactionId:string) {
    const execution=await this.db.custodyExecution.findUnique({where:{transaction_id:transactionId}});
    if(!execution || execution.reset_epoch!==this.auth.resetEpoch || execution.domain_id!==this.walletConfig.domainId || !this.config.enabled) return;
    if(execution.state==='planning') { await this.prepare(execution); return; }
    if(execution.state==='prepared') {
      if(execution.expires_at && execution.expires_at.getTime()<=Date.now()) await this.unsignedFailure(execution,'preparation_expired','Unsigned preparation expired');
      return;
    }
    const transaction=await this.db.transaction.findUniqueOrThrow({where:{id:transactionId}});
    if(!transaction.signed || !execution.prepared_request) {
      await this.db.custodyExecution.update({where:{id:execution.id},data:{next_check_at:new Date(Date.now()+this.config.pollIntervalMs)}}); return;
    }
    let observation;
    try { observation=await this.planner.observe({chain:transaction.wallet_id?signSchema.parse(execution.prepared_request).wallet.chain as 'ethereum'|'bitcoin'|'solana':'ethereum',
      network:signSchema.parse(execution.prepared_request).wallet.network!,hash:transaction.tx_hash!,request:signSchema.parse(execution.prepared_request),
      signed:transaction.signed as never,...(execution.inclusion?{priorInclusion:execution.inclusion as {blockHash:string;blockHeight:string}}:{})}); }
    catch {
      await this.db.custodyExecution.update({where:{id:execution.id},data:{next_check_at:new Date(Date.now()+this.config.pollIntervalMs),last_error:'RPC evidence unavailable; prior inclusion and resources retained'}}); return;
    }
    await this.db.$transaction(async tx=>{
      await lock(tx,`custody-source:${execution.source_wallet_id}`);
      const current=await tx.custodyExecution.findUniqueOrThrow({where:{id:execution.id}});
      await tx.custodyExecution.update({where:{id:current.id},data:{next_check_at:new Date(Date.now()+this.config.pollIntervalMs)}});
      if(observation.state==='pending') return;
      if(observation.state==='reverted') {
        if(current.reversed) return;
        const other=await tx.custodyExecution.findFirst({where:{source_wallet_id:current.source_wallet_id,retired_at:null,id:{not:current.id}}});
        const updated=await tx.custodyExecution.update({where:{id:current.id},data:{state:'attention',reversed:true,
          ...(!other?{retired_at:null}:{}),revision:{increment:1},settlement_revision:{increment:1},last_error:'Canonical inclusion orphaned; source retained for reconciliation'}});
        if(!other) {
          await tx.transaction.update({where:{id:transactionId},data:{status:'attention'}});
          const claims=await tx.executionResourceClaim.findMany({where:{execution_id:current.id}});
          for(const claim of claims) {
            if(!await tx.executionResourceClaim.findFirst({where:{resource_key:claim.resource_key,active:true,id:{not:claim.id}}}))
              await tx.executionResourceClaim.update({where:{id:claim.id},data:{active:true,released_at:null}});
          }
        }
        await tx.custodyDomain.update({where:{id:current.domain_id},data:{status:'paused'}});
        if(current.settlement_revision>0) await enqueueFanOut(tx,this.output(updated,'settlement.reverted.v1',{
          priorSettlementRevision:current.settlement_revision,reason:updated.last_error},updated.settlement_revision),[QUEUES.ledger]);
        await this.emitAttempt(tx,updated,false); return;
      }
      if(!observation.blockHash || !observation.blockHeight || observation.actualFeeUnits===undefined) return;
      const inclusion={blockHash:observation.blockHash,blockHeight:observation.blockHeight,feeUnits:observation.actualFeeUnits,outcome:observation.state};
      const changed=current.reversed || !current.inclusion || canonical(current.inclusion)!==canonical(inclusion);
      let updated=current;
      if(changed) {
        updated=await tx.custodyExecution.update({where:{id:current.id},data:{state:observation.state,revision:{increment:1},
          settlement_revision:{increment:1},inclusion:json(inclusion),reversed:false,last_error:null}});
        await tx.transaction.update({where:{id:transactionId},data:{status:observation.state}});
        const plan=current.plan as unknown as Plan;
        await this.emitAttempt(tx,updated,false);
        await enqueueFanOut(tx,this.output(updated,'settlement.requested.v1',{transactionHash:transaction.tx_hash,
          actualFees:BigInt(observation.actualFeeUnits)>0n?[{asset:plan.data.asset,amount:observation.actualFeeUnits}]:[],
          outcome:observation.state==='confirmed'?'confirmed':'failed'},updated.settlement_revision),[QUEUES.ledger]);
      }
      if(updated.ledger_ack_revision===updated.settlement_revision && updated.ledger_ack_revision>0 && !updated.reversed && !updated.retired_at) {
        const retired=await tx.custodyExecution.update({where:{id:updated.id},data:{retired_at:new Date(),revision:{increment:1}}});
        await tx.executionResourceClaim.updateMany({where:{execution_id:updated.id,active:true},data:{active:false,released_at:new Date()}});
        await this.emitAttempt(tx,retired,true);
      }
    });
  }
  async repairDue() {
    if(!this.config.enabled) return;
    const due=await this.db.custodyExecution.findMany({where:{next_check_at:{lte:new Date()},state:{notIn:['deferred']}},orderBy:[{next_check_at:'asc'},{id:'asc'}],take:40});
    for(const execution of due) {
      try { await this.reconcile(execution.transaction_id); }
      catch { await this.db.custodyExecution.update({where:{id:execution.id},data:{next_check_at:new Date(Date.now()+this.config.pollIntervalMs),last_error:'Execution reconciliation failed; resources retained'}}); }
    }
  }
}
