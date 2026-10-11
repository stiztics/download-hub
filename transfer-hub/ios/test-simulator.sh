#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/reports
export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_DISABLE_UPDATE_CHECK=true
export MAESTRO_DRIVER_STARTUP_TIMEOUT=60000
fixture_connection=$(mktemp)
fixture_pid=''
simulator_id=''
cleanup() {
  if [[ -n "$simulator_id" ]]; then xcrun simctl io "$simulator_id" screenshot build/reports/final-screen.png || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  rm -f "$fixture_connection"
}
trap cleanup EXIT
node ../testing/fixture-server.mjs "$fixture_connection" > build/reports/fixture.log 2>&1 &
fixture_pid=$!
for attempt in {1..50}; do [[ -s "$fixture_connection" ]] && break; sleep 0.2; done
[[ -s "$fixture_connection" ]] || { echo 'Fixture did not start' >&2; exit 1; }
export HUB_TEST_SERVER
export HUB_TEST_CODE
HUB_TEST_SERVER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).server)' "$fixture_connection")
HUB_TEST_CODE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).code)' "$fixture_connection")
xcrun simctl list devices available -j > build/reports/available-simulators.json
simulator_id=$(node -e '
  const data = JSON.parse(require("fs").readFileSync(process.argv[1]));
  const candidates = Object.entries(data.devices).flatMap(([runtime, devices]) => runtime.includes("iOS") ? devices.filter(d => d.isAvailable && d.name.includes("iPhone")).map(d => ({ ...d, runtime })) : []);
  candidates.sort((a,b) => ((b.name === "iPhone 15 Pro" ? 10 : 0) + (b.runtime.includes("iOS-26") ? 100 : 0)) - ((a.name === "iPhone 15 Pro" ? 10 : 0) + (a.runtime.includes("iOS-26") ? 100 : 0)));
  if (!candidates.length) throw Error("No available iPhone simulator runtime");
  require("fs").writeFileSync("build/reports/test-device.json", JSON.stringify(candidates[0], null, 2));
  console.log(candidates[0].udid);
' build/reports/available-simulators.json)
xcrun simctl boot "$simulator_id" || xcrun simctl list devices booted | grep -F "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" build/Simulator/Build/Products/SimulatorTest-iphonesimulator/DownloadHub.app
maestro --device "$simulator_id" test --format JUNIT --output build/reports/transfer.xml \
  --debug-output build/reports/maestro-transfer --test-output-dir build/reports/transfer-artifacts \
  -e "HUB_TEST_SERVER=$HUB_TEST_SERVER" -e "HUB_TEST_CODE=$HUB_TEST_CODE" maestro/transfer.yaml
node ../testing/check-receipts.mjs "$fixture_connection"
maestro --device "$simulator_id" test --format JUNIT --output build/reports/demo.xml \
  --debug-output build/reports/maestro-demo --test-output-dir build/reports/demo-artifacts maestro/demo.yaml
