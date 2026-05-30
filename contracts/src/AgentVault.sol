// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

    mapping(address => bool) public allowedTarget;

    event AgentDecision(
        uint256 indexed nonce,
        address indexed target,
        uint256 value,
        bytes data,
        string rationale
    );
    event Deposited(address indexed from, uint256 amount);
    event TargetAllowed(address indexed target, bool allowed);
    event PausedSet(bool paused);
    event AgentSet(address indexed agent);
    event LimitsSet(uint256 spendLimitPerTx, uint256 dailyLimit);

    error NotOwner();
    error NotAgent();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
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
        returns (bytes memory)
    {
        require(!paused, "paused");
        require(allowedTarget[target], "target not allowed");
        require(value <= spendLimitPerTx, "over per-tx limit");

        _rollWindow();
        require(spentToday + value <= dailyLimit, "over daily limit");
        spentToday += value;

        emit AgentDecision(nonce, target, value, data, rationale);
        nonce += 1;

        (bool success, bytes memory ret) = target.call{value: value}(data);
        require(success, "call failed");
        return ret;
    }

    function _rollWindow() internal {
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentToday = 0;
        }
    }
}
