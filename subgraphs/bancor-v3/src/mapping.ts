import {
  Address,
  BigDecimal,
  BigInt,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import {
  PoolCollectionAdded,
  TokensTraded,
} from "../generated/BancorNetwork/BancorNetwork";
import {
  NetworkFeePPMUpdated,
  WithdrawalFeePPMUpdated,
} from "../generated/NetworkSettings/NetworkSettings";
import { ProgramCreated } from "../generated/StandardRewards/StandardRewards";
import { PoolTokenCreated } from "../generated/PoolTokenFactory/PoolTokenFactory";
import {
  TokensDeposited,
  TokensWithdrawn,
  TotalLiquidityUpdated,
} from "../generated/templates/PoolCollection/PoolCollection";
import { PoolCollection } from "../generated/templates";
import {
  TokensDeposited as BNTDeposited,
  TokensWithdrawn as BNTWithdrawn,
  TotalLiquidityUpdated as BNTTotalLiquidityUpdated,
} from "../generated/BNTPool/BNTPool";
import { PoolToken } from "../generated/BancorNetwork/PoolToken";
import { BancorNetworkInfo } from "../generated/BancorNetwork/BancorNetworkInfo";
import { ERC20 } from "../generated/BancorNetwork/ERC20";
import {
  Account,
  ActiveAccount,
  Deposit,
  DexAmmProtocol,
  FinancialsDailySnapshot,
  LiquidityPool,
  LiquidityPoolDailySnapshot,
  LiquidityPoolHourlySnapshot,
  Swap,
  Token,
  UsageMetricsDailySnapshot,
  UsageMetricsHourlySnapshot,
  Withdraw,
} from "../generated/schema";
import {
  BancorNetworkAddr,
  BancorNetworkInfoAddr,
  BnBntAddr,
  BntAddr,
  DaiAddr,
  EthAddr,
  exponentToBigDecimal,
  Network,
  ProtocolType,
  secondsPerDay,
  secondsPerHour,
  zeroBD,
  zeroBI,
} from "./constants";

enum EventType {
  Swap,
  Withdraw,
  Deposit,
}

export function handlePoolTokenCreated(event: PoolTokenCreated): void {
  let poolTokenAddress = event.params.poolToken;
  let reserveTokenAddress = event.params.token;

  let poolTokenID = poolTokenAddress.toHexString();
  let poolToken = Token.load(poolTokenID);
  if (poolToken != null) {
    log.warning("[handlePoolTokenCreated] pool token {} already exists", [
      poolTokenID,
    ]);
    return;
  }

  // pool token
  poolToken = new Token(poolTokenID);
  let poolTokenContract = PoolToken.bind(poolTokenAddress);

  let poolTokenNameResult = poolTokenContract.try_name();
  if (poolTokenNameResult.reverted) {
    log.warning("[handlePoolTokenCreated] try_name on {} reverted", [
      poolTokenID,
    ]);
    poolToken.name = "unknown name";
  } else {
    poolToken.name = poolTokenNameResult.value;
  }

  let poolTokenSymbolResult = poolTokenContract.try_symbol();
  if (poolTokenSymbolResult.reverted) {
    log.warning("[handlePoolTokenCreated] try_symbol on {} reverted", [
      poolTokenID,
    ]);
    poolToken.symbol = "unknown symbol";
  } else {
    poolToken.symbol = poolTokenSymbolResult.value;
  }

  let poolTokenDecimalsResult = poolTokenContract.try_decimals();
  if (poolTokenDecimalsResult.reverted) {
    log.warning("[handlePoolTokenCreated] try_decimals on {} reverted", [
      poolTokenID,
    ]);
    poolToken.decimals = 0;
  } else {
    poolToken.decimals = poolTokenDecimalsResult.value;
  }

  poolToken.save();

  // reserve token
  let reserveTokenID = reserveTokenAddress.toHexString();
  let reserveToken = new Token(reserveTokenID);
  reserveToken._poolToken = poolTokenID;

  if (reserveTokenAddress == Address.fromString(EthAddr)) {
    reserveToken.name = "Ether";
    reserveToken.symbol = "ETH";
    reserveToken.decimals = 18;
  } else {
    let tokenContract = ERC20.bind(Address.fromString(reserveTokenID));

    let tokenNameResult = tokenContract.try_name();
    if (tokenNameResult.reverted) {
      log.warning("[handlePoolTokenCreated] try_name on {} reverted", [
        reserveTokenID,
      ]);
      reserveToken.name = "unknown name";
    } else {
      reserveToken.name = tokenNameResult.value;
    }

    let tokenSymbolResult = tokenContract.try_symbol();
    if (tokenSymbolResult.reverted) {
      log.warning("[handlePoolTokenCreated] try_symbol on {} reverted", [
        reserveTokenID,
      ]);
      reserveToken.symbol = "unknown symbol";
    } else {
      reserveToken.symbol = tokenSymbolResult.value;
    }

    let tokenDecimalsResult = tokenContract.try_decimals();
    if (tokenDecimalsResult.reverted) {
      log.warning("[handlePoolTokenCreated] try_decimals on {} reverted", [
        reserveTokenID,
      ]);
      reserveToken.decimals = 0;
    } else {
      reserveToken.decimals = tokenDecimalsResult.value;
    }
  }
  reserveToken.save();

  let liquidityPool = createLiquidityPool(
    reserveToken,
    poolToken,
    event.block.timestamp,
    event.block.number
  );

  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    log.warning("[handlePoolTokenCreated] protocol not found", []);
    return;
  }
  let poolIDs = protocol._poolIDs;
  poolIDs.push(liquidityPool.id);
  protocol._poolIDs = poolIDs;
  protocol.save();
}

export function handlePoolCollectionAdded(event: PoolCollectionAdded): void {
  PoolCollection.create(event.params.poolCollection);
}

export function handleNetworkFeePPMUpdated(event: NetworkFeePPMUpdated): void {
  let protocol = getOrCreateProtocol();
  protocol._networkFeeRate = event.params.newFeePPM
    .toBigDecimal()
    .div(exponentToBigDecimal(6));
  protocol.save();
}

export function handleWithdrawalFeePPMUpdated(
  event: WithdrawalFeePPMUpdated
): void {
  let protocol = getOrCreateProtocol();
  protocol._withdrawalFeeRate = event.params.newFeePPM
    .toBigDecimal()
    .div(exponentToBigDecimal(6));
  protocol.save();
}

export function handleTokensTraded(event: TokensTraded): void {
  let sourceTokenID = event.params.sourceToken.toHexString();
  let targetTokenID = event.params.targetToken.toHexString();
  let sourceToken = Token.load(sourceTokenID);
  if (!sourceToken) {
    log.warning("[handleTokensTraded] source token {} not found", [
      sourceTokenID,
    ]);
    return;
  }
  let targetToken = Token.load(targetTokenID);
  if (!targetToken) {
    log.warning("[handleTokensTraded] target token {} not found", [
      targetTokenID,
    ]);
    return;
  }
  let swap = new Swap(
    "swap-"
      .concat(event.transaction.hash.toHexString())
      .concat("-")
      .concat(event.logIndex.toString())
  );
  swap.hash = event.transaction.hash.toHexString();
  swap.logIndex = event.logIndex.toI32();
  // TODO: hardcode this id
  swap.protocol = getOrCreateProtocol().id;
  swap.blockNumber = event.block.number;
  swap.timestamp = event.block.timestamp;
  swap.from = event.params.trader.toHexString();
  // TODO: use pool token id
  swap.to = event.params.trader.toHexString();
  swap.tokenIn = sourceTokenID;
  swap.amountIn = event.params.sourceAmount;
  let amountInUSD = getDaiAmount(
    sourceToken.id,
    event.params.sourceAmount,
    event.block.number
  );
  swap.amountInUSD = amountInUSD;
  swap.tokenOut = targetTokenID;
  swap.amountOut = event.params.targetAmount;
  swap.amountOutUSD = getDaiAmount(
    targetToken.id,
    event.params.targetAmount,
    event.block.number
  );
  swap.pool = sourceTokenID; // TODO: maybe 2 pools involved, but the field only allows one
  swap._tradingFeeAmount = event.params.targetFeeAmount;
  let tradingFeeAmountUSD = getDaiAmount(
    targetToken.id,
    event.params.targetFeeAmount,
    event.block.number
  );
  swap._tradingFeeAmountUSD = tradingFeeAmountUSD;

  swap.save();

  if (!sourceToken._poolToken) {
    log.warning("[handleTokensTraded] reserve token {} has no pool token", [
      sourceToken.id,
    ]);
    return;
  }
  let liquidityPool = LiquidityPool.load(sourceToken._poolToken!);
  if (!liquidityPool) {
    log.warning("[handleTokensTraded] liquidity pool {} not found", [
      sourceToken._poolToken!,
    ]);
    return;
  }
  liquidityPool.cumulativeVolumeUSD =
    liquidityPool.cumulativeVolumeUSD.plus(amountInUSD);
  liquidityPool._cumulativeTradingFeeAmountUSD =
    liquidityPool._cumulativeTradingFeeAmountUSD.plus(tradingFeeAmountUSD);
  liquidityPool.save();

  updateProtocol(EventType.Swap, tradingFeeAmountUSD);

  snapshotUsage(
    event.block.number,
    event.block.timestamp,
    event.params.trader.toHexString(),
    EventType.Swap
  );
  snapshotLiquidityPool(
    sourceToken._poolToken!,
    event.block.number,
    event.block.timestamp
  );
  updateLiquidityPoolSnapshot(
    sourceToken._poolToken!,
    event.params.sourceAmount,
    amountInUSD,
    event.block.number,
    event.block.timestamp
  );
  snapshotFinancials(event.block.timestamp, event.block.number);
  updateFinancialsSnapshot(
    EventType.Swap,
    amountInUSD,
    event.block.timestamp,
    event.block.number
  );
}

export function handleTokensDeposited(event: TokensDeposited): void {
  let reserveTokenID = event.params.token.toHexString();
  let reserveToken = Token.load(reserveTokenID);
  if (!reserveToken) {
    log.warning("[handleTokensDeposited] reserve token {} not found", [
      reserveTokenID,
    ]);
    return;
  }

  if (!reserveToken._poolToken) {
    log.warning("[handleTokensDeposited] reserve token {} has no pool token", [
      reserveTokenID,
    ]);
    return;
  }

  let poolToken = Token.load(reserveToken._poolToken!);
  if (!poolToken) {
    log.warning("[handleTokensDeposited] pool token {} not found", [
      reserveToken._poolToken!,
    ]);
    return;
  }

  _handleTokensDeposited(
    event,
    event.params.provider,
    reserveToken,
    event.params.tokenAmount,
    poolToken,
    event.params.poolTokenAmount
  );
}

export function handleBNTDeposited(event: BNTDeposited): void {
  let bntToken = Token.load(BntAddr);
  if (!bntToken) {
    log.warning("[handleBNTDeposited] BNT token {} not found", [BntAddr]);
    return;
  }
  let bnBntToken = Token.load(BnBntAddr);
  if (!bnBntToken) {
    log.warning("[handleBNTDeposited] bnBNT token {} not found", [BnBntAddr]);
    return;
  }

  _handleTokensDeposited(
    event,
    event.params.provider,
    bntToken,
    event.params.bntAmount,
    bnBntToken,
    event.params.poolTokenAmount
  );
}

export function handleTokensWithdrawn(event: TokensWithdrawn): void {
  let reserveTokenID = event.params.token.toHexString();
  let reserveToken = Token.load(reserveTokenID);
  if (!reserveToken) {
    log.warning("[handleTokensWithdrawn] reserve token {} not found", [
      reserveTokenID,
    ]);
    return;
  }
  let poolToken = Token.load(reserveToken._poolToken!);
  if (!poolToken) {
    log.warning("[handleTokensWithdrawn] pool token {} not found", [
      reserveToken._poolToken!,
    ]);
    return;
  }

  _handleTokensWithdrawn(
    event,
    event.params.provider,
    reserveToken,
    event.params.tokenAmount,
    poolToken,
    event.params.poolTokenAmount,
    event.params.withdrawalFeeAmount
  );
}

export function handleBNTWithdrawn(event: BNTWithdrawn): void {
  let bntToken = Token.load(BntAddr);
  if (!bntToken) {
    log.warning("[handleBNTWithdrawn] BNT token {} not found", [BntAddr]);
    return;
  }
  let bnBntToken = Token.load(BnBntAddr);
  if (!bnBntToken) {
    log.warning("[handleBNTWithdrawn] bnBNT token {} not found", [BnBntAddr]);
    return;
  }

  _handleTokensWithdrawn(
    event,
    event.params.provider,
    bntToken,
    event.params.bntAmount,
    bnBntToken,
    event.params.poolTokenAmount,
    event.params.withdrawalFeeAmount
  );
}

export function handleTotalLiquidityUpdated(
  event: TotalLiquidityUpdated
): void {
  let tokenAddress = event.params.pool.toHexString();
  let token = Token.load(tokenAddress);
  if (!token) {
    log.warning("[handleTotalLiquidityUpdated] reserve token {} not found", [
      tokenAddress,
    ]);
    return;
  }

  if (!token._poolToken) {
    log.warning(
      "[handleTotalLiquidityUpdated] reserve token {} has no pool token",
      [tokenAddress]
    );
    return;
  }

  let poolToken = Token.load(token._poolToken!);
  if (!poolToken) {
    log.warning("[handleTotalLiquidityUpdated] pool token {} not found", [
      token._poolToken!,
    ]);
    return;
  }

  let liquidityPool = LiquidityPool.load(token._poolToken!);
  if (!liquidityPool) {
    log.warning("[handleTotalLiquidityUpdated] liquidity pool {} not found", [
      token._poolToken!,
    ]);
    return;
  }

  _handleTotalLiquidityUpdated(
    liquidityPool,
    token.id,
    event.params.stakedBalance,
    event.params.poolTokenSupply,
    poolToken.decimals,
    event.block.number
  );
}

export function handleBNTTotalLiquidityUpdated(
  event: BNTTotalLiquidityUpdated
): void {
  let bnBntToken = Token.load(BnBntAddr);
  if (!bnBntToken) {
    log.warning("[handleBNTTotalLiquidityUpdated] bnBNT token {} not found", [
      BnBntAddr,
    ]);
    return;
  }

  let bnBntLiquidityPool = LiquidityPool.load(BnBntAddr);
  if (!bnBntLiquidityPool) {
    log.warning(
      "[handleBNTTotalLiquidityUpdated] bnBNT liquidity pool {} not found",
      [BnBntAddr]
    );
    return;
  }

  _handleTotalLiquidityUpdated(
    bnBntLiquidityPool,
    BntAddr,
    event.params.stakedBalance,
    event.params.poolTokenSupply,
    bnBntToken.decimals,
    event.block.number
  );
}

// currently each pool only has 1 reward program
// TODO: change this if it is no longer the case
// TODO: also handle ProgramTerminated and ProgramEnabled
export function handleProgramCreated(event: ProgramCreated): void {
  let reserveTokenId = event.params.pool.toHexString();
  let reserveToken = Token.load(reserveTokenId);
  if (!reserveToken) {
    log.warning("[handleProgramCreated] reserve token {} not found", [
      reserveTokenId,
    ]);
    return;
  }
  if (!reserveToken._poolToken) {
    log.warning("[handleProgramCreated] reserve token {} has no pool token", [
      reserveTokenId,
    ]);
    return;
  }

  let liquidityPool = LiquidityPool.load(reserveToken._poolToken!);
  if (!liquidityPool) {
    log.warning("[handleProgramCreated] liquidity pool {} not found", [
      reserveToken._poolToken!,
    ]);
    return;
  }

  // TODO: liquidityPool.rewardTokens = ???
  // TODO: each reward program has a start and end time
  let rewardRate = event.params.totalRewards.div(
    event.params.endTime.minus(event.params.startTime)
  );
  let rewardAmountInDay = rewardRate.times(BigInt.fromI32(secondsPerDay));
  let rewardAmountUSD = getDaiAmount(
    event.params.rewardsToken.toHexString(),
    rewardAmountInDay,
    event.block.number
  );
  liquidityPool.rewardTokenEmissionsAmount = [rewardAmountInDay];
  liquidityPool.rewardTokenEmissionsUSD = [rewardAmountUSD];
  liquidityPool.save();
}

function getOrCreateProtocol(): DexAmmProtocol {
  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    protocol = new DexAmmProtocol(BancorNetworkAddr);
    protocol.name = "Bancor V3";
    protocol.slug = "bancor-v3";
    protocol.schemaVersion = "1.2.1";
    protocol.subgraphVersion = "1.0.0";
    protocol.methodologyVersion = "1.0.0";
    protocol.network = Network.MAINNET;
    protocol.type = ProtocolType.EXCHANGE;
    protocol.totalValueLockedUSD = zeroBD;
    protocol.cumulativeVolumeUSD = zeroBD;
    protocol.cumulativeSupplySideRevenueUSD = zeroBD;
    protocol.cumulativeProtocolSideRevenueUSD = zeroBD;
    protocol.cumulativeTotalRevenueUSD = zeroBD;
    protocol.cumulativeUniqueUsers = 0;
    protocol._poolIDs = [];
    protocol._networkFeeRate = zeroBD;
    protocol._withdrawalFeeRate = zeroBD;
    protocol.save();
  }
  return protocol;
}

function createLiquidityPool(
  reserveToken: Token,
  poolToken: Token,
  blockTimestamp: BigInt,
  blockNumber: BigInt
): LiquidityPool {
  let liquidityPool = new LiquidityPool(poolToken.id);

  liquidityPool.protocol = getOrCreateProtocol().id;
  liquidityPool.name = poolToken.name;
  liquidityPool.symbol = poolToken.symbol;
  liquidityPool.inputTokens = [reserveToken.id];
  liquidityPool.outputToken = poolToken.id;
  liquidityPool.rewardTokens = [];
  liquidityPool.fees = []; // TODO
  liquidityPool.createdTimestamp = blockTimestamp;
  liquidityPool.createdBlockNumber = blockNumber;
  liquidityPool.totalValueLockedUSD = zeroBD;
  liquidityPool.cumulativeVolumeUSD = zeroBD;
  liquidityPool.inputTokenBalances = [zeroBI];
  liquidityPool.inputTokenWeights = [new BigDecimal(BigInt.fromI32(1))];
  liquidityPool.outputTokenSupply = zeroBI;
  liquidityPool.outputTokenPriceUSD = zeroBD;
  liquidityPool.stakedOutputTokenAmount = zeroBI;
  liquidityPool.rewardTokenEmissionsAmount = [zeroBI];
  liquidityPool.rewardTokenEmissionsUSD = [zeroBD];
  liquidityPool._cumulativeTradingFeeAmountUSD = zeroBD;
  liquidityPool._cumulativeWithdrawalFeeAmountUSD = zeroBD;

  liquidityPool.save();

  return liquidityPool;
}

function _handleTokensDeposited(
  event: ethereum.Event,
  depositer: Address,
  reserveToken: Token,
  reserveTokenAmount: BigInt,
  poolToken: Token,
  poolTokenAmount: BigInt
): void {
  let deposit = new Deposit(
    "deposit-"
      .concat(event.transaction.hash.toHexString())
      .concat("-")
      .concat(event.logIndex.toString())
  );
  deposit.hash = event.transaction.hash.toHexString();
  deposit.logIndex = event.logIndex.toI32();
  deposit.protocol = getOrCreateProtocol().id;
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;
  deposit.to = poolToken.id;
  deposit.from = depositer.toHexString();
  deposit.inputTokens = [reserveToken.id];
  deposit.inputTokenAmounts = [reserveTokenAmount];
  deposit.outputToken = poolToken.id;
  deposit.outputTokenAmount = poolTokenAmount;
  deposit.amountUSD = getDaiAmount(
    reserveToken.id,
    reserveTokenAmount,
    event.block.number
  );
  deposit.pool = poolToken.id;

  deposit.save();

  snapshotUsage(
    event.block.number,
    event.block.timestamp,
    depositer.toHexString(),
    EventType.Deposit
  );
  snapshotLiquidityPool(
    poolToken.id,
    event.block.number,
    event.block.timestamp
  );
  snapshotFinancials(event.block.timestamp, event.block.number);
}

function _handleTokensWithdrawn(
  event: ethereum.Event,
  withdrawer: Address,
  reserveToken: Token,
  reserveTokenAmount: BigInt,
  poolToken: Token,
  poolTokenAmount: BigInt,
  withdrawalFeeAmount: BigInt
): void {
  let withdraw = new Withdraw(
    "withdraw-"
      .concat(event.transaction.hash.toHexString())
      .concat("-")
      .concat(event.logIndex.toString())
  );
  withdraw.hash = event.transaction.hash.toHexString();
  withdraw.logIndex = event.logIndex.toI32();
  withdraw.protocol = getOrCreateProtocol().id;
  withdraw.blockNumber = event.block.number;
  withdraw.timestamp = event.block.timestamp;
  withdraw.to = withdrawer.toHexString();
  withdraw.from = poolToken.id;
  withdraw.inputTokens = [reserveToken.id];
  withdraw.inputTokenAmounts = [reserveTokenAmount];
  withdraw.outputToken = poolToken.id;
  withdraw.outputTokenAmount = poolTokenAmount;
  withdraw.amountUSD = getDaiAmount(
    reserveToken.id,
    reserveTokenAmount,
    event.block.number
  );
  withdraw.pool = poolToken.id;
  withdraw._withdrawalFeeAmount = withdrawalFeeAmount;
  let withdrawalFeeAmountUSD = getDaiAmount(
    reserveToken.id,
    withdrawalFeeAmount,
    event.block.number
  );
  withdraw._withdrawalFeeAmountUSD = withdrawalFeeAmountUSD;

  withdraw.save();

  let liquidityPool = LiquidityPool.load(poolToken.id);
  if (!liquidityPool) {
    log.warning("[handleTokensWithdrawn] liquidity pool {} not found", [
      poolToken.id,
    ]);
    return;
  }
  liquidityPool._cumulativeWithdrawalFeeAmountUSD =
    liquidityPool._cumulativeWithdrawalFeeAmountUSD.plus(
      withdrawalFeeAmountUSD
    );

  liquidityPool.save();

  updateProtocol(EventType.Withdraw, withdrawalFeeAmountUSD);

  snapshotUsage(
    event.block.number,
    event.block.timestamp,
    withdrawer.toHexString(),
    EventType.Withdraw
  );
  snapshotLiquidityPool(
    poolToken.id,
    event.block.number,
    event.block.timestamp
  );
  snapshotFinancials(event.block.timestamp, event.block.number);
  updateFinancialsSnapshot(
    EventType.Withdraw,
    withdrawalFeeAmountUSD,
    event.block.timestamp,
    event.block.number
  );
}

function _handleTotalLiquidityUpdated(
  liquidityPool: LiquidityPool,
  reserveTokenID: string,
  stakedBalance: BigInt,
  poolTokenSupply: BigInt,
  poolTokenDecimals: i32,
  blockNumber: BigInt
): void {
  let prevTotalValueLockedUSD = liquidityPool.totalValueLockedUSD;
  let currTotalValueLockedUSD = getDaiAmount(
    reserveTokenID,
    stakedBalance,
    blockNumber
  );

  liquidityPool.inputTokenBalances = [stakedBalance];
  liquidityPool.totalValueLockedUSD = currTotalValueLockedUSD;
  liquidityPool.outputTokenSupply = poolTokenSupply;
  liquidityPool.outputTokenPriceUSD = getDaiAmount(
    reserveTokenID,
    getReserveTokenAmount(
      reserveTokenID,
      BigInt.fromI32(10).pow(poolTokenDecimals as u8), // 1 share of pool token
      blockNumber
    ),
    blockNumber
  );
  liquidityPool.save();

  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    log.warning("[_handleTotalLiquidityUpdated] protocol not found", []);
    return;
  }
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD
    .plus(currTotalValueLockedUSD)
    .minus(prevTotalValueLockedUSD);
  protocol.save();
}

// TODO: figure out why it gets reverted sometimes
function getDaiAmount(
  sourceTokenID: string,
  sourceAmount: BigInt,
  blockNumber: BigInt
): BigDecimal {
  if (sourceTokenID == DaiAddr) {
    return sourceAmount.toBigDecimal().div(exponentToBigDecimal(18));
  }
  let info = BancorNetworkInfo.bind(Address.fromString(BancorNetworkInfoAddr));
  let targetAmountResult = info.try_tradeOutputBySourceAmount(
    Address.fromString(sourceTokenID),
    Address.fromString(DaiAddr),
    sourceAmount
  );
  if (targetAmountResult.reverted) {
    // TODO: remove blockno from logs
    log.warning(
      "[getDaiAmount] #{} try_tradeOutputBySourceAmount({}, {}, {}) reverted",
      [
        blockNumber.toI32().toString(),
        sourceTokenID,
        DaiAddr,
        sourceAmount.toString(),
      ]
    );
    return zeroBD;
  }
  // dai.decimals = 18
  return targetAmountResult.value.toBigDecimal().div(exponentToBigDecimal(18));
}

function getReserveTokenAmount(
  reserveTokenID: string,
  poolTokenAmount: BigInt,
  blockNumber: BigInt
): BigInt {
  let info = BancorNetworkInfo.bind(Address.fromString(BancorNetworkInfoAddr));
  let reserveTokenAmountResult = info.try_poolTokenToUnderlying(
    Address.fromString(reserveTokenID),
    poolTokenAmount
  );
  if (reserveTokenAmountResult.reverted) {
    log.warning(
      "[getReserveTokenAmount] #{} try_poolTokenToUnderlying({}, {}) reverted",
      [
        blockNumber.toI32().toString(),
        reserveTokenID,
        poolTokenAmount.toString(),
      ]
    );
    return zeroBI;
  }
  return reserveTokenAmountResult.value;
}

function updateProtocol(eventType: EventType, amountUSD: BigDecimal): void {
  let protocol = getOrCreateProtocol();
  protocol.cumulativeTotalRevenueUSD =
    protocol.cumulativeTotalRevenueUSD.plus(amountUSD);
  switch (eventType) {
    case EventType.Swap:
      let protocolSideRevenue = amountUSD.times(protocol._networkFeeRate);
      let supplySideRevenue = amountUSD.minus(protocolSideRevenue);
      protocol.cumulativeSupplySideRevenueUSD =
        protocol.cumulativeSupplySideRevenueUSD.plus(supplySideRevenue);
      protocol.cumulativeProtocolSideRevenueUSD =
        protocol.cumulativeProtocolSideRevenueUSD.plus(protocolSideRevenue);
      break;
    case EventType.Withdraw:
      protocol.cumulativeProtocolSideRevenueUSD =
        protocol.cumulativeProtocolSideRevenueUSD.plus(amountUSD);
      break;
    default:
  }
  protocol.save();
}

function updateFinancialsSnapshot(
  eventType: EventType,
  amountUSD: BigDecimal,
  blockTimestamp: BigInt,
  blockNumber: BigInt
): void {
  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    log.warning("[updateFinancialsSnapshot] protocol not found", []);
    return;
  }
  let snapshot = getOrCreateFinancialsDailySnapshot(blockTimestamp);
  snapshot.timestamp = blockTimestamp;
  snapshot.blockNumber = blockNumber;
  snapshot.dailyTotalRevenueUSD = snapshot.dailyTotalRevenueUSD.plus(amountUSD);

  switch (eventType) {
    case EventType.Swap:
      let protocolSideRevenue = amountUSD.times(protocol._networkFeeRate);
      let supplySideRevenue = amountUSD.minus(protocolSideRevenue);
      snapshot.dailySupplySideRevenueUSD =
        snapshot.dailySupplySideRevenueUSD.plus(supplySideRevenue);
      snapshot.dailyProtocolSideRevenueUSD =
        snapshot.dailyProtocolSideRevenueUSD.plus(protocolSideRevenue);
      break;
    case EventType.Withdraw:
      snapshot.dailyProtocolSideRevenueUSD =
        snapshot.dailyProtocolSideRevenueUSD.plus(amountUSD);
      break;
    default:
  }
  snapshot.save();
}

function snapshotUsage(
  blockNumber: BigInt,
  blockTimestamp: BigInt,
  accountID: string,
  eventType: EventType
): void {
  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    log.error("[snapshotUsage] Protocol not found, this SHOULD NOT happen", []);
    return;
  }
  let account = Account.load(accountID);
  if (!account) {
    account = new Account(accountID);
    account.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }

  //
  // daily snapshot
  //
  let dailySnapshotID = (blockTimestamp.toI32() / secondsPerDay).toString();
  let dailySnapshot = UsageMetricsDailySnapshot.load(dailySnapshotID);
  if (!dailySnapshot) {
    dailySnapshot = new UsageMetricsDailySnapshot(dailySnapshotID);
    dailySnapshot.protocol = protocol.id;
    dailySnapshot.dailyActiveUsers = 0;
    dailySnapshot.cumulativeUniqueUsers = 0;
    dailySnapshot.dailyTransactionCount = 0;
    dailySnapshot.dailyDepositCount = 0;
    dailySnapshot.dailyWithdrawCount = 0;
    dailySnapshot.dailySwapCount = 0;
    dailySnapshot.blockNumber = blockNumber;
    dailySnapshot.timestamp = blockTimestamp;
  }
  let dailyAccountID = accountID.concat("-").concat(dailySnapshotID);
  let dailyActiveAccount = ActiveAccount.load(dailyAccountID);
  if (!dailyActiveAccount) {
    dailyActiveAccount = new ActiveAccount(dailyAccountID);
    dailyActiveAccount.save();

    dailySnapshot.dailyActiveUsers += 1;
  }
  dailySnapshot.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
  dailySnapshot.dailyTransactionCount += 1;
  switch (eventType) {
    case EventType.Deposit:
      dailySnapshot.dailyDepositCount += 1;
      break;
    case EventType.Withdraw:
      dailySnapshot.dailyWithdrawCount += 1;
      break;
    case EventType.Swap:
      dailySnapshot.dailySwapCount += 1;
      break;
    default:
  }
  dailySnapshot.blockNumber = blockNumber;
  dailySnapshot.timestamp = blockTimestamp;
  dailySnapshot.save();

  //
  // hourly snapshot
  //
  let hourlySnapshotID = (blockTimestamp.toI32() / secondsPerDay).toString();
  let hourlySnapshot = UsageMetricsHourlySnapshot.load(hourlySnapshotID);
  if (!hourlySnapshot) {
    hourlySnapshot = new UsageMetricsHourlySnapshot(hourlySnapshotID);
    hourlySnapshot.protocol = protocol.id;
    hourlySnapshot.hourlyActiveUsers = 0;
    hourlySnapshot.cumulativeUniqueUsers = 0;
    hourlySnapshot.hourlyTransactionCount = 0;
    hourlySnapshot.hourlyDepositCount = 0;
    hourlySnapshot.hourlyWithdrawCount = 0;
    hourlySnapshot.hourlySwapCount = 0;
    hourlySnapshot.blockNumber = blockNumber;
    hourlySnapshot.timestamp = blockTimestamp;
  }
  let hourlyAccountID = accountID.concat("-").concat(hourlySnapshotID);
  let hourlyActiveAccount = ActiveAccount.load(hourlyAccountID);
  if (!hourlyActiveAccount) {
    hourlyActiveAccount = new ActiveAccount(hourlyAccountID);
    hourlyActiveAccount.save();

    hourlySnapshot.hourlyActiveUsers += 1;
  }
  hourlySnapshot.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
  hourlySnapshot.hourlyTransactionCount += 1;
  switch (eventType) {
    case EventType.Deposit:
      hourlySnapshot.hourlyDepositCount += 1;
      break;
    case EventType.Withdraw:
      hourlySnapshot.hourlyWithdrawCount += 1;
      break;
    case EventType.Swap:
      hourlySnapshot.hourlySwapCount += 1;
      break;
    default:
  }
  hourlySnapshot.blockNumber = blockNumber;
  hourlySnapshot.timestamp = blockTimestamp;
  hourlySnapshot.save();
}

function snapshotLiquidityPool(
  liquidityPoolID: string,
  blockNumber: BigInt,
  blockTimestamp: BigInt
): void {
  let liquidityPool = LiquidityPool.load(liquidityPoolID);
  if (!liquidityPool) {
    log.warning("[snapshotLiquidityPool] liquidity pool {} not found", [
      liquidityPoolID,
    ]);
    return;
  }

  //
  // daily snapshot
  //
  let dailySnapshot = getOrCreateLiquidityPoolDailySnapshot(
    liquidityPoolID,
    blockTimestamp,
    blockNumber
  );
  dailySnapshot.totalValueLockedUSD = liquidityPool.totalValueLockedUSD;
  dailySnapshot.cumulativeVolumeUSD = liquidityPool.cumulativeVolumeUSD;
  dailySnapshot.inputTokenBalances = [liquidityPool.inputTokenBalances[0]];
  dailySnapshot.inputTokenWeights = [liquidityPool.inputTokenWeights[0]];
  dailySnapshot.outputTokenSupply = liquidityPool.outputTokenSupply;
  dailySnapshot.outputTokenPriceUSD = liquidityPool.outputTokenPriceUSD;
  dailySnapshot.stakedOutputTokenAmount = liquidityPool.stakedOutputTokenAmount;
  dailySnapshot.rewardTokenEmissionsAmount = [
    liquidityPool.rewardTokenEmissionsAmount![0],
  ];
  dailySnapshot.rewardTokenEmissionsUSD = liquidityPool.rewardTokenEmissionsUSD;
  dailySnapshot.save();

  //
  // hourly snapshot
  //
  let hourlySnapshot = getOrCreateLiquidityPoolHourlySnapshot(
    liquidityPoolID,
    blockTimestamp,
    blockNumber
  );
  hourlySnapshot.totalValueLockedUSD = liquidityPool.totalValueLockedUSD;
  hourlySnapshot.cumulativeVolumeUSD = liquidityPool.cumulativeVolumeUSD;
  hourlySnapshot.inputTokenBalances = [liquidityPool.inputTokenBalances[0]];
  hourlySnapshot.inputTokenWeights = [liquidityPool.inputTokenWeights[0]];
  hourlySnapshot.outputTokenSupply = liquidityPool.outputTokenSupply;
  hourlySnapshot.outputTokenPriceUSD = liquidityPool.outputTokenPriceUSD;
  hourlySnapshot.stakedOutputTokenAmount =
    liquidityPool.stakedOutputTokenAmount;
  hourlySnapshot.rewardTokenEmissionsAmount = [
    liquidityPool.rewardTokenEmissionsAmount![0],
  ];
  hourlySnapshot.rewardTokenEmissionsUSD =
    liquidityPool.rewardTokenEmissionsUSD;
  hourlySnapshot.save();
}

function updateLiquidityPoolSnapshot(
  liquidityPoolID: string,
  amount: BigInt,
  amountUSD: BigDecimal,
  blockNumber: BigInt,
  blockTimestamp: BigInt
): void {
  //
  // daily snapshot
  //
  let dailySnapshot = getOrCreateLiquidityPoolDailySnapshot(
    liquidityPoolID,
    blockTimestamp,
    blockNumber
  );
  dailySnapshot.dailyVolumeByTokenAmount = [
    dailySnapshot.dailyVolumeByTokenAmount[0].plus(amount),
  ];
  dailySnapshot.dailyVolumeByTokenUSD = [
    dailySnapshot.dailyVolumeByTokenUSD[0].plus(amountUSD),
  ];
  dailySnapshot.dailyVolumeUSD = dailySnapshot.dailyVolumeByTokenUSD[0];
  dailySnapshot.save();

  //
  // hourly snapshot
  //
  let hourlySnapshot = getOrCreateLiquidityPoolHourlySnapshot(
    liquidityPoolID,
    blockTimestamp,
    blockNumber
  );
  hourlySnapshot.hourlyVolumeByTokenAmount = [
    hourlySnapshot.hourlyVolumeByTokenAmount[0].plus(amount),
  ];
  hourlySnapshot.hourlyVolumeByTokenUSD = [
    hourlySnapshot.hourlyVolumeByTokenUSD[0].plus(amountUSD),
  ];
  hourlySnapshot.hourlyVolumeUSD = hourlySnapshot.hourlyVolumeByTokenUSD[0];
  hourlySnapshot.save();
}

function snapshotFinancials(blockTimestamp: BigInt, blockNumber: BigInt): void {
  let protocol = DexAmmProtocol.load(BancorNetworkAddr);
  if (!protocol) {
    log.warning("[snapshotFinancials] protocol not found", []);
    return;
  }

  let snapshot = getOrCreateFinancialsDailySnapshot(blockTimestamp);

  snapshot.timestamp = blockTimestamp;
  snapshot.blockNumber = blockNumber;
  snapshot.totalValueLockedUSD = protocol.totalValueLockedUSD;
  snapshot.cumulativeTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD;
  snapshot.cumulativeProtocolSideRevenueUSD =
    protocol.cumulativeProtocolSideRevenueUSD;
  snapshot.cumulativeSupplySideRevenueUSD =
    protocol.cumulativeSupplySideRevenueUSD;

  let cumulativeVolumeUSD = zeroBD;
  let dailyVolumeUSD = zeroBD;
  for (let i = 0; i < protocol._poolIDs.length; i++) {
    let liquidityPool = LiquidityPool.load(protocol._poolIDs[i]);
    if (!liquidityPool) {
      log.warning("[snapshotFinancials] liqudity pool {} not found", [
        protocol._poolIDs[i],
      ]);
      return;
    }
    cumulativeVolumeUSD = cumulativeVolumeUSD.plus(
      liquidityPool.cumulativeVolumeUSD
    );

    let liquidityPoolDailySnapshotID = getLiquidityPoolDailySnapshotID(
      liquidityPool.id,
      blockTimestamp.toI32()
    );
    let liquidityPoolDailySnapshot = LiquidityPoolDailySnapshot.load(
      liquidityPoolDailySnapshotID
    );
    if (!liquidityPoolDailySnapshot) {
      log.warning(
        "[snapshotFinancials] liquidity pool daily snapshot {} not found",
        [liquidityPoolDailySnapshotID]
      );
      continue;
    }
    dailyVolumeUSD = dailyVolumeUSD.plus(
      liquidityPoolDailySnapshot.dailyVolumeUSD
    );
  }

  snapshot.cumulativeVolumeUSD = cumulativeVolumeUSD;
  snapshot.dailyVolumeUSD = dailyVolumeUSD;
  snapshot.save();

  // protocol controlled value usd = bnt_amount * bnt_price
  let bntLiquidityPool = LiquidityPool.load(BnBntAddr);
  if (!bntLiquidityPool) {
    log.warning("[snapshotFinancials] bnBNT liquidity pool not found", []);
    return;
  }
  if (!bntLiquidityPool.outputTokenSupply) {
    log.warning(
      "[snapshotFinancials] bnBNT liquidity pool has no outputTokenSupply",
      []
    );
    return;
  }

  let bntAmount = getReserveTokenAmount(
    BntAddr,
    bntLiquidityPool.outputTokenSupply!,
    blockNumber
  );
  snapshot.protocolControlledValueUSD = getDaiAmount(
    BntAddr,
    bntAmount,
    blockNumber
  );
  snapshot.save();
}

function getOrCreateFinancialsDailySnapshot(
  blockTimestamp: BigInt
): FinancialsDailySnapshot {
  let snapshotID = (blockTimestamp.toI32() / secondsPerDay).toString();
  let snapshot = FinancialsDailySnapshot.load(snapshotID);
  if (!snapshot) {
    snapshot = new FinancialsDailySnapshot(snapshotID);

    snapshot.protocol = BancorNetworkAddr;
    snapshot.blockNumber = zeroBI;
    snapshot.timestamp = zeroBI;
    snapshot.totalValueLockedUSD = zeroBD;
    snapshot.protocolControlledValueUSD = zeroBD;
    snapshot.dailyVolumeUSD = zeroBD;
    snapshot.dailyTotalRevenueUSD = zeroBD;
    snapshot.dailySupplySideRevenueUSD = zeroBD;
    snapshot.dailyProtocolSideRevenueUSD = zeroBD;
    snapshot.cumulativeVolumeUSD = zeroBD;
    snapshot.cumulativeTotalRevenueUSD = zeroBD;
    snapshot.cumulativeSupplySideRevenueUSD = zeroBD;
    snapshot.cumulativeProtocolSideRevenueUSD = zeroBD;
    snapshot.save();
  }

  return snapshot;
}

function getOrCreateLiquidityPoolDailySnapshot(
  liquidityPoolID: string,
  blockTimestamp: BigInt,
  blockNumber: BigInt
): LiquidityPoolDailySnapshot {
  let snapshotID = getLiquidityPoolDailySnapshotID(
    liquidityPoolID,
    blockTimestamp.toI32()
  );
  let snapshot = LiquidityPoolDailySnapshot.load(snapshotID);
  if (!snapshot) {
    snapshot = new LiquidityPoolDailySnapshot(snapshotID);
    snapshot.blockNumber = blockNumber;
    snapshot.timestamp = blockTimestamp;

    snapshot.protocol = BancorNetworkAddr;
    snapshot.pool = liquidityPoolID;
    snapshot.totalValueLockedUSD = zeroBD;
    snapshot.cumulativeVolumeUSD = zeroBD;
    snapshot.inputTokenBalances = [zeroBI];
    snapshot.inputTokenWeights = [zeroBD];
    snapshot.outputTokenSupply = zeroBI;
    snapshot.outputTokenPriceUSD = zeroBD;
    snapshot.stakedOutputTokenAmount = zeroBI;
    snapshot.rewardTokenEmissionsAmount = [zeroBI];
    snapshot.rewardTokenEmissionsUSD = [zeroBD];

    snapshot.dailyVolumeUSD = zeroBD;
    snapshot.dailyVolumeByTokenAmount = [zeroBI];
    snapshot.dailyVolumeByTokenUSD = [zeroBD];
  }

  return snapshot;
}

function getOrCreateLiquidityPoolHourlySnapshot(
  liquidityPoolID: string,
  blockTimestamp: BigInt,
  blockNumber: BigInt
): LiquidityPoolHourlySnapshot {
  let snapshotID = getLiquidityPoolHourlySnapshotID(
    liquidityPoolID,
    blockTimestamp.toI32()
  );
  let snapshot = LiquidityPoolHourlySnapshot.load(snapshotID);
  if (!snapshot) {
    snapshot = new LiquidityPoolHourlySnapshot(snapshotID);
    snapshot.blockNumber = blockNumber;
    snapshot.timestamp = blockTimestamp;

    snapshot.protocol = BancorNetworkAddr;
    snapshot.pool = liquidityPoolID;
    snapshot.totalValueLockedUSD = zeroBD;
    snapshot.cumulativeVolumeUSD = zeroBD;
    snapshot.inputTokenBalances = [zeroBI];
    snapshot.inputTokenWeights = [zeroBD];
    snapshot.outputTokenSupply = zeroBI;
    snapshot.outputTokenPriceUSD = zeroBD;
    snapshot.stakedOutputTokenAmount = zeroBI;
    snapshot.rewardTokenEmissionsAmount = [zeroBI];
    snapshot.rewardTokenEmissionsUSD = [zeroBD];

    snapshot.hourlyVolumeUSD = zeroBD;
    snapshot.hourlyVolumeByTokenAmount = [zeroBI];
    snapshot.hourlyVolumeByTokenUSD = [zeroBD];
  }

  return snapshot;
}

function getLiquidityPoolDailySnapshotID(
  liquidityPoolID: string,
  timestamp: i32
): string {
  return liquidityPoolID
    .concat("-")
    .concat((timestamp / secondsPerDay).toString());
}

function getLiquidityPoolHourlySnapshotID(
  liquidityPoolID: string,
  timestamp: i32
): string {
  return liquidityPoolID
    .concat("-")
    .concat((timestamp / secondsPerHour).toString());
}
