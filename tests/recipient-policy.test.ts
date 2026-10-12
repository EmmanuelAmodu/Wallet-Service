import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SigningCore } from '../apps/signer/src/signing/signing.core.js';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { NativeSweepPlanner } from '../packages/chain/src/native-sweep-planner.js';
import {
  assertEvmExternalAddress,
  assertSolanaExternalAddress,
} from '../packages/chain/src/recipient-policy.js';
import { associatedTokenAddress } from '../packages/chain/src/token-encoding.js';
import { SOLANA_DEVNET, CLASSIC_TOKEN_PROGRAM } from '../packages/shared/src/token-contracts.js';
import { Chain, SignRequest } from '../packages/shared/src/contracts.js';
let core: SigningCore;
before(async () => {
  core = await SigningCore.create(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    'recipient-policy',
    '11155111',
    undefined,
    {
      domainId: 'exchange',
      chainNetworks: {
        ethereum: { network: '11155111', chainId: '11155111' },
        solana: { network: SOLANA_DEVNET, genesisHash: SOLANA_DEVNET },
      },
    },
  );
});
after(() => core.close());

function wallet(chain: 'ethereum' | 'solana', account: number) {
  const { path: _path, ...w } = core.derive({ chain, account, seedId: core.seedId });
  return { ...w, network: chain === 'ethereum' ? '11155111' : SOLANA_DEVNET };
}

class Rpc extends ChainRpcService {
  code = '0x';
  program = '11111111111111111111111111111111';
  readonly calls: string[] = [];
  constructor() {
    super({ ethereumChainId: '11155111', solanaGenesisHash: SOLANA_DEVNET });
  }

  override async call(_chain: Chain, method: string, params: unknown[]): Promise<unknown> {
    this.calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7';
      case 'getGenesisHash':
        return SOLANA_DEVNET;
      case 'eth_getCode':
        return this.code;
      case 'eth_getBalance':
        return '0xde0b6b3a7640000';
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_estimateGas':
        return '0x5208';
      case 'getAccountInfo':
        return {
          context: { slot: 100 },
          value: {
            owner: this.program,
            executable: false,
            lamports: 100000000,
            data: ['', 'base64'],
          },
        };
      case 'simulateTransaction':
        assert.equal((params[1] as { sigVerify: boolean }).sigVerify, true);
        return { value: { err: null } };
      default:
        throw new Error('Unexpected RPC ' + method);
    }
  }
}

test('EOA syntax rejects zero/precompile addresses and Solana off-curve program-derived owners', async () => {
  for (const address of [
    '0x' + '00'.repeat(20),
    '0x' + '00'.repeat(19) + '01',
    '0x' + '00'.repeat(18) + 'ffff',
  ])
    assert.throws(() => assertEvmExternalAddress(address), /external wallet/);
  const owner = wallet('solana', 11).address,
    mint = wallet('solana', 8).address;
  await assertSolanaExternalAddress(owner);
  await assert.rejects(
    assertSolanaExternalAddress(await associatedTokenAddress(owner, mint)),
    /on-curve/,
  );
  await assert.rejects(assertSolanaExternalAddress('11111111111111111111111111111111'), /on-curve/);
});

test('native Ethereum hot0 withdrawals reject deployed/delegated recipients at preparation and revalidation', async () => {
  const rpc = new Rpc(),
    planner = new NativeSweepPlanner(rpc),
    source = wallet('ethereum', 0),
    recipient = wallet('ethereum', 11);
  const input = {
    chain: 'ethereum' as const,
    network: '11155111',
    sourceAddress: source.address.toLowerCase(),
    hotAddress: recipient.address.toLowerCase(),
    amount: '10000',
  };
  const plan = await planner.plan(input);
  const request: SignRequest = { wallet: source, transaction: plan.request };
  for (const code of ['0x6000', '0xef0100' + '12'.repeat(20)]) {
    rpc.code = code;
    await assert.rejects(planner.plan(input), /no contract or delegated code/);
    await assert.rejects(
      planner.revalidate(request, plan.maxFeeUnits),
      /no contract or delegated code/,
    );
  }
});

test('native Ethereum dispatch preflight rejects a recipient that becomes a contract after signing', async () => {
  const source = wallet('ethereum', 0),
    recipient = wallet('ethereum', 11),
    rpc = new Rpc();
  const request: SignRequest = {
    wallet: source,
    transaction: {
      chain: 'ethereum',
      chainId: '11155111',
      nonce: '7',
      to: recipient.address,
      amount: '10000',
      gasLimit: '21000',
      maxFeePerGas: '3000000000',
      maxPriorityFeePerGas: '1000000000',
    },
  };
  const signed = core.sign(request);
  await rpc.preflight('ethereum', signed);
  rpc.code = '0x6000';
  await assert.rejects(rpc.preflight('ethereum', signed), /contract or delegated code/);
});

test('native Solana dispatch preflight rejects on-curve wallet reassigned to a program', async () => {
  const source = wallet('solana', 0),
    recipient = wallet('solana', 11),
    rpc = new Rpc();
  const request: SignRequest = {
    wallet: source,
    transaction: {
      chain: 'solana',
      outputs: [{ address: recipient.address, amount: '1000000' }],
      recentBlockhash: wallet('solana', 9).address,
      lastValidBlockHeight: 1000,
    },
  };
  const signed = core.sign(request);
  await rpc.preflight('solana', signed);
  const simulations = rpc.calls.filter((method) => method === 'simulateTransaction').length;
  rpc.program = CLASSIC_TOKEN_PROGRAM;
  await assert.rejects(rpc.preflight('solana', signed), /ordinary System account/);
  assert.equal(rpc.calls.filter((method) => method === 'simulateTransaction').length, simulations);
});
