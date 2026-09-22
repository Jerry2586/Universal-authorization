process.env.APPGOG_SURFACE = 'combined';
process.env.EMBEDDED_WORKER = 'true';
await import('../apps/license-api/src/server.js');
