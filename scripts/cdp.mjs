// Evalúa una expresión en la app arrancada con `npm run start:debug`.
//   node scripts/cdp.mjs main "speechDebug.store.get().helper"
//   node scripts/cdp.mjs window "document.body.innerText"
// Solo para comprobaciones durante el desarrollo.
const [destino, expresion] = process.argv.slice(2);
if (!['main', 'window'].includes(destino) || !expresion) {
  console.error('Uso: node scripts/cdp.mjs main|window "<expresión>"');
  process.exit(2);
}
const puerto = destino === 'main' ? 9339 : 9338;
const objetivos = await (await fetch(`http://127.0.0.1:${puerto}/json/list`)).json();
const objetivo = destino === 'main' ? objetivos[0] : objetivos.find((t) => t.type === 'page');
if (!objetivo) {
  console.error(`No hay ${destino === 'main' ? 'proceso main' : 'ventana abierta'} en el puerto ${puerto}`);
  process.exit(1);
}
const ws = new WebSocket(objetivo.webSocketDebuggerUrl);
await new Promise((r, e) => {
  ws.onopen = r;
  ws.onerror = e;
});
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expresion, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
  }),
);
const respuesta = await new Promise((r) => {
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id === 1) r(d);
  };
});
ws.close();
const res = respuesta.result;
if (res?.exceptionDetails) {
  console.error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  process.exit(1);
}
const v = res?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
