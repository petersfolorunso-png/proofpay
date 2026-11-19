#!/usr/bin/env bash
# Deploy ProofPayEscrow to QDay Aevum Testnet, verify it on the explorer, and top up the agent/demo wallets.
# Keys are read from ~/.secrets/aevum/wallet.env (chmod 600) and never printed.
#   AEVUM_PRIVATE_KEY            deployer + owner (admin: pause, rotate agent, limits)
#   AGENT_ADDRESS                verifier agent (only agentRelease/agentReject, capped)
#   DEMO_CLIENT_ADDRESS / DEMO_FREELANCER_ADDRESS   optional demo wallets
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
SECRETS=${PROOFPAY_SECRETS:-$HOME/.secrets/aevum/wallet.env}
set -a; source "$SECRETS"; set +a
RPC=${RPC_URL:-https://rpc-test.qday.info}
EXPLORER=${EXPLORER_URL:-https://explorer-test.qday.info}
TOKEN=${TOKEN_ADDRESS:-0x456569838f1d43009A91ebA4263147Afd7233483}
CAP=${AGENT_RELEASE_CAP:-100000000}      # 100 tUSD8
MAXJOB=${MAX_JOB_AMOUNT:-1000000000}     # 1,000 tUSD8
DRY=${DRY_RUN:-0}
# The public RPC sits behind Cloudflare and returns sporadic 502s: retry read calls.
rcast(){ local i out; for i in 1 2 3 4 5 6; do if out=$(cast "$@" 2>/dev/null); then echo "$out"; return 0; fi; sleep 2; done; echo "cast $1 failed after retries" >&2; return 1; }

[ "$(rcast chain-id -r $RPC)" = "44005" ] || { echo "RPC is not Aevum Testnet (44005)"; exit 1; }
BAL=$(rcast balance "$AEVUM_ADDRESS" -r $RPC)
echo "deployer $AEVUM_ADDRESS  tQDAY=$(cast from-wei $BAL)  tUSD8(base units)=$(rcast call $TOKEN 'balanceOf(address)(uint256)' $AEVUM_ADDRESS -r $RPC)"
if [ "$BAL" = "0" ] && [ "$DRY" != "1" ]; then echo "Deployer has no tQDAY. Fund it at https://faucet.qday.info/en first."; exit 2; fi

cd contracts
forge build >/dev/null
CTOR=$(cast abi-encode "constructor(address,address,address,uint96,uint96)" $TOKEN $AEVUM_ADDRESS $AGENT_ADDRESS $CAP $MAXJOB)
if [ "$DRY" = "1" ]; then
  CODE=$(python3 -c "import json;print(json.load(open('out/ProofPayEscrow.sol/ProofPayEscrow.json'))['bytecode']['object'])")
  echo "estimated deploy gas: $(rcast estimate -r $RPC --from $AEVUM_ADDRESS --create ${CODE}${CTOR#0x})"
  echo "gas price (wei): $(rcast gas-price -r $RPC)"
  exit 0
fi
# Single attempt on purpose (a blind retry could double-deploy). Re-run the script if the RPC hiccups.
OUT=$(forge create src/ProofPayEscrow.sol:ProofPayEscrow --rpc-url $RPC --legacy --broadcast --json \
  --private-key "$AEVUM_PRIVATE_KEY" --constructor-args $TOKEN $AEVUM_ADDRESS $AGENT_ADDRESS $CAP $MAXJOB)
ESCROW=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
TX=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["transactionHash"])')
ESCROW=$(cast to-check-sum-address $ESCROW)
echo "ProofPayEscrow: $ESCROW  tx: $EXPLORER/tx/$TX"

echo "verifying on Blockscout..."
forge verify-contract $ESCROW src/ProofPayEscrow.sol:ProofPayEscrow --chain-id 44005 \
  --verifier blockscout --verifier-url "$EXPLORER/api/" \
  --constructor-args $CTOR \
  --watch || echo "verification failed; retry later with the same command"
cd ..

python3 - <<PY
import json
json.dump({"chainId":44005,"escrow":"$ESCROW","deployTx":"$TX","deployBlock":"$(rcast receipt $TX blockNumber -r $RPC)","token":"$TOKEN","owner":"$AEVUM_ADDRESS","agent":"$AGENT_ADDRESS","agentReleaseCap":"$CAP","maxJobAmount":"$MAXJOB"},open("deployments/aevum-testnet.json","w"),indent=2)
PY
echo "wrote deployments/aevum-testnet.json"

# Top up gas for agent + demo wallets (small amounts) and give the demo client some tUSD8.
GAS=${GAS_TOPUP:-0.01ether}
for A in $AGENT_ADDRESS ${DEMO_CLIENT_ADDRESS:-} ${DEMO_FREELANCER_ADDRESS:-}; do
  [ -n "$A" ] && cast send $A --value $GAS -r $RPC --legacy --private-key "$AEVUM_PRIVATE_KEY" --json | python3 -c "import json,sys;print('gas ->','$A',json.load(sys.stdin)['transactionHash'])"
done
if [ -n "${DEMO_CLIENT_ADDRESS:-}" ]; then
  DBAL=$(rcast call $TOKEN 'balanceOf(address)(uint256)' $AEVUM_ADDRESS -r $RPC | awk '{print $1}')
  HALF=$((DBAL / 2))
  [ "$HALF" -gt 0 ] && cast send $TOKEN "transfer(address,uint256)" $DEMO_CLIENT_ADDRESS $HALF -r $RPC --legacy --private-key "$AEVUM_PRIVATE_KEY" --json | python3 -c "import json,sys;print('tUSD8 -> demo client',json.load(sys.stdin)['transactionHash'])"
fi
