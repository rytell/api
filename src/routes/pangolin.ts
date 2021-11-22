import type {Handler} from 'worktop';
import {send} from 'worktop/response';
import {BigNumber, BigNumberish} from '@ethersproject/bignumber';
import * as QUERIES from '../utils/queries';
import * as gql from '../utils/gql';
import {
  STAKING_ADDRESSES,
  WAVAX_ADDRESS,
  PNG_ADDRESS,
  WAVAX_PNG_ADDRESS,
  DAIe_ADDRESS,
  USDCe_ADDRESS,
  USDTe_ADDRESS,
  ZERO,
  TEN,
  EIGHTEEN,
} from '../constants';
import {
  getStakingTokenAddress,
  getBalance,
  getTotalSupply,
  getPoolTokens,
  getRewardRate,
  getStakingTokenAddressFromMiniChefV2,
  getRewardPerSecondFromMiniChefV2,
  getTotalAllocationPointsFromMiniChefV2,
  getPoolInfoFromMiniChefV2,
} from '../utils/calls';

// GET /pangolin/addresses
export const addresses: Handler = async function () {
  let number_addresses = 0;
  let new_addrs = 0;
  let firstUser = '0x0000000000000000000000000000000000000000';

  do {
    const {users} = await gql.request(QUERIES.USER, {
      first: 1000,
      firstUser,
      orderBy: 'id',
    });
    firstUser = users[users.length - 1].id;
    new_addrs = users.length;
    number_addresses += new_addrs;
  } while (new_addrs === 1000);

  return send(200, number_addresses, {
    'Cache-Control': 'public,s-maxage=30',
  });
};

// GET /pangolin/transaction-average
export const average: Handler = async function () {
  const result = await gql.request(QUERIES.FACTORY);
  const {totalVolumeUSD, txCount} = result.pangolinFactories[0];

  const text = (Number.parseFloat(totalVolumeUSD) / Number.parseInt(txCount, 10)).toFixed(2);

  return send(200, text, {
    'Cache-Control': 'public,s-maxage=30',
  });
};

// GET /pangolin/transaction-median
// export const median: Handler = async function () {};

// GET /pangolin/apr/:address
export const apr: Handler = async function (_, context) {
  const aprs = {
    swapFeeApr: 0,
    stakingApr: 0,
    combinedApr: 0,
  };

  const stakingAddress = context.params.address;

  if (!STAKING_ADDRESSES.includes(stakingAddress)) {
    return send(200, aprs);
  }

  try {
    const stakingTokenAddress = await getStakingTokenAddress(stakingAddress);

    // Number of days to average swap volume from
    const days = 7;

    const [
      {pairDayDatas},
      poolTokenBalance,
      poolTokenSupply,
      [token0, token1],
      pooledAVAX,
      pooledPNG,
      stakingRewardRate,
    ] = await Promise.all([
      // Swap volume over 7 days
      gql.request(QUERIES.DAILY_VOLUME, {
        days,
        pairAddress: stakingTokenAddress,
      }),

      // How much PGL is staked
      getBalance(stakingTokenAddress, stakingAddress),

      // Total PGL supply
      getTotalSupply(stakingTokenAddress),

      // Get the two token addresses in the pool
      getPoolTokens(stakingTokenAddress),

      // How much AVAX is in the AVAX-PNG pool
      getBalance(WAVAX_ADDRESS, WAVAX_PNG_ADDRESS),

      // How much PNG is in the AVAX-PNG pool
      getBalance(PNG_ADDRESS, WAVAX_PNG_ADDRESS),

      // Current staking reward rate
      getRewardRate(stakingAddress),
    ]);

    if (poolTokenSupply.isZero()) {
      return send(200, aprs);
    }

    const stakedAVAX = [token0, token1].includes(WAVAX_ADDRESS)
      ? (await getBalance(WAVAX_ADDRESS, stakingTokenAddress))
          // Other side of pool has equal value
          .mul(2)
          // Not all PGL is staked
          .mul(poolTokenBalance)
          .div(poolTokenSupply)
      : (await getBalance(PNG_ADDRESS, stakingTokenAddress))
          // Other side of pool has equal value
          .mul(2)
          // Convert to AVAX
          .mul(pooledAVAX)
          .div(pooledPNG)
          // Not all PGL is staked
          .mul(poolTokenBalance)
          .div(poolTokenSupply);

    const stakingAPR = stakedAVAX.isZero()
      ? ZERO
      : stakingRewardRate
          // Reward rate is per second
          .mul(60 * 60 * 24 * 365)
          // Convert to AVAX
          .mul(pooledAVAX)
          .div(pooledPNG)
          // Percentage
          .mul(100)
          // Divide by amount staked to get APR
          .div(stakedAVAX);

    let swapVolumeUSD = ZERO;
    let liquidityUSD = ZERO;
    for (const {dailyVolumeUSD, reserveUSD} of pairDayDatas) {
      swapVolumeUSD = swapVolumeUSD.add(Math.floor(dailyVolumeUSD));
      liquidityUSD = liquidityUSD.add(Math.floor(reserveUSD));
    }

    const fees = swapVolumeUSD.mul(365).div(days).mul(3).div(1000);
    const averageLiquidityUSD = liquidityUSD.div(days);
    const swapFeeAPR = averageLiquidityUSD.isZero() ? ZERO : fees.mul(100).div(averageLiquidityUSD);
    const combinedAPR = stakingAPR.add(swapFeeAPR);

    aprs.swapFeeApr = swapFeeAPR.toNumber();
    aprs.stakingApr = stakingAPR.toNumber();
    aprs.combinedApr = combinedAPR.toNumber();
  } catch {}

  return send(200, aprs, {
    'Cache-Control': 'public,s-maxage=60',
  });
};

// GET /pangolin/apr2/:pid
export const apr2: Handler = async function (_, context) {
  const aprs = {
    swapFeeApr: 0,
    stakingApr: 0,
    combinedApr: 0,
  };

  const poolId = context.params.pid;

  // Verify valid poolId

  try {
    const stakingTokenAddress = await getStakingTokenAddressFromMiniChefV2(poolId);

    // Number of days to average swap volume from
    const days = 7;

    const [
      {pairDayDatas},
      {
        bundle: {ethPrice: avaxPriceString},
      },
      {
        token: {derivedETH: derivedPngString},
      },
      [token0, token1],
      rewardPerSecond,
      poolInfo,
      totalAllocPoints,
    ] = await Promise.all([
      // Swap volume over 7 days
      gql.request(QUERIES.DAILY_VOLUME, {
        days,
        pairAddress: stakingTokenAddress,
      }),

      // AVAX price in terms of USD
      gql.request(QUERIES.AVAX_PRICE),

      // PNG price in terms of AVAX
      gql.request(QUERIES.TOKEN_PRICE, {
        address: PNG_ADDRESS.toLowerCase(),
      }),

      // Get the two token addresses in the pool
      getPoolTokens(stakingTokenAddress),

      // Current staking reward rate
      getRewardPerSecondFromMiniChefV2(),

      // Pool information especially allocation points
      getPoolInfoFromMiniChefV2(poolId),

      // Total allocation points
      getTotalAllocationPointsFromMiniChefV2(),
    ]);

    const avaxPrice = convertStringToBigNumber(avaxPriceString, 0, 18);
    const pngPrice = convertStringToBigNumber(derivedPngString, 0, 18).mul(avaxPrice);

    let stakedPNG = ZERO;

    if ([token0, token1].includes(PNG_ADDRESS)) {
      stakedPNG = (await getBalance(PNG_ADDRESS, stakingTokenAddress)).mul(2);
    } else if ([token0, token1].includes(DAIe_ADDRESS)) {
      const pairValueInDAI = (await getBalance(DAIe_ADDRESS, stakingTokenAddress)).mul(2);
      stakedPNG = pairValueInDAI.div(pngPrice);
    } else if ([token0, token1].includes(USDCe_ADDRESS)) {
      const pairValueInUSDC = (await getBalance(USDCe_ADDRESS, stakingTokenAddress)).mul(2);
      stakedPNG = expandTo18Decimals(pairValueInUSDC, 6).div(pngPrice); // USDCe has 6 decimals
    } else if ([token0, token1].includes(USDTe_ADDRESS)) {
      const pairValueInUSDT = (await getBalance(USDTe_ADDRESS, stakingTokenAddress)).mul(2);
      stakedPNG = expandTo18Decimals(pairValueInUSDT, 6).div(pngPrice); // USDTe has 6 decimals
    } else if ([token0, token1].includes(WAVAX_ADDRESS)) {
      const pairValueInWAVAX = (await getBalance(USDTe_ADDRESS, stakingTokenAddress)).mul(2);
      stakedPNG = pairValueInWAVAX.mul(avaxPrice).div(pngPrice);
    }

    const stakingAPR = stakedPNG.isZero()
      ? ZERO
      : rewardPerSecond
          // Calculate reward rate per year
          .mul(60 * 60 * 24 * 365)
          // Calculate weight of pool
          .mul(poolInfo.allocPoint)
          .div(totalAllocPoints)
          // Percentage
          .mul(100)
          // Divide by amount staked to get APR
          .div(stakedPNG);

    let swapVolumeUSD = ZERO;
    let liquidityUSD = ZERO;
    for (const {dailyVolumeUSD, reserveUSD} of pairDayDatas) {
      swapVolumeUSD = swapVolumeUSD.add(Math.floor(dailyVolumeUSD));
      liquidityUSD = liquidityUSD.add(Math.floor(reserveUSD));
    }

    const fees = swapVolumeUSD.mul(365).div(days).mul(3).div(1000);
    const averageLiquidityUSD = liquidityUSD.div(days);
    const swapFeeAPR = averageLiquidityUSD.isZero() ? ZERO : fees.mul(100).div(averageLiquidityUSD);
    const combinedAPR = stakingAPR.add(swapFeeAPR);

    aprs.swapFeeApr = swapFeeAPR.toNumber();
    aprs.stakingApr = stakingAPR.toNumber();
    aprs.combinedApr = combinedAPR.toNumber();
  } catch {}

  return send(200, aprs, {
    'Cache-Control': 'public,s-maxage=60',
  });
};

function expandTo18Decimals(value: BigNumber, decimals: BigNumberish) {
  const scalar = TEN.pow(EIGHTEEN.sub(decimals));
  return value.mul(scalar);
}

function convertStringToBigNumber(
  input: string,
  inputDecimals: number,
  outputDecimals: number,
): BigNumber {
  const LEADING_ZERO_REGEX = /^0+/;
  const adjustedStringValue = Number.parseFloat(input)
    .toFixed(outputDecimals - inputDecimals)
    .replace('.', '')
    .replace(LEADING_ZERO_REGEX, '');
  return BigNumber.from(adjustedStringValue);
}
