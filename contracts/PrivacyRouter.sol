// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/confidential-contracts/token/ConfidentialFungibleToken.sol";
import "@openzeppelin/confidential-contracts/token/extensions/ConfidentialFungibleTokenERC20Wrapper.sol";
import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
}

/// @title PrivacyRouter
/// @notice A contract for batching and executing confidential token swaps using FHE (Fully Homomorphic Encryption)
/// @dev Inherits from Ownable, ReentrancyGuard, and SepoliaConfig for configuration
contract PrivacyRouter is Ownable, ReentrancyGuard, SepoliaConfig {
    using SafeERC20 for IERC20;

    /// @notice Structure representing a swap request
    struct SwapRequest {
        address user;
        address tokenIn;
        address tokenOut;
        euint64 encryptedAmountIn;
        euint64 encryptedMinAmountOut;
        uint256 timestamp;
    }

    /// @notice Structure representing a batch of swap requests
    struct SwapBatch {
        address tokenIn;
        address tokenOut;
        uint256 totalAmountIn;
        uint256 totalAmountOut;
        uint256[] requestIds;
        bool executed;
        bool unwrapRequested;
        uint256 timestamp;
    }

    // State variables
    /// @notice Immutable Uniswap V2 Router interface
    IUniswapV2Router public immutable uniswapRouter;
    /// @notice Mapping of token addresses to their confidential wrapper contracts
    mapping(address => ConfidentialFungibleTokenERC20Wrapper) public tokenWrappers;
    /// @notice Mapping of request IDs to SwapRequest structures
    mapping(uint256 => SwapRequest) public swapRequests;
    /// @notice Mapping of batch IDs to SwapBatch structures
    mapping(uint256 => SwapBatch) public swapBatches;
    // Pending request queues per token pair (tokenIn, tokenOut) -> list of requestIds
    mapping(bytes32 => uint256[]) private pendingByPair;
    mapping(bytes32 => uint256) private pendingHeadByPair;

    /// @notice Next available request ID
    uint256 public nextRequestId;
    /// @notice Next available batch ID
    uint256 public nextBatchId;
    /// @notice Minimum number of requests required to form a batch
    uint256 public batchThreshold = 3;
    /// @notice Maximum time window for batching requests
    uint256 public batchTimeout = 10 minutes;
    /// @notice Slippage tolerance in basis points (1/100th of 1%)
    uint256 public slippageTolerance = 300; // 3% bp

    // Events
    event SwapRequestCreated(uint256 indexed requestId, address indexed user, address tokenIn, address tokenOut);
    event BatchCreated(uint256 indexed batchId, address tokenIn, address tokenOut, uint256 requestCount);
    event BatchUnwrapRequested(uint256 indexed batchId);
    event BatchExecuted(uint256 indexed batchId, uint256 amountIn, uint256 amountOut);
    event SwapCompleted(uint256 indexed requestId, address indexed user);
    event TokenWrapperRegistered(address indexed token, address indexed wrapper);

    /// @notice Constructor sets the Uniswap router address
    /// @param _uniswapRouter Address of the Uniswap V2 Router
    constructor(address _uniswapRouter) Ownable(msg.sender) SepoliaConfig() {
        uniswapRouter = IUniswapV2Router(_uniswapRouter);
    }

    /// @dev Compute a stable key for a token pair
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @return bytes32 Hash of the token pair
    function _pairKey(address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }

    /**
     * @dev Register a token wrapper for confidential operations
     * @param token ERC20 token address
     * @param wrapper Confidential wrapper contract address
     */
    function registerTokenWrapper(address token, address wrapper) external onlyOwner {
        require(wrapper != address(0), "Zero address");
        require(address(tokenWrappers[token]) == address(0), "Wrapper already registered");
        tokenWrappers[token] = ConfidentialFungibleTokenERC20Wrapper(wrapper);
        emit TokenWrapperRegistered(token, wrapper);
    }

    /// @notice Create a new confidential swap request
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param encryptedAmountInHandle Encrypted input amount handle
    /// @param amountInProof Proof for input amount decryption
    /// @param encryptedMinAmountOutHandle Encrypted minimum output amount handle
    /// @param minAmountOutProof Proof for minimum output amount decryption
    /// @return requestId ID of the created swap request
    function createSwapRequest(
        address tokenIn,
        address tokenOut,
        externalEuint64 encryptedAmountInHandle,
        bytes calldata amountInProof,
        externalEuint64 encryptedMinAmountOutHandle,
        bytes calldata minAmountOutProof
    ) external returns (uint256 requestId) {
        require(address(tokenWrappers[tokenIn]) != address(0), "Token wrapper not registered");
        require(address(tokenWrappers[tokenOut]) != address(0), "Output token wrapper not registered");

        requestId = nextRequestId++;
        euint64 amountIn = FHE.fromExternal(encryptedAmountInHandle, amountInProof);
        require(FHE.isAllowed(amountIn, address(this)), "Router not authorized for encrypted amount");
        euint64 minAmountOut = FHE.fromExternal(encryptedMinAmountOutHandle, minAmountOutProof);

        swapRequests[requestId] = SwapRequest({
            user: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            encryptedAmountIn: amountIn,
            encryptedMinAmountOut: minAmountOut,
            timestamp: block.timestamp
        });

        emit SwapRequestCreated(requestId, msg.sender, tokenIn, tokenOut);
        bytes32 key = _pairKey(tokenIn, tokenOut);
        pendingByPair[key].push(requestId);
        _checkAndCreateBatch(tokenIn, tokenOut);
    }

    /// @notice Test helper: create a swap request from plain amounts (only for testing)
    /// @dev This function should not be used in production
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param plainAmountIn Plaintext input amount
    /// @param plainMinOut Plaintext minimum output amount
    /// @return requestId ID of the created swap request
    function createSwapRequestPlain(
        address tokenIn,
        address tokenOut,
        uint64 plainAmountIn,
        uint64 plainMinOut
    ) external returns (uint256 requestId) {
        require(address(tokenWrappers[tokenIn]) != address(0), "Token wrapper not registered");
        require(address(tokenWrappers[tokenOut]) != address(0), "Output token wrapper not registered");

        requestId = nextRequestId++;
        euint64 amountIn = FHE.asEuint64(plainAmountIn);
        // grant this router contract permission to operate on the created encrypted amount
        FHE.allow(amountIn, address(this));
        euint64 minAmountOut = FHE.asEuint64(plainMinOut);
        FHE.allow(minAmountOut, address(this));

        swapRequests[requestId] = SwapRequest({
            user: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            encryptedAmountIn: amountIn,
            encryptedMinAmountOut: minAmountOut,
            timestamp: block.timestamp
        });

        emit SwapRequestCreated(requestId, msg.sender, tokenIn, tokenOut);
        bytes32 key = _pairKey(tokenIn, tokenOut);
        pendingByPair[key].push(requestId);
        _checkAndCreateBatch(tokenIn, tokenOut);
    }

    /**
     * @dev Internal function to check if a batch should be created
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     */
    function _checkAndCreateBatch(address tokenIn, address tokenOut) internal {
        uint256[] memory pendingRequests = _getPendingRequests(tokenIn, tokenOut);
        bool shouldBatch = pendingRequests.length >= batchThreshold;

        if (!shouldBatch && pendingRequests.length > 0) {
            uint256 oldestTimestamp = swapRequests[pendingRequests[0]].timestamp;
            shouldBatch = block.timestamp >= oldestTimestamp + batchTimeout;
        }

        if (shouldBatch) {
            _createBatch(tokenIn, tokenOut, pendingRequests);
        }
    }

    /**
     * @dev Get pending swap requests for a token pair
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @return uint256[] Array of pending request IDs
     */
    function _getPendingRequests(address tokenIn, address tokenOut) internal view returns (uint256[] memory) {
        bytes32 key = _pairKey(tokenIn, tokenOut);
        uint256 head = pendingHeadByPair[key];
        uint256 len = pendingByPair[key].length;
        if (len <= head) {
            return new uint256[](0);
        }

        uint256 pendingCount = len - head;
        uint256[] memory result = new uint256[](pendingCount);
        for (uint256 i = 0; i < pendingCount; i++) {
            result[i] = pendingByPair[key][head + i];
        }
        return result;
    }

    /**
     * @dev Create a batch for execution
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param requestIds Array of request IDs to include in batch
     */
    function _createBatch(address tokenIn, address tokenOut, uint256[] memory requestIds) internal {
        uint256 batchId = nextBatchId++;

        bytes32 key = _pairKey(tokenIn, tokenOut);
        pendingHeadByPair[key] += requestIds.length;
        if (pendingHeadByPair[key] >= pendingByPair[key].length) {
            delete pendingByPair[key];
            delete pendingHeadByPair[key];
        }

        swapBatches[batchId] = SwapBatch({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            totalAmountIn: 0,
            totalAmountOut: 0,
            requestIds: requestIds,
            executed: false,
            unwrapRequested: false,
            timestamp: block.timestamp
        });

        emit BatchCreated(batchId, tokenIn, tokenOut, requestIds.length);
    }

    /**
     * @dev Request unwrap of confidential tokens for a batch
     * @param batchId ID of the batch to unwrap
     */
    function requestBatchUnwrap(uint256 batchId) external nonReentrant onlyOwner {
        SwapBatch storage batch = swapBatches[batchId];
        require(!batch.executed, "Batch already executed");
        require(!batch.unwrapRequested, "Unwrap already requested");
        require(batch.requestIds.length > 0, "Empty batch");

        euint64 totalEncryptedAmount = _aggregateEncryptedAmounts(batch.requestIds);
        ConfidentialFungibleTokenERC20Wrapper wrapperIn = tokenWrappers[batch.tokenIn];
        batch.unwrapRequested = true;
        wrapperIn.unwrap(address(this), address(this), totalEncryptedAmount);
        emit BatchUnwrapRequested(batchId);
    }

    /**
     * @dev Callback for wrappers to finalize unwrap operation
     * @param batchId ID of the batch being finalized
     * @param amountReceived Amount of tokens received from unwrapping
     */
    function finalizeUnwrap(uint256 batchId, uint256 amountReceived) external {
        SwapBatch storage batch = swapBatches[batchId];
        require(batch.unwrapRequested, "Unwrap not requested");
        require(!batch.executed, "Batch already executed");
        require(msg.sender == address(tokenWrappers[batch.tokenIn]), "Only wrapper can finalize");
        require(amountReceived > 0, "No tokens received");
        batch.totalAmountIn = amountReceived;
    }

    /**
     * @dev Execute a batch swap on Uniswap
     * @param batchId ID of the batch to execute
     */
    function executeBatchSwap(uint256 batchId) external onlyOwner nonReentrant {
        SwapBatch storage batch = swapBatches[batchId];
        require(!batch.executed, "Batch already executed");
        require(batch.unwrapRequested, "Unwrap not requested");

        uint256 totalAmountIn = batch.totalAmountIn;
        batch.executed = true;
        batch.totalAmountOut = 0;

        require(totalAmountIn > 0, "No tokens finalized for unwrap");
        IERC20(batch.tokenIn).safeIncreaseAllowance(address(uniswapRouter), totalAmountIn);

        address[] memory path = new address[](2);
        path[0] = batch.tokenIn;
        path[1] = batch.tokenOut;

        uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
            totalAmountIn,
            0,
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 totalAmountOut = amounts[1];
        require(totalAmountOut > 0, "Zero output");

        ConfidentialFungibleTokenERC20Wrapper wrapperOut = tokenWrappers[batch.tokenOut];
        IERC20(batch.tokenOut).safeIncreaseAllowance(address(tokenWrappers[batch.tokenOut]), totalAmountOut);
        batch.totalAmountOut = totalAmountOut;
        batch.executed = true;
        wrapperOut.wrap(address(this), totalAmountOut);

        emit BatchExecuted(batchId, totalAmountIn, totalAmountOut);
    }

    /**
     * @dev Distribute encrypted outputs to users
     * @param batchId ID of the batch to distribute
     * @param encryptedOutputs Array of encrypted output amounts
     * @param proofs Array of decryption proofs
     */
    function distributeEncryptedOutputs(
        uint256 batchId,
        externalEuint64[] calldata encryptedOutputs,
        bytes[] calldata proofs
    ) external nonReentrant onlyOwner {
        SwapBatch storage batch = swapBatches[batchId];
        require(batch.executed, "Batch not executed");
        require(encryptedOutputs.length == batch.requestIds.length, "Length mismatch");
        require(encryptedOutputs.length == proofs.length, "Proofs length mismatch");

        ConfidentialFungibleTokenERC20Wrapper wrapperOut = tokenWrappers[batch.tokenOut];

        for (uint256 i = 0; i < batch.requestIds.length; i++) {
            uint256 requestId = batch.requestIds[i];
            SwapRequest storage request = swapRequests[requestId];
            wrapperOut.confidentialTransfer(request.user, encryptedOutputs[i], proofs[i]);
            emit SwapCompleted(requestId, request.user);
        }
    }

    /**
     * @dev Aggregate encrypted amounts from multiple requests
     * @param requestIds Array of request IDs to aggregate
     * @return euint64 Total encrypted amount
     */
    function _aggregateEncryptedAmounts(uint256[] storage requestIds) internal returns (euint64) {
        require(requestIds.length > 0, "No requests to aggregate");

        euint64 total = swapRequests[requestIds[0]].encryptedAmountIn;

        for (uint256 i = 1; i < requestIds.length; i++) {
            total = FHE.add(total, swapRequests[requestIds[i]].encryptedAmountIn);
        }

        return total;
    }

    /**
     * @dev Internal function to distribute outputs proportionally (for testing/fallback)
     * @param batchId ID of the batch to distribute
     * @param totalOutput Total output amount to distribute
     * @param decryptedAmounts Array of decrypted input amounts
     */
    function _distributeOutputs(uint256 batchId, uint256 totalOutput, uint256[] memory decryptedAmounts) internal {
        SwapBatch storage batch = swapBatches[batchId];
        require(decryptedAmounts.length == batch.requestIds.length, "Length mismatch");

        ConfidentialFungibleTokenERC20Wrapper wrapperOut = tokenWrappers[batch.tokenOut];

        uint256 sum = 0;
        for (uint256 i = 0; i < decryptedAmounts.length; i++) {
            sum += decryptedAmounts[i];
        }
        require(sum > 0, "Zero total input");

        uint256 distributed = 0;

        for (uint256 i = 0; i < batch.requestIds.length; i++) {
            uint256 requestId = batch.requestIds[i];
            SwapRequest storage request = swapRequests[requestId];
            uint256 userShare;

            if (i == batch.requestIds.length - 1) {
                userShare = totalOutput - distributed;
            } else {
                userShare = (totalOutput * decryptedAmounts[i]) / sum;
                distributed += userShare;
            }

            wrapperOut.confidentialTransfer(request.user, FHE.asEuint64(SafeCast.toUint64(userShare)));
            emit SwapCompleted(requestId, request.user);
        }
    }

    /// @notice Manually trigger batch creation for a token pair
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    function triggerBatch(address tokenIn, address tokenOut) external onlyOwner {
        uint256[] memory pendingRequests = _getPendingRequests(tokenIn, tokenOut);
        require(pendingRequests.length > 0, "No pending requests");
        _createBatch(tokenIn, tokenOut, pendingRequests);
    }

    /// @notice Update batch configuration parameters
    /// @param _batchThreshold New batch threshold value
    /// @param _batchTimeout New batch timeout value
    /// @param _slippageTolerance New slippage tolerance value
    function updateBatchParameters(
        uint256 _batchThreshold,
        uint256 _batchTimeout,
        uint256 _slippageTolerance
    ) external onlyOwner {
        batchThreshold = _batchThreshold;
        batchTimeout = _batchTimeout;
        slippageTolerance = _slippageTolerance;
    }

    /// @notice Emergency withdraw tokens from contract
    /// @param token Token address to withdraw
    /// @param amount Amount to withdraw
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Test helper: manually set batch finalized state (for testing only)
    /// @param batchId ID of the batch to modify
    /// @param amountIn Amount to set as finalized input
    function setBatchFinalized(uint256 batchId, uint256 amountIn) external onlyOwner {
        SwapBatch storage batch = swapBatches[batchId];
        require(batch.requestIds.length > 0, "Empty batch");
        batch.unwrapRequested = true;
        batch.totalAmountIn = amountIn;
    }
}
