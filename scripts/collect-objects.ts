/** Explicit environment only. Never scans a bucket. */
import { closeDb } from '../lib/db';
import { collectObjects } from '../lib/object-gc';
if (process.argv.length !== 2) throw new Error('No arguments supported; use ACS_GC_LIMIT');
collectObjects(Number(process.env.ACS_GC_LIMIT || 100)).finally(closeDb).then(n=>console.log({deleted:n})).catch(e=>{ console.error(e); process.exitCode=1; });
