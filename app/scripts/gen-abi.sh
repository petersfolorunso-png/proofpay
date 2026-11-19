#!/usr/bin/env bash
# Regenerate app/src/abi.ts and app/public/abi.json after changing the contract.
set -euo pipefail
cd "$(dirname "$0")/../.."
(cd contracts && forge build)
python3 - <<'PY'
import json
abi=json.load(open('contracts/out/ProofPayEscrow.sol/ProofPayEscrow.json'))['abi']
src=open('app/src/abi.ts').read()
erc_start=src.index('export const erc20Abi')
open('app/src/abi.ts','w').write("// Generated from contracts/out by scripts/gen-abi.sh. Do not edit by hand.\nexport const escrowAbi = "+json.dumps(abi,indent=1)+" as const;\n\n"+src[erc_start:])
erc=json.loads(src[erc_start:].split('=',1)[1].rsplit(' as const',1)[0])
open('app/public/abi.json','w').write(json.dumps({"escrow":abi,"erc20":erc}))
PY
echo "ABI regenerated"
