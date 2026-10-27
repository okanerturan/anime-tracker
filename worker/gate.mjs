// Entry for the hub gate (wrangler.gate.jsonc): the passphrase check and the forwarding to the hub
// from worker/index.js, without the Durable Object. Needs the ORIGIN_URL secret.
import worker from './index.js';

export default { fetch: worker.fetch };
