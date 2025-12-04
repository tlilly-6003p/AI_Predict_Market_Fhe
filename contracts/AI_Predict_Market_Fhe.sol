pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract AIPredictMarketFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool isOpen;
        uint256 totalEncryptedScore;
        uint256 submissionCount;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct Prediction {
        address predictor;
        euint32 encryptedScore; // Encrypted score predicted by the user
        uint256 amount; // Amount staked on this prediction
    }
    mapping(uint256 => mapping(address => Prediction)) public predictions; // batchId -> predictor -> Prediction

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSet(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PredictionSubmitted(uint256 indexed batchId, address indexed predictor, uint256 amount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 actualScore, uint256 totalEncryptedScore, uint256 winnerCount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionRateLimited() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier decryptionRequestRateLimited() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        emit CooldownSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyProvider whenNotPaused {
        currentBatchId++;
        batches[currentBatchId].isOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyProvider whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitPrediction(
        uint256 batchId,
        euint32 encryptedScore,
        uint256 amount
    ) external payable whenNotPaused submissionRateLimited {
        if (!batches[batchId].isOpen) revert BatchClosed();
        if (msg.value != amount) revert("Value_Mismatch");
        if (predictions[batchId][msg.sender].amount > 0) {
            revert("Already_Predicted_In_Batch"); // One prediction per address per batch
        }

        // Initialize encryptedScore if it's not already initialized
        _initIfNeeded(encryptedScore);

        predictions[batchId][msg.sender] = Prediction({
            predictor: msg.sender,
            encryptedScore: encryptedScore,
            amount: amount
        });
        batches[batchId].totalEncryptedScore = batches[batchId].totalEncryptedScore + amount;
        batches[batchId].submissionCount++;

        emit PredictionSubmitted(batchId, msg.sender, amount);
    }

    function requestBatchEvaluation(uint256 batchId)
        external
        onlyProvider
        whenNotPaused
        decryptionRequestRateLimited
    {
        if (batches[batchId].isOpen) revert BatchNotClosed();

        euint32 actualEncryptedScore = _getActualEncryptedScore(batchId); // Placeholder for actual FHE evaluation logic
        _initIfNeeded(actualEncryptedScore);

        // 1. Prepare Ciphertexts: actualEncryptedScore
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(actualEncryptedScore);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // 5a. Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // 5b. State Verification
        // Rebuild cts in the exact same order as in requestBatchEvaluation
        // For this contract, it's just the actualEncryptedScore.
        // We need to get it from storage. This assumes actualEncryptedScore for a batch is stored.
        // For simplicity, let's assume it's stored in a mapping `batchActualEncryptedScores`
        // In a real contract, this would be fetched from where it was stored.
        // For this example, we'll simulate it by re-calculating it (not ideal, but for demo).
        // A better approach: store the ciphertexts that were sent for decryption.
        // Here, we'll assume `batches[decryptionContexts[requestId].batchId].actualEncryptedScore` exists.
        // For this contract, we don't store it, so this part is illustrative.
        // The key is that the *same* ciphertexts must be used to re-calculate the hash.

        // Let's assume the ciphertext was the `actualEncryptedScore` for the batch.
        // We need to retrieve it. If it's not stored, this verification cannot be done properly.
        // For the purpose of this example, we'll assume it's available.
        // This is a simplification. A robust contract would store the exact ciphertexts.
        // For now, we'll use a placeholder:
        euint32 actualEncryptedScoreForBatch = _getActualEncryptedScore(decryptionContexts[requestId].batchId);


        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(actualEncryptedScoreForBatch);
        bytes32 currentHash = _hashCiphertexts(currentCts);

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // 5d. Decode & Finalize
        uint256 actualScore = abi.decode(cleartexts, (uint256)); // Decode the single cleartext value

        uint256 batchId = decryptionContexts[requestId].batchId;
        uint256 totalStaked = batches[batchId].totalEncryptedScore;
        uint256 winnerCount = _determineWinners(batchId, actualScore);

        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(requestId, batchId, actualScore, totalStaked, winnerCount);
        // Further logic for distributing rewards, etc. would go here
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!FHE.isInitialized(value)) {
            FHE.asEuint32(0); // Initialize with a dummy value if not already initialized
        }
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!FHE.isInitialized(value)) {
            revert NotInitialized();
        }
    }

    // Placeholder for actual FHE evaluation logic
    // In a real contract, this would involve FHE operations on encrypted data
    // For this example, it returns a dummy encrypted score
    function _getActualEncryptedScore(uint256 batchId) internal view returns (euint32) {
        // This is a placeholder. The actual score would come from an FHE evaluation
        // on encrypted test data. For this contract, we return a fixed dummy value.
        // The key is that it's an euint32.
        euint32 dummyScore = FHE.asEuint32(0); // Represents an encrypted score
        return dummyScore;
    }

    // Placeholder for determining winners
    // This would compare the `actualScore` with user predictions
    function _determineWinners(uint256 batchId, uint256 actualScore) internal view returns (uint256 winnerCount) {
        // This is a placeholder. Actual logic would iterate through predictions
        // and compare `actualScore` with decrypted user predictions (if they were decrypted)
        // or compare encrypted predictions with encrypted actual score using FHE (more complex).
        // For this contract, we return a dummy count.
        return 1; // Dummy winner count
    }
}