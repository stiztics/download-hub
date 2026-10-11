#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/reports
fixture_connection=$(mktemp)
fixture_pid=''
simulator_id=''
cleanup() {
  if [[ -n "$simulator_id" ]]; then xcrun simctl io "$simulator_id" screenshot build/reports/native-final-screen.png || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  rm -f "$fixture_connection"
}
trap cleanup EXIT
HUB_FIXTURE_BYTES=8388608 node ../testing/fixture-server.mjs "$fixture_connection" > build/reports/native-fixture.log 2>&1 &
fixture_pid=$!
for attempt in {1..50}; do [[ -s "$fixture_connection" ]] && break; sleep 0.2; done
[[ -s "$fixture_connection" ]] || { echo 'Fixture did not start' >&2; exit 1; }
server=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).server)' "$fixture_connection")
code=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).code)' "$fixture_connection")
xcrun simctl list devices available -j > build/reports/available-simulators.json
simulator_id=$(node -e '
const data=JSON.parse(require("fs").readFileSync(process.argv[1]));
const rows=Object.entries(data.devices).flatMap(([runtime,devices])=>runtime.includes("iOS")?devices.filter(d=>d.isAvailable&&d.name.includes("iPhone")).map(d=>({...d,runtime})):[]);
rows.sort((a,b)=>(b.runtime.includes("iOS-26")?100:0)+(b.name==="iPhone 15 Pro"?10:0)-(a.runtime.includes("iOS-26")?100:0)-(a.name==="iPhone 15 Pro"?10:0));
if(!rows.length)throw Error("No iPhone simulator runtime");
require("fs").writeFileSync("build/reports/test-device.json",JSON.stringify(rows[0],null,2));console.log(rows[0].udid);
' build/reports/available-simulators.json)
echo "Booting simulator $simulator_id"
xcrun simctl boot "$simulator_id" || xcrun simctl list devices booted | grep -F "$simulator_id"
python3 - "$simulator_id" <<'PY'
import subprocess, sys
subprocess.run(['xcrun','simctl','bootstatus',sys.argv[1],'-b'],check=True,timeout=480)
PY
echo 'Installing and launching native generated-file integration suite'
xcrun simctl install "$simulator_id" build/Simulator/Build/Products/SimulatorTest-iphonesimulator/DownloadHub.app
container=$(xcrun simctl get_app_container "$simulator_id" local.downloadhub.personal data)
report="$container/Library/Application Support/native-selftest.json"
xcrun simctl launch "$simulator_id" local.downloadhub.personal -hubSelfTest YES -hubTestServer "$server" -hubTestCode "$code"
for attempt in {1..240}; do [[ -s "$report" ]] && break; sleep 1; done
[[ -s "$report" ]] || { echo 'Native suite did not write a report' >&2; exit 1; }
cp "$report" build/reports/native-selftest.json
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(JSON.stringify(r,null,2));if(!r.success)process.exit(1)' "$report"
echo 'Testing offline persistence across an actual process relaunch'
xcrun simctl terminate "$simulator_id" local.downloadhub.personal
rm "$report"
xcrun simctl launch "$simulator_id" local.downloadhub.personal -hubSelfTestOffline YES
for attempt in {1..60}; do [[ -s "$report" ]] && break; sleep 1; done
[[ -s "$report" ]] || { echo 'Offline relaunch did not write a report' >&2; exit 1; }
cp "$report" build/reports/native-offline-relaunch.json
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(JSON.stringify(r,null,2));if(!r.success)process.exit(1)' "$report"
