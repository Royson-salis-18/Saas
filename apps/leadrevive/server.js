import { createLeadRevive } from './src/app.js';

const app = createLeadRevive();
const server = await app.listen(Number(process.env.PORT) || 3001);
app.startJobs();
console.log(`LeadRevive listening on :${app.port} (${app.config.baseUrl || 'set BASE_URL for production'})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.stopJobs();
    server.close(() => {
      app.db.close();
      process.exit(0);
    });
  });
}
