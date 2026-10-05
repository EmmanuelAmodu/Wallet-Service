ALTER TABLE exchange_discoveries
  ADD COLUMN finalized_block_hash TEXT,
  ADD COLUMN finalized_block_height TEXT;

-- Transfer evidence takes precedence over the latest discovery, which older code could
-- replace with a pending block while the transfer still held the original credit.
WITH accepted AS (
  SELECT reset_epoch, chain, network, transaction_hash,
    max(block_hash) AS block_hash, max(block_height) AS block_height
  FROM exchange_transfers
  WHERE state = 'finalized' AND block_hash IS NOT NULL AND block_height IS NOT NULL
  GROUP BY reset_epoch, chain, network, transaction_hash
  HAVING count(DISTINCT (block_hash, block_height)) = 1
)
UPDATE exchange_discoveries AS discovery
SET finalized_block_hash = accepted.block_hash,
    finalized_block_height = accepted.block_height
FROM accepted
WHERE discovery.reset_epoch = accepted.reset_epoch AND discovery.chain = accepted.chain
  AND discovery.network = accepted.network AND discovery.transaction_hash = accepted.transaction_hash;

-- Failed finalized transactions can also carry financially accepted custody fee losses.
UPDATE exchange_discoveries
SET finalized_block_hash = block_hash, finalized_block_height = block_height
WHERE state IN ('finalized', 'failed') AND finalized_block_hash IS NULL
  AND block_hash IS NOT NULL AND block_height IS NOT NULL;

ALTER TABLE exchange_discoveries ADD CONSTRAINT exchange_discovery_finalized_inclusion
  CHECK ((finalized_block_hash IS NULL) = (finalized_block_height IS NULL));
