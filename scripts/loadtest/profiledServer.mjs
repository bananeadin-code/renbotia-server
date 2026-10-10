// Arranca el servidor real con el perfilador de CPU encendido (solo pruebas de
// carga). Al recibir "stop" por IPC guarda el perfil (.cpuprofile) y sale.
import inspector from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';

const session = new inspector.Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 200 }); // µs

await import('../../src/index.js');

// "start" al iniciar la fase (sin el arranque del servidor); "stop" al terminar.
process.on('message', async (msg) => {
  if (msg === 'start') return session.post('Profiler.start').then(() => process.send?.('started'));
  if (msg !== 'stop') return;
  const { profile } = await session.post('Profiler.stop');
  writeFileSync(process.env.LOAD_PROFILE_OUT || 'server.cpuprofile', JSON.stringify(profile));
  process.send?.('stopped');
  setTimeout(() => process.exit(0), 200);
});
