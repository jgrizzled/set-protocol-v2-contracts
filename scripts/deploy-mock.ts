// Deploy a test environment to hardhat for subgraph development

import "module-alias/register";
import Web3 from "web3";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether, bitcoin } from "@utils/index";
import { getAccounts, getSystemFixture, getUniswapFixture } from "@utils/test/index";

const web3 = new Web3();

async function main() {
  console.log("Starting deployment");
  const [owner, manager, mockModule] = await getAccounts();

  const deployer = new DeployHelper(owner.wallet);
  const setup = getSystemFixture(owner.address);
  await setup.initialize();

  const wbtcRate = ether(33); // 1 WBTC = 33 ETH
  console.log("Deploying mock exchanges");
  // Mock Kyber reserve only allows trading from/to WETH
  const kyberNetworkProxy = await deployer.mocks.deployKyberNetworkProxyMock(setup.weth.address);
  await kyberNetworkProxy.addToken(setup.wbtc.address, wbtcRate, 8);
  const kyberExchangeAdapter = await deployer.adapters.deployKyberExchangeAdapter(
    kyberNetworkProxy.address,
  );

  // Mock OneInch exchange that allows for only fixed exchange amounts
  const oneInchExchangeMock = await deployer.mocks.deployOneInchExchangeMock(
    setup.wbtc.address,
    setup.weth.address,
    BigNumber.from(100000000), // 1 WBTC
    wbtcRate, // Trades for 33 WETH
  );

  // 1inch function signature
  const oneInchFunctionSignature = web3.eth.abi.encodeFunctionSignature(
    "swap(address,address,uint256,uint256,uint256,address,address[],bytes,uint256[],uint256[])",
  );
  const oneInchExchangeAdapter = await deployer.adapters.deployOneInchExchangeAdapter(
    oneInchExchangeMock.address,
    oneInchExchangeMock.address,
    oneInchFunctionSignature,
  );

  const uniswapSetup = getUniswapFixture(owner.address);
  await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
  const uniswapExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(
    uniswapSetup.router.address,
  );

  const zeroExMock = await deployer.mocks.deployZeroExMock(
    setup.wbtc.address,
    setup.weth.address,
    BigNumber.from(100000000), // 1 WBTC
    wbtcRate, // Trades for 33 WETH
  );
  const zeroExApiAdapter = await deployer.adapters.deployZeroExApiAdapter(zeroExMock.address);

  const kyberAdapterName = "KYBER";
  const oneInchAdapterName = "ONEINCH";
  const uniswapAdapterName = "UNISWAPV2";
  const zeroExApiAdapterName = "ZERO_EX";

  let tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
  await setup.controller.addModule(tradeModule.address);

  await setup.integrationRegistry.batchAddIntegration(
    [tradeModule.address, tradeModule.address, tradeModule.address, tradeModule.address],
    [kyberAdapterName, oneInchAdapterName, uniswapAdapterName, zeroExApiAdapterName],
    [
      kyberExchangeAdapter.address,
      oneInchExchangeAdapter.address,
      uniswapExchangeAdapter.address,
      zeroExApiAdapter.address,
    ],
  );

  // deployed SetToken with enabled TradeModule
  // Selling WBTC
  let sourceToken = setup.wbtc;
  let destinationToken = setup.weth;
  const wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

  console.log("Deploying set token");
  // Create Set token
  const setToken = await setup.createSetToken(
    [sourceToken.address],
    [wbtcUnits],
    [setup.issuanceModule.address, tradeModule.address],
    manager.address,
  );

  tradeModule = tradeModule.connect(manager.wallet);
  await tradeModule.initialize(setToken.address);
  await setToken.isInitializedModule(tradeModule.address);

  console.log("Trading");
  // trade
  // Fund Kyber reserve with destinationToken WETH
  destinationToken = destinationToken.connect(owner.wallet);
  await destinationToken.transfer(kyberNetworkProxy.address, ether(1000));

  const sourceTokenQuantity = wbtcUnits.div(2); // Trade 0.5 WBTC
  const sourceTokenDecimals = await sourceToken.decimals();
  const destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);

  // Transfer sourceToken from owner to manager for issuance
  sourceToken = sourceToken.connect(owner.wallet);
  await sourceToken.transfer(manager.address, wbtcUnits.mul(100));

  // Approve tokens to Controller and call issue
  sourceToken = sourceToken.connect(manager.wallet);
  await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);
  // Deploy mock issuance hook and initialize issuance module
  setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
  const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
  await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);
  console.log("Issue 10 tokens");
  // Issue 10 SetTokens
  const issueQuantity = ether(10);
  await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
  const subjectSourceToken = sourceToken.address;
  const subjectDestinationToken = destinationToken.address;
  const subjectSourceQuantity = sourceTokenQuantity;
  const subjectSetToken = setToken.address;
  const subjectAdapterName = kyberAdapterName;
  const subjectData = EMPTY_BYTES;
  const subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(0.5)); // Receive a min of 16 WETH for 0.5 WBTC

  await tradeModule.trade(
    subjectSetToken,
    subjectAdapterName,
    subjectSourceToken,
    subjectSourceQuantity,
    subjectDestinationToken,
    subjectMinDestinationQuantity,
    subjectData,
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
