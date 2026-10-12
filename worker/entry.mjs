// ESM entry for Workers: wires the runtime's DurableObject class into the CommonJS modules.
import { DurableObject } from 'cloudflare:workers';
import worker from './index.js';
import trackerDo from './tracker-do.js';

export const TrackerDO = trackerDo.makeTrackerDO(DurableObject);
export default { fetch: worker.fetch, scheduled: worker.scheduled };
