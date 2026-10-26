import { createPlateCost } from './src/app.js';

const app = createPlateCost();
const server = await app.listen(Number(process.env.PORT) || 3007);
app.startJobs();
console.log(`PlateCost listening on :${app.port} (${app.config.baseUrl || 'set BASE_URL for production'})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.stopJobs();
    server.close(() => {
      app.db.close();
      process.exit(0);
    });
  });
}
