process.env.APPGOG_ROLE = 'license-center';
process.env.APPGOG_SURFACE = 'license-center';
process.env.EMBEDDED_WORKER = 'false';
await import('../apps/license-api/src/server.js');
