import { ethers } from "hardhat";
import { expect } from "chai";

describe("PrivacyRouter unit tests", function () {
  it("registers token wrappers and prevents double registration", async function () {
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapper = await EncryptedWBTC.deploy(wbtc);
    await wrapper.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const wrapperAddr = await wrapper.getAddress();

    await router.registerTokenWrapper(wbtcAddr, wrapperAddr);
    expect(await router.tokenWrappers(wbtcAddr)).to.equal(wrapperAddr);
    await expect(router.registerTokenWrapper(wbtcAddr, wrapperAddr)).to.be.revertedWith("Wrapper already registered");
  });



  it("creates plain swap requests and triggers batch", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapperIn = await EncryptedWBTC.deploy(wbtc);
    await wrapperIn.waitForDeployment();
    const wrapperOut = await EncryptedWBTC.deploy(tokenOut);
    await wrapperOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();
    const wrapperInAddr = await wrapperIn.getAddress();
    const wrapperOutAddr = await wrapperOut.getAddress();

    await router.registerTokenWrapper(wbtcAddr, wrapperInAddr);
    await router.registerTokenWrapper(tokenOutAddr, wrapperOutAddr);

    const routerAddr = await router.getAddress();
    await wrapperIn.mintFromPlain(100, routerAddr);
    await wrapperIn.mintFromPlain(200, routerAddr);
    await router.connect(alice).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 100, 0);
    await router.connect(bob).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 200, 0);
    await router.triggerBatch(wbtcAddr, tokenOutAddr);

    const nextRequestId = await router.nextRequestId();
    const nextBatchId = await router.nextBatchId();
    expect(Number(nextRequestId)).to.equal(2);
    expect(Number(nextBatchId)).to.equal(1);

    const batch = await router.swapBatches(0);
    expect(batch.tokenIn).to.equal(wbtcAddr);
    expect(batch.tokenOut).to.equal(tokenOutAddr);
  });



  it("executes a finalized batch swap", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapperIn = await EncryptedWBTC.deploy(wbtc);
    await wrapperIn.waitForDeployment();
    const wrapperOut = await EncryptedWBTC.deploy(tokenOut);
    await wrapperOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();
    await mockRouter.setRate(1, 1);

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();
    const wrapperInAddr = await wrapperIn.getAddress();
    const wrapperOutAddr = await wrapperOut.getAddress();

    await router.registerTokenWrapper(wbtcAddr, wrapperInAddr);
    await router.registerTokenWrapper(tokenOutAddr, wrapperOutAddr);
    const routerAddr = await router.getAddress();

    await wrapperIn.mintFromPlain(100, routerAddr);
    await wrapperIn.mintFromPlain(200, routerAddr);
    await router.connect(alice).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 100, 0);
    await router.connect(bob).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 200, 0);
    await router.triggerBatch(wbtcAddr, tokenOutAddr);

    const batchId = 0;
    const totalIn = 300;
    const routerTestHelpers = router as unknown as {
      setBatchFinalized(batchId: number, amountIn: number): Promise<unknown>;
    };
    await routerTestHelpers.setBatchFinalized(batchId, totalIn);
    await wbtc.transfer(routerAddr, totalIn);

    const mockRouterAddr = await mockRouter.getAddress();
    await tokenOut.transfer(mockRouterAddr, totalIn);
    await router.executeBatchSwap(batchId);

    const batch = await router.swapBatches(batchId);
    expect(batch.executed).to.equal(true);
    expect(batch.totalAmountOut).to.equal(totalIn);
  });



  it("finalizeUnwrap may only be called by the registered wrapper", async function () {
    const [, alice, bob, other] = await ethers.getSigners();
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapperIn = await EncryptedWBTC.deploy(wbtc);
    await wrapperIn.waitForDeployment();
    const wrapperOut = await EncryptedWBTC.deploy(tokenOut);
    await wrapperOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();
    const wrapperInAddr = await wrapperIn.getAddress();
    const wrapperOutAddr = await wrapperOut.getAddress();

    await router.registerTokenWrapper(wbtcAddr, wrapperInAddr);
    await router.registerTokenWrapper(tokenOutAddr, wrapperOutAddr);

    // mint balances to router
    const routerAddr = await router.getAddress();
    await wrapperIn.mintFromPlain(100, routerAddr);
    await wrapperIn.mintFromPlain(200, routerAddr);
    await router.connect(alice).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 100, 0);
    await router.connect(bob).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 200, 0);
    await router.triggerBatch(wbtcAddr, tokenOutAddr);

    const batchId = 0;
    // mark batch finalized
    const routerTestHelpers = router as unknown as {
      setBatchFinalized(batchId: number, amountIn: number): Promise<unknown>;
    };
    await routerTestHelpers.setBatchFinalized(batchId, 300);

    // should revert when called by non-wrapper
    await expect(router.connect(other).finalizeUnwrap(batchId, 300)).to.be.revertedWith("Only wrapper can finalize");
  });



  it("executeBatchSwap reverts when unwrap not requested", async function () {
    const [, alice, _bob] = await ethers.getSigners();

    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const EncryptedWBTC = await ethers.getContractFactory("EncryptedWBTC");
    const wrapperIn = await EncryptedWBTC.deploy(wbtc);
    await wrapperIn.waitForDeployment();
    const wrapperOut = await EncryptedWBTC.deploy(tokenOut);
    await wrapperOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();
    const wrapperInAddr = await wrapperIn.getAddress();
    const wrapperOutAddr = await wrapperOut.getAddress();

    await router.registerTokenWrapper(wbtcAddr, wrapperInAddr);
    await router.registerTokenWrapper(tokenOutAddr, wrapperOutAddr);

    const routerAddr = await router.getAddress();
    await wrapperIn.mintFromPlain(100, routerAddr);
    await router.connect(alice).createSwapRequestPlain(wbtcAddr, tokenOutAddr, 100, 0);
    await router.triggerBatch(wbtcAddr, tokenOutAddr);
    const batchId = 0;
    await expect(router.executeBatchSwap(batchId)).to.be.revertedWith("Unwrap not requested");
  });


  
  it("triggerBatch reverts when no pending requests", async function () {
    const [_owner] = await ethers.getSigners();
    const WBTC = await ethers.getContractFactory("WBTC");
    const wbtc = await WBTC.deploy(ethers.parseUnits("1000000", 8));
    await wbtc.waitForDeployment();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const wbtcAddr = await wbtc.getAddress();
    const tokenOutAddr = await tokenOut.getAddress();

    await expect(router.triggerBatch(wbtcAddr, tokenOutAddr)).to.be.revertedWith("No pending requests");
  });



  it("emergencyWithdraw transfers tokens to owner", async function () {
    const [owner] = await ethers.getSigners();

    const TokenOut = await ethers.getContractFactory("TokenMock");
    const tokenOut = await TokenOut.deploy("TokenOut", "TOUT", ethers.parseUnits("1000000", 8));
    await tokenOut.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const PrivacyRouter = await ethers.getContractFactory("PrivacyRouter");
    const router = await PrivacyRouter.deploy(mockRouter.target);
    await router.waitForDeployment();

    const routerAddr = await router.getAddress();
    const ownerAddr = await owner.getAddress();
    const amount = ethers.parseUnits("123", 8);
    await tokenOut.transfer(routerAddr, amount);

    const before = await tokenOut.balanceOf(ownerAddr);
    await router.emergencyWithdraw(await tokenOut.getAddress(), amount);
    const after = await tokenOut.balanceOf(ownerAddr);

    expect(after - before).to.equal(amount);
  });
});
