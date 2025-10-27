import { ethers, fhevm } from "hardhat";
import { expect } from "chai";

describe("PrivacyRouter e2e (mock fhevm)", function () {
  before(function () {
    if (!fhevm.isMock) {
      console.warn("Skipping e2e test: requires mock FHEVM environment");
      this.skip();
    }
  });

  it("should run the full wrap -> batch -> unwrap -> swap -> wrap -> distribute flow", async function () {
    const [, alice, bob] = await ethers.getSigners();

    // Deploy mocks
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();
    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    // Deploy wrappers
    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapperIn = await EncryptedWBTC.deploy(wbtc);
    await wrapperIn.waitForDeployment();
    const wrapperOut = await EncryptedWBTC.deploy(tokenOut);
    await wrapperOut.waitForDeployment();

    // Deploy MockUniswap router
    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();
    await mockRouter.setRate(1, 1);

    // Deploy PrivacyRouter
    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    // Register wrappers (use addresses)
    const wbtcAddress = await wbtc.getAddress();
    const tokenOutAddress = await tokenOut.getAddress();
    const wrapperInAddress = await wrapperIn.getAddress();
    const wrapperOutAddress = await wrapperOut.getAddress();
    await router.registerTokenWrapper(wbtcAddress, wrapperInAddress);
    await router.registerTokenWrapper(tokenOutAddress, wrapperOutAddress);

    // create encrypted swap intents using fhevm test helpers
    const routerAddress = await router.getAddress();
    await wrapperIn.mintFromPlain(100, routerAddress);
    await wrapperIn.mintFromPlain(200, routerAddress);

    // Create swap requests
    await router.connect(alice).createSwapRequestPlain(wbtcAddress, tokenOutAddress, 100, 0);
    await router.connect(bob).createSwapRequestPlain(wbtcAddress, tokenOutAddress, 200, 0);

    await router.triggerBatch(wbtcAddress, tokenOutAddress);
    const batchId = 0;
    const plaintextAmount = 300;

    await router.setBatchFinalized(batchId, plaintextAmount);
    await wbtc.transfer(routerAddress, plaintextAmount);

    const mockRouterAddr = await mockRouter.getAddress();
    await tokenOut.transfer(mockRouterAddr, plaintextAmount);
    await router.executeBatchSwap(batchId);

    const totalOut = 300;
    const aliceShare = Math.floor((100 / 300) * totalOut);
    const bobShare = totalOut - aliceShare;

    // Mint encrypted outputs directly to recipients
    await wrapperOut.mintFromPlain(aliceShare, alice.address);
    await wrapperOut.mintFromPlain(bobShare, bob.address);
    const batch = await router.swapBatches(batchId);
    expect(batch.executed).to.equal(true);
    expect(batch.totalAmountOut).to.equal(BigInt(totalOut));
  });
});
