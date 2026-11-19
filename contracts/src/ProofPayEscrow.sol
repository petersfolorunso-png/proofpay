// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ProofPayEscrow
/// @notice Proof-of-work escrow for tUSD8 on QDay Aevum Testnet.
///         A client locks tUSD8 for a payee against a plain-language brief (stored off-chain, committed
///         on-chain as `briefHash`). The payee submits a public proof URL. A narrowly-scoped AI verifier
///         ("agent") may then release the funds to the payee or reject the proof. The client can always
///         approve manually, and gets a refund if no accepted proof arrives before the deadline.
/// @dev Safety model:
///      - The agent can only move funds that are already locked, only to the payee/client fixed at
///        creation, and only for amounts <= `agentReleaseCap`. It can never change payee or amount.
///      - Every exit (release / refund) is single-shot: status is set before the external transfer
///        (checks-effects-interactions) and all value-moving functions are `nonReentrant`.
///      - The owner can pause agent actions and rotate/revoke the agent key (human override). Pausing does
///        NOT block clients from approving or reclaiming expired funds, so funds can never be frozen.
contract ProofPayEscrow is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    enum Status {
        None, // 0: job does not exist
        Created, // 1: created, not yet funded
        Funded, // 2: tUSD8 locked, waiting for proof
        ProofSubmitted, // 3: proof URL submitted, waiting for verdict
        Released, // 4: paid to payee (final)
        Refunded, // 5: returned to client (final)
        Cancelled // 6: cancelled before funding (final)
    }

    struct Job {
        address client;
        address payee;
        uint96 amount; // token base units (tUSD8 has 6 decimals)
        uint64 deadline; // unix seconds; proofs must be submitted before this
        uint64 proofSubmittedAt;
        uint8 rejections;
        Status status;
        bytes32 briefHash; // keccak256 of the canonical off-chain brief JSON
        bytes32 proofHash; // keccak256 of the submitted proof URL
        bytes32 verdictHash; // keccak256 of the agent's (or client's) verdict / receipt JSON
    }

    IERC20 public immutable token;

    /// @notice Address allowed to release/reject on the AI verifier's behalf. address(0) disables it.
    address public agent;
    /// @notice Max amount (base units) the agent may auto-release for a single job. Larger jobs need the client.
    uint96 public agentReleaseCap;
    /// @notice Max amount (base units) any single job may lock.
    uint96 public maxJobAmount;
    /// @notice Time the agent has to review a proof that arrived just before the deadline.
    uint64 public constant REVIEW_GRACE = 1 days;
    uint64 public constant MIN_DURATION = 5 minutes;
    uint64 public constant MAX_DURATION = 90 days;
    uint8 public constant MAX_REJECTIONS = 3;
    uint256 public constant MAX_PROOF_URL_LENGTH = 512;

    uint256 public jobCount;
    mapping(uint256 => Job) private _jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed payee,
        uint256 amount,
        uint64 deadline,
        bytes32 briefHash
    );
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event JobCancelled(uint256 indexed jobId);
    event ProofSubmitted(uint256 indexed jobId, address indexed payee, string proofUrl, bytes32 proofHash);
    event ProofRejected(uint256 indexed jobId, address indexed by, uint8 rejections, bytes32 verdictHash);
    event Released(uint256 indexed jobId, address indexed by, address indexed payee, uint256 amount, bytes32 verdictHash);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event LimitsUpdated(uint96 agentReleaseCap, uint96 maxJobAmount);

    error ZeroAddress();
    error InvalidAmount();
    error AmountAboveMax();
    error InvalidDeadline();
    error InvalidPayee();
    error NotClient();
    error NotPayee();
    error NotAgent();
    error BadStatus(Status current);
    error DeadlinePassed();
    error NotRefundableYet();
    error AboveAgentCap();
    error InvalidProof();
    error InvalidLimits();

    modifier onlyAgent() {
        if (msg.sender != agent || agent == address(0)) revert NotAgent();
        _;
    }

    constructor(IERC20 token_, address owner_, address agent_, uint96 agentReleaseCap_, uint96 maxJobAmount_)
        Ownable(owner_)
    {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (agentReleaseCap_ > maxJobAmount_ || maxJobAmount_ == 0) revert InvalidLimits();
        token = token_;
        agent = agent_;
        agentReleaseCap = agentReleaseCap_;
        maxJobAmount = maxJobAmount_;
        emit AgentUpdated(address(0), agent_);
        emit LimitsUpdated(agentReleaseCap_, maxJobAmount_);
    }

    // ---------------------------------------------------------------- client

    /// @notice Create a job without funding it (two-step flow).
    function createJob(address payee, uint96 amount, uint64 deadline, bytes32 briefHash)
        public
        returns (uint256 jobId)
    {
        if (payee == address(0) || payee == msg.sender || payee == address(this)) revert InvalidPayee();
        if (amount == 0) revert InvalidAmount();
        if (amount > maxJobAmount) revert AmountAboveMax();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) {
            revert InvalidDeadline();
        }
        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        j.client = msg.sender;
        j.payee = payee;
        j.amount = amount;
        j.deadline = deadline;
        j.briefHash = briefHash;
        j.status = Status.Created;
        emit JobCreated(jobId, msg.sender, payee, amount, deadline, briefHash);
    }

    /// @notice Lock the job amount in escrow. Requires prior `approve` on the token.
    function fundJob(uint256 jobId) public nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (j.status != Status.Created) revert BadStatus(j.status);
        if (block.timestamp >= j.deadline) revert DeadlinePassed();
        j.status = Status.Funded;
        // Pull exact amount and verify the escrow actually received it (defends against fee-on-transfer tokens).
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), j.amount);
        if (token.balanceOf(address(this)) - beforeBal != j.amount) revert InvalidAmount();
        emit JobFunded(jobId, j.amount);
    }

    /// @notice Create and fund in one transaction.
    function createAndFund(address payee, uint96 amount, uint64 deadline, bytes32 briefHash)
        external
        returns (uint256 jobId)
    {
        jobId = createJob(payee, amount, deadline, briefHash);
        fundJob(jobId);
    }

    /// @notice Cancel a job that was never funded.
    function cancelJob(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (j.status != Status.Created) revert BadStatus(j.status);
        j.status = Status.Cancelled;
        emit JobCancelled(jobId);
    }

    /// @notice Human override: the client can always approve and pay the payee (no cap, works while paused).
    function approveRelease(uint256 jobId, bytes32 verdictHash) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (j.status != Status.Funded && j.status != Status.ProofSubmitted) revert BadStatus(j.status);
        _release(jobId, j, verdictHash);
    }

    /// @notice Client reclaims funds when: (a) the deadline passed with no proof pending, (b) a pending proof
    ///         was not reviewed within REVIEW_GRACE after the deadline, or (c) the proof was rejected and
    ///         the client chooses to cancel instead of waiting for a resubmission.
    function refund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (!refundable(jobId)) revert NotRefundableYet();
        j.status = Status.Refunded;
        uint256 amount = j.amount;
        emit Refunded(jobId, j.client, amount);
        token.safeTransfer(j.client, amount);
    }

    // ----------------------------------------------------------------- payee

    /// @notice Payee submits a public proof URL before the deadline. Can resubmit after a rejection.
    function submitProof(uint256 jobId, string calldata proofUrl) external {
        Job storage j = _jobs[jobId];
        if (j.payee != msg.sender) revert NotPayee();
        if (j.status != Status.Funded) revert BadStatus(j.status);
        if (block.timestamp >= j.deadline) revert DeadlinePassed();
        uint256 len = bytes(proofUrl).length;
        if (len == 0 || len > MAX_PROOF_URL_LENGTH) revert InvalidProof();
        bytes32 h = keccak256(bytes(proofUrl));
        j.proofHash = h;
        j.proofSubmittedAt = uint64(block.timestamp);
        j.status = Status.ProofSubmitted;
        emit ProofSubmitted(jobId, msg.sender, proofUrl, h);
    }

    // ----------------------------------------------------------------- agent

    /// @notice AI verifier accepts the proof and pays the payee. Bounded by `agentReleaseCap`.
    function agentRelease(uint256 jobId, bytes32 proofHash, bytes32 verdictHash)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
    {
        Job storage j = _jobs[jobId];
        if (j.status != Status.ProofSubmitted) revert BadStatus(j.status);
        // Bind the verdict to the exact proof the agent reviewed (prevents racing a swapped proof).
        if (j.proofHash != proofHash) revert InvalidProof();
        if (j.amount > agentReleaseCap) revert AboveAgentCap();
        _release(jobId, j, verdictHash);
    }

    /// @notice AI verifier rejects the proof. The payee may resubmit before the deadline; after
    ///         MAX_REJECTIONS the job is refunded to the client automatically.
    function agentReject(uint256 jobId, bytes32 proofHash, bytes32 verdictHash)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
    {
        Job storage j = _jobs[jobId];
        if (j.status != Status.ProofSubmitted) revert BadStatus(j.status);
        if (j.proofHash != proofHash) revert InvalidProof();
        unchecked {
            j.rejections += 1;
        }
        j.verdictHash = verdictHash;
        emit ProofRejected(jobId, msg.sender, j.rejections, verdictHash);
        if (j.rejections >= MAX_REJECTIONS) {
            j.status = Status.Refunded;
            uint256 amount = j.amount;
            emit Refunded(jobId, j.client, amount);
            token.safeTransfer(j.client, amount);
        } else {
            j.status = Status.Funded;
        }
    }

    // ----------------------------------------------------------------- owner

    function setAgent(address newAgent) external onlyOwner {
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    function setLimits(uint96 agentReleaseCap_, uint96 maxJobAmount_) external onlyOwner {
        if (agentReleaseCap_ > maxJobAmount_ || maxJobAmount_ == 0) revert InvalidLimits();
        agentReleaseCap = agentReleaseCap_;
        maxJobAmount = maxJobAmount_;
        emit LimitsUpdated(agentReleaseCap_, maxJobAmount_);
    }

    /// @notice Emergency stop for agent actions only. Clients keep approve/refund.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ views

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function refundable(uint256 jobId) public view returns (bool) {
        Job storage j = _jobs[jobId];
        if (j.status == Status.Funded) {
            return block.timestamp >= j.deadline || j.rejections > 0;
        }
        if (j.status == Status.ProofSubmitted) {
            return block.timestamp >= uint256(j.deadline) + REVIEW_GRACE;
        }
        return false;
    }

    // --------------------------------------------------------------- internal

    function _release(uint256 jobId, Job storage j, bytes32 verdictHash) private {
        j.status = Status.Released; // effects before interaction: no double release
        j.verdictHash = verdictHash;
        uint256 amount = j.amount;
        address payee = j.payee;
        emit Released(jobId, msg.sender, payee, amount, verdictHash);
        token.safeTransfer(payee, amount);
    }
}
