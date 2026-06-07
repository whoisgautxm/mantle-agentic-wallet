// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain price reference: MNT wei per 1 whole token (1e18 token units).
interface IPriceOracle {
    function priceWei() external view returns (uint256);
}

/// @title AgentVault
/// @notice Holds funds an AI agent may spend on-chain under hard limits.
///         Every action is recorded on-chain via AgentDecision for the hackathon benchmark.
contract AgentVault {
    address public owner;            // human owner
    address public agent;            // the AI agent's key (session key)
    uint256 public spendLimitPerTx;  // max wei per single action
    uint256 public dailyLimit;       // max wei spent per rolling 24h window
    uint256 public spentToday;       // wei spent in the current window
    uint256 public windowStart;      // unix ts when the current window began
    bool public paused;              // owner kill switch
    uint256 public nonce;            // increments per executed decision
    uint256 private executionLock = 1;

    mapping(address => bool) public allowedTarget;
    mapping(address => bool) public guardedTarget;

    // Optional on-chain oracle binding for guarded trades. When priceOracle is unset (address(0)),
    // executeGuarded falls back to the caller-declared floor only.
    address public priceOracle;            // IPriceOracle: MNT wei per 1e18 token
    address public tradedToken;            // the ERC20 priced by the oracle
    uint256 public maxOracleDeviationBps;  // how far below oracle-fair the declared minOut may sit

    event AgentDecision(
        uint256 indexed nonce,
        address indexed target,
        uint256 value,
        bytes data,
        string rationale
    );
    event AgentGuardedDecision(
        uint256 indexed nonce,
        address indexed target,
        address indexed outAsset,
        uint256 minOut,
        uint256 received
    );
    event Deposited(address indexed from, uint256 amount);
    event TargetAllowed(address indexed target, bool allowed);
    event GuardedTargetSet(address indexed target, bool required);
    event OracleSet(address indexed oracle, address indexed token, uint256 maxDeviationBps);
    event PausedSet(bool paused);
    event AgentSet(address indexed agent);
    event LimitsSet(uint256 spendLimitPerTx, uint256 dailyLimit);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroMinOutput();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error NativeOutputWithValueUnsupported();
    error AssetBalanceReadFailed(address asset);
    error GuardedExecutionRequired(address target);
    error OracleFloorTooLow(uint256 minOut, uint256 floor);
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }
    modifier nonReentrant() {
        if (executionLock != 1) revert Reentrancy();
        executionLock = 2;
        _;
        executionLock = 1;
    }

    constructor(address _agent, uint256 _spendLimitPerTx, uint256 _dailyLimit) {
        if (_agent == address(0)) revert ZeroAddress();
        owner = msg.sender;
        agent = _agent;
        spendLimitPerTx = _spendLimitPerTx;
        dailyLimit = _dailyLimit;
        windowStart = block.timestamp;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function setAllowedTarget(address t, bool ok) external onlyOwner {
        allowedTarget[t] = ok;
        emit TargetAllowed(t, ok);
    }

    function setGuardedTarget(address target, bool required) external onlyOwner {
        guardedTarget[target] = required;
        emit GuardedTargetSet(target, required);
    }

    /// @notice Bind guarded trades to an on-chain oracle. Pass oracle == address(0) to disable.
    /// @param maxDevBps how far below the oracle-fair output the declared minOut may sit (bps).
    function setOracle(address oracle, address token, uint256 maxDevBps) external onlyOwner {
        require(maxDevBps <= 10_000, "dev too high");
        if (oracle != address(0)) require(token != address(0), "token required");
        priceOracle = oracle;
        tradedToken = token;
        maxOracleDeviationBps = maxDevBps;
        emit OracleSet(oracle, token, maxDevBps);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        agent = _agent;
        emit AgentSet(_agent);
    }

    function setLimits(uint256 _spendLimitPerTx, uint256 _dailyLimit) external onlyOwner {
        spendLimitPerTx = _spendLimitPerTx;
        dailyLimit = _dailyLimit;
        emit LimitsSet(_spendLimitPerTx, _dailyLimit);
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    /// @notice The agent executes one decision against an allowed target.
    function execute(address target, uint256 value, bytes calldata data, string calldata rationale)
        external
        onlyAgent
        nonReentrant
        returns (bytes memory)
    {
        if (guardedTarget[target]) revert GuardedExecutionRequired(target);
        _validateAndAccount(target, value);

        emit AgentDecision(nonce, target, value, data, rationale);
        nonce += 1;

        (bool success, bytes memory ret) = target.call{value: value}(data);
        require(success, "call failed");
        return ret;
    }

    /// @notice Execute an allowlisted call and require a minimum received asset balance delta.
    /// @dev Native output is supported only when value is zero, which covers token-to-MNT sells.
    function executeGuarded(
        address target,
        uint256 value,
        bytes calldata data,
        address outAsset,
        uint256 minOut,
        string calldata rationale
    ) external onlyAgent nonReentrant returns (bytes memory) {
        if (minOut == 0) revert ZeroMinOutput();
        if (outAsset == address(0) && value != 0) revert NativeOutputWithValueUnsupported();
        _validateAndAccount(target, value);

        uint256 beforeBalance = _assetBalance(outAsset);
        // For sells we measure how much of the traded token left the vault, to derive a fair floor.
        uint256 tradedBefore = priceOracle != address(0) ? _assetBalance(tradedToken) : 0;
        (bool success, bytes memory ret) = target.call{value: value}(data);
        require(success, "call failed");
        uint256 afterBalance = _assetBalance(outAsset);
        uint256 received = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
        if (received < minOut) revert InsufficientOutput(received, minOut);
        if (priceOracle != address(0)) _enforceOracleFloor(value, outAsset, minOut, tradedBefore);

        emit AgentDecision(nonce, target, value, data, rationale);
        emit AgentGuardedDecision(nonce, target, outAsset, minOut, received);
        nonce += 1;
        return ret;
    }

    function _validateAndAccount(address target, uint256 value) internal {
        require(!paused, "paused");
        require(allowedTarget[target], "target not allowed");
        require(value <= spendLimitPerTx, "over per-tx limit");
        _rollWindow();
        require(spentToday + value <= dailyLimit, "over daily limit");
        spentToday += value;
    }

    /// @dev Require the caller's declared minOut to be at least the oracle-fair output minus tolerance.
    ///      Combined with `received >= minOut`, this bounds actual output to oracle-fair even if the
    ///      agent key is compromised and tries to declare an unreasonably low (but positive) floor.
    function _enforceOracleFloor(uint256 value, address outAsset, uint256 minOut, uint256 tradedBefore)
        internal
        view
    {
        uint256 oraclePrice = IPriceOracle(priceOracle).priceWei();
        require(oraclePrice > 0, "oracle price=0");

        uint256 expectedOut;
        if (value > 0) {
            // BUY: native MNT in -> traded token out.
            require(outAsset == tradedToken, "guarded buy outAsset mismatch");
            expectedOut = (value * 1e18) / oraclePrice;
        } else {
            // SELL: traded token in (measured) -> native MNT out.
            require(outAsset == address(0), "guarded sell must output native");
            uint256 tradedAfter = _assetBalance(tradedToken);
            uint256 tokensIn = tradedBefore > tradedAfter ? tradedBefore - tradedAfter : 0;
            require(tokensIn > 0, "no traded-token input");
            expectedOut = (tokensIn * oraclePrice) / 1e18;
        }

        uint256 floor = (expectedOut * (10_000 - maxOracleDeviationBps)) / 10_000;
        if (minOut < floor) revert OracleFloorTooLow(minOut, floor);
    }

    function _assetBalance(address asset) internal view returns (uint256) {
        if (asset == address(0)) return address(this).balance;
        (bool success, bytes memory result) =
            asset.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!success || result.length < 32) revert AssetBalanceReadFailed(asset);
        return abi.decode(result, (uint256));
    }

    function _rollWindow() internal {
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentToday = 0;
        }
    }
}
