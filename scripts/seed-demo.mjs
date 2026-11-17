// Seed (or with --remove, delete) the clearly labelled synthetic demo label.
// Usage: DATABASE_URL=... npm run seed:demo [-- --remove]
// The same operation is available to administrators as POST /v1/admin/demo-data (and /remove), e.g. from the Command Center Admin screen.
import {openStore} from '../src/store.js';
import {seedDemoData,DEMO_LABEL} from '../src/demo-seed.js';
const store=await openStore(process.env.DATABASE_URL,{connectorKey:process.env.CONNECTOR_MASTER_KEY});
try {
  const result=process.argv.includes('--remove') ? await store.deleteSyntheticLabel(DEMO_LABEL,'cli') : await seedDemoData(store,{actor:'cli'});
  if (!process.argv.includes('--remove')) await store.refreshRollups(DEMO_LABEL);
  console.log(JSON.stringify(result));
} finally { await store.close(); }
