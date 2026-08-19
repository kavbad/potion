process.env.POTION_SELF_SERVE='1'; process.env.POTION_MAGIC_LINK_IN_RESPONSE='1'; process.env.POTION_DEV_AUTH='0';
const { buildServer } = await import('./src/server.js');
const app = await buildServer({ seed:false, platformBaseline:true, log:()=>{} });
await app.listen({ port: 3300, host: '127.0.0.1' });
console.log('READY');
