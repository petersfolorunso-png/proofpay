// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProofPayEscrow} from "../src/ProofPayEscrow.sol";
import {MockUSD, ReentrantToken, FeeToken} from "./mocks/Mocks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ProofPayEscrowTest is Test {
    ProofPayEscrow esc;
    MockUSD usd;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address client = makeAddr("client");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    uint96 constant AMT = 50e6; // 50 tUSD8
    uint96 constant CAP = 100e6;
    uint96 constant MAX = 1_000e6;
    bytes32 constant BRIEF = keccak256("brief");
    bytes32 constant VERDICT = keccak256("verdict");
    string constant URL = "https://x.com/ada/status/123";
    bytes32 PROOF = keccak256(bytes(URL));

    function setUp() public {
        usd = new MockUSD();
        esc = new ProofPayEscrow(IERC20(address(usd)), owner, agent, CAP, MAX);
        usd.mint(client, 10_000e6);
        vm.prank(client);
        usd.approve(address(esc), type(uint256).max);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 3 days);
    }

    function _funded() internal returns (uint256 id) {
        vm.prank(client);
        id = esc.createAndFund(payee, AMT, _deadline(), BRIEF);
    }

    function _withProof() internal returns (uint256 id) {
        id = _funded();
        vm.prank(payee);
        esc.submitProof(id, URL);
    }

    // ------------------------------------------------------------ create / fund

    function test_constructor() public view {
        assertEq(address(esc.token()), address(usd));
        assertEq(esc.owner(), owner);
        assertEq(esc.agent(), agent);
        assertEq(esc.agentReleaseCap(), CAP);
        assertEq(esc.maxJobAmount(), MAX);
    }

    function test_constructor_rejectsBadLimits() public {
        vm.expectRevert(ProofPayEscrow.InvalidLimits.selector);
        new ProofPayEscrow(IERC20(address(usd)), owner, agent, MAX + 1, MAX);
        vm.expectRevert(ProofPayEscrow.ZeroAddress.selector);
        new ProofPayEscrow(IERC20(address(0)), owner, agent, CAP, MAX);
    }

    function test_createThenFund() public {
        vm.startPrank(client);
        uint256 id = esc.createJob(payee, AMT, _deadline(), BRIEF);
        assertEq(id, 1);
        assertEq(uint8(esc.getJob(id).status), uint8(ProofPayEscrow.Status.Created));
        assertEq(usd.balanceOf(address(esc)), 0);
        esc.fundJob(id);
        vm.stopPrank();
        ProofPayEscrow.Job memory j = esc.getJob(id);
        assertEq(uint8(j.status), uint8(ProofPayEscrow.Status.Funded));
        assertEq(j.client, client);
        assertEq(j.payee, payee);
        assertEq(j.amount, AMT);
        assertEq(j.briefHash, BRIEF);
        assertEq(usd.balanceOf(address(esc)), AMT);
    }

    function test_createAndFund_emits() public {
        uint64 d = _deadline();
        vm.expectEmit(true, true, true, true);
        emit ProofPayEscrow.JobCreated(1, client, payee, AMT, d, BRIEF);
        vm.expectEmit(true, false, false, true);
        emit ProofPayEscrow.JobFunded(1, AMT);
        vm.prank(client);
        esc.createAndFund(payee, AMT, d, BRIEF);
    }

    function test_create_validation() public {
        vm.startPrank(client);
        vm.expectRevert(ProofPayEscrow.InvalidPayee.selector);
        esc.createJob(address(0), AMT, _deadline(), BRIEF);
        vm.expectRevert(ProofPayEscrow.InvalidPayee.selector);
        esc.createJob(client, AMT, _deadline(), BRIEF);
        vm.expectRevert(ProofPayEscrow.InvalidPayee.selector);
        esc.createJob(address(esc), AMT, _deadline(), BRIEF);
        vm.expectRevert(ProofPayEscrow.InvalidAmount.selector);
        esc.createJob(payee, 0, _deadline(), BRIEF);
        vm.expectRevert(ProofPayEscrow.AmountAboveMax.selector);
        esc.createJob(payee, MAX + 1, _deadline(), BRIEF);
        vm.expectRevert(ProofPayEscrow.InvalidDeadline.selector);
        esc.createJob(payee, AMT, uint64(block.timestamp + 1), BRIEF);
        vm.expectRevert(ProofPayEscrow.InvalidDeadline.selector);
        esc.createJob(payee, AMT, uint64(block.timestamp + 91 days), BRIEF);
        vm.stopPrank();
    }

    function test_fund_onlyClient_once_beforeDeadline() public {
        vm.prank(client);
        uint256 id = esc.createJob(payee, AMT, _deadline(), BRIEF);
        vm.prank(stranger);
        vm.expectRevert(ProofPayEscrow.NotClient.selector);
        esc.fundJob(id);
        vm.prank(client);
        esc.fundJob(id);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Funded));
        esc.fundJob(id);
        assertEq(usd.balanceOf(address(esc)), AMT);

        vm.prank(client);
        uint256 id2 = esc.createJob(payee, AMT, _deadline(), BRIEF);
        vm.warp(block.timestamp + 4 days);
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.DeadlinePassed.selector);
        esc.fundJob(id2);
    }

    function test_fund_withoutAllowance_reverts() public {
        vm.prank(client);
        usd.approve(address(esc), 0);
        vm.prank(client);
        vm.expectRevert();
        esc.createAndFund(payee, AMT, _deadline(), BRIEF);
        assertEq(esc.jobCount(), 0); // whole tx reverted
    }

    function test_cancelUnfunded() public {
        vm.prank(client);
        uint256 id = esc.createJob(payee, AMT, _deadline(), BRIEF);
        vm.prank(stranger);
        vm.expectRevert(ProofPayEscrow.NotClient.selector);
        esc.cancelJob(id);
        vm.prank(client);
        esc.cancelJob(id);
        assertEq(uint8(esc.getJob(id).status), uint8(ProofPayEscrow.Status.Cancelled));
        vm.prank(client);
        vm.expectRevert();
        esc.fundJob(id);
        uint256 f = _funded();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Funded));
        esc.cancelJob(f);
    }

    function test_feeOnTransferToken_rejected() public {
        FeeToken ft = new FeeToken();
        ProofPayEscrow e2 = new ProofPayEscrow(IERC20(address(ft)), owner, agent, CAP, MAX);
        ft.mint(client, 1_000e6);
        vm.startPrank(client);
        ft.approve(address(e2), type(uint256).max);
        vm.expectRevert(ProofPayEscrow.InvalidAmount.selector);
        e2.createAndFund(payee, AMT, _deadline(), BRIEF);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ proof

    function test_submitProof() public {
        uint256 id = _funded();
        vm.expectEmit(true, true, false, true);
        emit ProofPayEscrow.ProofSubmitted(id, payee, URL, PROOF);
        vm.prank(payee);
        esc.submitProof(id, URL);
        ProofPayEscrow.Job memory j = esc.getJob(id);
        assertEq(uint8(j.status), uint8(ProofPayEscrow.Status.ProofSubmitted));
        assertEq(j.proofHash, PROOF);
    }

    function test_submitProof_guards() public {
        uint256 id = _funded();
        vm.prank(stranger);
        vm.expectRevert(ProofPayEscrow.NotPayee.selector);
        esc.submitProof(id, URL);
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.NotPayee.selector);
        esc.submitProof(id, URL);
        vm.startPrank(payee);
        vm.expectRevert(ProofPayEscrow.InvalidProof.selector);
        esc.submitProof(id, "");
        vm.expectRevert(ProofPayEscrow.InvalidProof.selector);
        esc.submitProof(id, string(new bytes(513)));
        esc.submitProof(id, URL);
        vm.expectRevert(
            abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.ProofSubmitted)
        );
        esc.submitProof(id, "https://x.com/ada/status/999");
        vm.stopPrank();
    }

    function test_submitProof_afterDeadline_reverts() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + 3 days);
        vm.prank(payee);
        vm.expectRevert(ProofPayEscrow.DeadlinePassed.selector);
        esc.submitProof(id, URL);
    }

    function test_submitProof_unfunded_reverts() public {
        vm.prank(client);
        uint256 id = esc.createJob(payee, AMT, _deadline(), BRIEF);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Created));
        esc.submitProof(id, URL);
    }

    // ------------------------------------------------------------ release

    function test_agentRelease_paysPayee() public {
        uint256 id = _withProof();
        vm.expectEmit(true, true, true, true);
        emit ProofPayEscrow.Released(id, agent, payee, AMT, VERDICT);
        vm.prank(agent);
        esc.agentRelease(id, PROOF, VERDICT);
        assertEq(usd.balanceOf(payee), AMT);
        assertEq(usd.balanceOf(address(esc)), 0);
        ProofPayEscrow.Job memory j = esc.getJob(id);
        assertEq(uint8(j.status), uint8(ProofPayEscrow.Status.Released));
        assertEq(j.verdictHash, VERDICT);
    }

    function test_noDoubleRelease() public {
        uint256 id = _withProof();
        vm.prank(agent);
        esc.agentRelease(id, PROOF, VERDICT);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Released));
        esc.agentRelease(id, PROOF, VERDICT);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Released));
        esc.approveRelease(id, VERDICT);
        vm.warp(block.timestamp + 10 days);
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.NotRefundableYet.selector);
        esc.refund(id);
        assertEq(usd.balanceOf(payee), AMT);
    }

    function test_noDoubleRelease_acrossJobs_isolated() public {
        uint256 a = _withProof();
        uint256 b = _funded();
        vm.prank(agent);
        esc.agentRelease(a, PROOF, VERDICT);
        // job b's funds untouched
        assertEq(usd.balanceOf(address(esc)), AMT);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Funded));
        esc.agentRelease(b, PROOF, VERDICT);
    }

    function test_agentRelease_requiresProof() public {
        uint256 id = _funded();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Funded));
        esc.agentRelease(id, PROOF, VERDICT);
    }

    function test_agentRelease_boundToReviewedProof() public {
        uint256 id = _withProof();
        vm.prank(agent);
        vm.expectRevert(ProofPayEscrow.InvalidProof.selector);
        esc.agentRelease(id, keccak256("some other url"), VERDICT);
    }

    function test_agentRelease_capEnforced() public {
        vm.prank(client);
        uint256 id = esc.createAndFund(payee, CAP + 1, _deadline(), BRIEF);
        vm.prank(payee);
        esc.submitProof(id, URL);
        vm.prank(agent);
        vm.expectRevert(ProofPayEscrow.AboveAgentCap.selector);
        esc.agentRelease(id, PROOF, VERDICT);
        // client can still approve big jobs
        vm.prank(client);
        esc.approveRelease(id, VERDICT);
        assertEq(usd.balanceOf(payee), CAP + 1);
    }

    function test_onlyAgent() public {
        uint256 id = _withProof();
        address[3] memory bad = [client, payee, stranger];
        for (uint256 i; i < bad.length; i++) {
            vm.startPrank(bad[i]);
            vm.expectRevert(ProofPayEscrow.NotAgent.selector);
            esc.agentRelease(id, PROOF, VERDICT);
            vm.expectRevert(ProofPayEscrow.NotAgent.selector);
            esc.agentReject(id, PROOF, VERDICT);
            vm.stopPrank();
        }
        // owner is NOT the agent either
        vm.prank(owner);
        vm.expectRevert(ProofPayEscrow.NotAgent.selector);
        esc.agentRelease(id, PROOF, VERDICT);
    }

    function test_revokedAgent_cannotAct() public {
        uint256 id = _withProof();
        vm.prank(owner);
        esc.setAgent(address(0));
        vm.prank(agent);
        vm.expectRevert(ProofPayEscrow.NotAgent.selector);
        esc.agentRelease(id, PROOF, VERDICT);
        // even address(0) cannot act
        vm.prank(address(0));
        vm.expectRevert(ProofPayEscrow.NotAgent.selector);
        esc.agentRelease(id, PROOF, VERDICT);
    }

    function test_clientApproveRelease_humanOverride() public {
        uint256 id = _funded(); // even without proof
        vm.prank(stranger);
        vm.expectRevert(ProofPayEscrow.NotClient.selector);
        esc.approveRelease(id, VERDICT);
        vm.prank(payee);
        vm.expectRevert(ProofPayEscrow.NotClient.selector);
        esc.approveRelease(id, VERDICT);
        vm.prank(client);
        esc.approveRelease(id, VERDICT);
        assertEq(usd.balanceOf(payee), AMT);
    }

    // ------------------------------------------------------------ reject

    function test_agentReject_allowsResubmit() public {
        uint256 id = _withProof();
        vm.expectEmit(true, true, false, true);
        emit ProofPayEscrow.ProofRejected(id, agent, 1, VERDICT);
        vm.prank(agent);
        esc.agentReject(id, PROOF, VERDICT);
        ProofPayEscrow.Job memory j = esc.getJob(id);
        assertEq(uint8(j.status), uint8(ProofPayEscrow.Status.Funded));
        assertEq(j.rejections, 1);
        assertEq(usd.balanceOf(address(esc)), AMT);
        string memory url2 = "https://x.com/ada/status/456";
        vm.prank(payee);
        esc.submitProof(id, url2);
        vm.prank(agent);
        esc.agentRelease(id, keccak256(bytes(url2)), VERDICT);
        assertEq(usd.balanceOf(payee), AMT);
    }

    function test_agentReject_thriceRefunds() public {
        uint256 id = _funded();
        uint256 before = usd.balanceOf(client);
        for (uint256 i; i < 3; i++) {
            string memory u = string(abi.encodePacked("https://x.com/a/status/", vm.toString(i)));
            vm.prank(payee);
            esc.submitProof(id, u);
            vm.prank(agent);
            esc.agentReject(id, keccak256(bytes(u)), VERDICT);
        }
        assertEq(uint8(esc.getJob(id).status), uint8(ProofPayEscrow.Status.Refunded));
        assertEq(usd.balanceOf(client), before + AMT);
        vm.prank(payee);
        vm.expectRevert();
        esc.submitProof(id, URL);
    }

    function test_clientRefund_afterRejection() public {
        uint256 id = _withProof();
        vm.prank(agent);
        esc.agentReject(id, PROOF, VERDICT);
        uint256 before = usd.balanceOf(client);
        vm.prank(client);
        esc.refund(id);
        assertEq(usd.balanceOf(client), before + AMT);
        assertEq(uint8(esc.getJob(id).status), uint8(ProofPayEscrow.Status.Refunded));
    }

    // ------------------------------------------------------------ refund

    function test_refund_afterDeadline() public {
        uint256 id = _funded();
        assertFalse(esc.refundable(id));
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.NotRefundableYet.selector);
        esc.refund(id);
        vm.warp(block.timestamp + 3 days);
        assertTrue(esc.refundable(id));
        vm.prank(stranger);
        vm.expectRevert(ProofPayEscrow.NotClient.selector);
        esc.refund(id);
        uint256 before = usd.balanceOf(client);
        vm.expectEmit(true, true, false, true);
        emit ProofPayEscrow.Refunded(id, client, AMT);
        vm.prank(client);
        esc.refund(id);
        assertEq(usd.balanceOf(client), before + AMT);
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.NotRefundableYet.selector);
        esc.refund(id); // no double refund
    }

    function test_refund_pendingProof_waitsForGrace() public {
        uint256 id = _withProof();
        vm.warp(block.timestamp + 3 days);
        assertFalse(esc.refundable(id)); // agent still has review grace
        vm.prank(client);
        vm.expectRevert(ProofPayEscrow.NotRefundableYet.selector);
        esc.refund(id);
        // agent can still decide during grace
        vm.warp(block.timestamp + 1 days);
        assertTrue(esc.refundable(id));
        vm.prank(client);
        esc.refund(id);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Refunded));
        esc.agentRelease(id, PROOF, VERDICT);
    }

    function test_refund_thenNoRelease() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + 3 days);
        vm.prank(client);
        esc.refund(id);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ProofPayEscrow.BadStatus.selector, ProofPayEscrow.Status.Refunded));
        esc.approveRelease(id, VERDICT);
    }

    // ------------------------------------------------------------ pause / admin

    function test_pause_blocksAgentNotClient() public {
        uint256 id = _withProof();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.pause();
        vm.prank(owner);
        esc.pause();
        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.agentRelease(id, PROOF, VERDICT);
        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.agentReject(id, PROOF, VERDICT);
        vm.prank(client);
        esc.approveRelease(id, VERDICT); // human override still works
        assertEq(usd.balanceOf(payee), AMT);
        vm.prank(owner);
        esc.unpause();
    }

    function test_adminOnlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.setAgent(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        esc.setLimits(1, 2);
        vm.stopPrank();
        vm.startPrank(owner);
        vm.expectRevert(ProofPayEscrow.InvalidLimits.selector);
        esc.setLimits(3, 2);
        esc.setLimits(1e6, 2e6);
        esc.setAgent(stranger);
        vm.stopPrank();
        assertEq(esc.agent(), stranger);
        assertEq(esc.agentReleaseCap(), 1e6);
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        esc.transferOwnership(stranger);
        assertEq(esc.owner(), owner);
        vm.prank(stranger);
        esc.acceptOwnership();
        assertEq(esc.owner(), stranger);
    }

    // ------------------------------------------------------------ reentrancy

    function test_reentrancy_onRelease_blocked() public {
        ReentrantToken rt = new ReentrantToken();
        ProofPayEscrow e2 = new ProofPayEscrow(IERC20(address(rt)), owner, agent, CAP, MAX);
        rt.mint(client, 1_000e6);
        rt.mint(address(rt), 1_000e6);
        vm.prank(client);
        rt.approve(address(e2), type(uint256).max);
        // Job a: normal client. Job b: the malicious token contract is the client.
        vm.prank(client);
        uint256 a = e2.createAndFund(payee, AMT, _deadline(), BRIEF);
        rt.act(address(rt), abi.encodeCall(IERC20.approve, (address(e2), type(uint256).max)));
        uint256 b = abi.decode(
            rt.act(address(e2), abi.encodeCall(ProofPayEscrow.createAndFund, (payee, AMT, _deadline(), BRIEF))), (uint256)
        );
        // Make job b legitimately refundable (proof rejected once).
        vm.prank(payee);
        e2.submitProof(b, URL);
        vm.prank(agent);
        e2.agentReject(b, PROOF, VERDICT);
        assertTrue(e2.refundable(b));
        // During job a's payout the token re-enters escrow.refund(b): must be blocked by the guard.
        vm.prank(payee);
        e2.submitProof(a, URL);
        rt.arm(address(e2), abi.encodeCall(ProofPayEscrow.refund, (b)));
        vm.prank(agent);
        e2.agentRelease(a, PROOF, VERDICT);
        assertTrue(rt.attempted());
        assertFalse(rt.reentered());
        assertEq(rt.balanceOf(payee), AMT);
        assertEq(rt.balanceOf(address(e2)), AMT); // job b still locked
        assertEq(uint8(e2.getJob(b).status), uint8(ProofPayEscrow.Status.Funded));
    }

    // ------------------------------------------------------------ fuzz / invariants

    function testFuzz_escrowBalanceMatchesOpenJobs(uint96 amount, uint8 path) public {
        amount = uint96(bound(amount, 1, MAX));
        vm.prank(client);
        uint256 id = esc.createAndFund(payee, amount, _deadline(), BRIEF);
        assertEq(usd.balanceOf(address(esc)), amount);
        uint256 total = usd.balanceOf(client) + usd.balanceOf(payee) + usd.balanceOf(address(esc));
        path = path % 3;
        if (path == 0) {
            vm.prank(client);
            esc.approveRelease(id, VERDICT);
            assertEq(usd.balanceOf(payee), amount);
        } else if (path == 1) {
            vm.warp(block.timestamp + 3 days);
            vm.prank(client);
            esc.refund(id);
            assertEq(usd.balanceOf(payee), 0);
        } else {
            vm.prank(payee);
            esc.submitProof(id, URL);
            vm.prank(agent);
            if (amount > CAP) {
                vm.expectRevert(ProofPayEscrow.AboveAgentCap.selector);
                esc.agentRelease(id, PROOF, VERDICT);
                return;
            }
            esc.agentRelease(id, PROOF, VERDICT);
        }
        assertEq(usd.balanceOf(address(esc)), 0);
        assertEq(usd.balanceOf(client) + usd.balanceOf(payee), total);
    }

    function testFuzz_strangerCannotMoveFunds(address who) public {
        vm.assume(who != client && who != payee && who != agent && who != owner && who != address(0));
        uint256 id = _withProof();
        vm.startPrank(who);
        vm.expectRevert();
        esc.agentRelease(id, PROOF, VERDICT);
        vm.expectRevert();
        esc.approveRelease(id, VERDICT);
        vm.expectRevert();
        esc.refund(id);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(esc)), AMT);
    }
}
