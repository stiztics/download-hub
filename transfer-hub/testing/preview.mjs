import { startFixture } from './fixture-server.mjs';
const fixture = await startFixture();
console.log(`Windows test preview — generated files only\nDesktop:    ${fixture.server}/\nShared app: ${fixture.server}/app/\nTest code:  ${fixture.code}\nCtrl+C stops this isolated preview.`);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await fixture.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
