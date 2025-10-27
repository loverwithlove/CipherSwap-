// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/confidential-contracts/token/extensions/ConfidentialFungibleTokenERC20Wrapper.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title EncryptedWBTC
 * @notice Confidential wrapper for WBTC using Zama's FHE and OpenZeppelin's confidential token extensions.
 * @dev 
 * - Extends ConfidentialFungibleTokenERC20Wrapper to wrap standard ERC20 (WBTC) into an encrypted form.
 * - Uses Fully Homomorphic Encryption (FHE) for private balances and transfers.
 * - Inherits SepoliaConfig for Zama FHEVM network parameters.
 * 
 * ### Key Points:
 * - The `PrivacyRouter` (or other designated contract) should be set as an operator to enable confidential swaps.
 * - Provides helper functions for testing (minting from plaintext or external ciphertext).
 * - **Do not use `mintFromPlain` or `mintFromExternal` in production without access control** — they bypass normal supply rules.
 */
contract EncryptedWBTC is ConfidentialFungibleTokenERC20Wrapper, SepoliaConfig {
    using SafeERC20 for IERC20;

    /**
     * @notice Deploys the confidential wrapper for WBTC.
     * @param _underlying Address of the ERC20 token to wrap (e.g., WBTC).
     * 
     * @dev
     * - Initializes the ConfidentialFungibleToken base with default metadata.
     * - Sets the Sepolia FHE config.
     */
    constructor(IERC20 _underlying)
        ConfidentialFungibleToken("Encrypted WBTC", "EWBTC", "")
        ConfidentialFungibleTokenERC20Wrapper(_underlying)
        SepoliaConfig()
    {}

    /**
     * @notice Mints encrypted tokens from an external encrypted input.
     * @dev 
     * - Converts an externally encrypted `uint64` into an internal `euint64` using FHE.
     * - Intended for **testing/demo only**.
     * - Must be restricted in production (e.g., onlyOwner).
     * 
     * @param encryptedAmount External encrypted amount (ciphertext).
     * @param inputProof Zama FHE input proof verifying the ciphertext.
     * @param to Recipient of the minted confidential tokens.
     */
    function mintFromExternal(
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        address to
    ) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _mint(to, amount);
    }

    /**
     * @notice Mints confidential tokens from a plaintext amount.
     * @dev 
     * - Wraps a `uint64` into an encrypted `euint64` using `FHE.asEuint64`.
     * - Useful for testing without external ciphertexts.
     * - Must be restricted in production (e.g., onlyOwner).
     * 
     * @param plainAmount The plaintext amount to mint.
     * @param to Recipient of the minted confidential tokens.
     */
    function mintFromPlain(uint64 plainAmount, address to) external {
        _mint(to, FHE.asEuint64(plainAmount));
    }

    /**
     * @notice Confidential transfer using a plaintext amount.
     * @dev 
     * - Converts the plaintext `uint64` into an encrypted `euint64`.
     * - Calls `confidentialTransfer` under the hood.
     * - Primarily for testing convenience.
     * 
     * @param to Recipient of the transfer.
     * @param plainAmount Plaintext amount to be transferred (wrapped inside FHE).
     */
    function confidentialTransferPlain(address to, uint64 plainAmount) external {
        confidentialTransfer(to, FHE.asEuint64(plainAmount));
    }
}
