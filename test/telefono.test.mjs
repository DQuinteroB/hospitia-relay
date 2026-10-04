import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.TWILIO_AUTH_TOKEN = 'token-de-prueba';
process.env.CLIENTES_JSON = JSON.stringify({ '+1 555 555 0101': { nombre: 'Negocio de prueba', webhooks: {} } });
process.env.PUBLIC_URL = 'http://127.0.0.1:0';   // se corrige al conocer el puerto
delete process.env.GCP_PROJECT;

const T = await import('../telefono.js');

test('mu-law ida y vuelta conserva la senal', () => {
  const muestras = Int16Array.from([0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]);
  const vuelta = T.mulawToPcm16(T.pcm16ToMulaw(muestras));
  muestras.forEach((v, i) => assert.ok(Math.abs(vuelta[i] - v) <= Math.max(16, Math.abs(v) * 0.07), `${v} -> ${vuelta[i]}`));
});

test('cambio de frecuencia: 8k->16k duplica y 24k->8k divide entre 3', () => {
  assert.equal(T.upsample2x(new Int16Array(160)).length, 320);
  assert.equal(T.downsample3x(new Int16Array(480)).length, 160);
  assert.deepEqual(Array.from(T.downsample3x(Int16Array.from([3, 6, 9]))), [6]);
});

test('firma de Twilio (valor validado con twilio.validateRequest de la libreria oficial)', () => {
  const firma = T.twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
    CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+14158675309', To: '+18005551212'
  });
  assert.equal(firma, 'hQB5VTHIpMUO6TFoLtwSh6arFMk=');
});

test('servidor: TwiML, rechazo sin firma y token del stream', async () => {
  await new Promise((r) => T.httpServer.listen(0, '127.0.0.1', r));
  const port = T.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  // PUBLIC_URL se lee al importar; la firma se calcula con la URL publica configurada
  const publicUrl = 'http://127.0.0.1:0';
  const post = (params, firma) => fetch(`${base}/twilio/voice`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(firma ? { 'X-Twilio-Signature': firma } : {}) },
    body: new URLSearchParams(params).toString()
  });
  const params = { CallSid: 'CAtest1', From: '+15555550100', To: '+15555550101' };

  assert.equal((await post(params)).status, 403, 'sin firma -> 403');
  const ok = await post(params, T.twilioSignature('token-de-prueba', publicUrl + '/twilio/voice', params));
  assert.equal(ok.status, 200);
  const xml = await ok.text();
  assert.match(xml, /<Connect><Stream url="ws:\/\/127\.0\.0\.1:0\/twilio\/stream">/);
  const token = xml.match(/name="token" value="([0-9a-f]+)"/)[1];

  const desconocido = { CallSid: 'CAtest2', From: '+15555550100', To: '+15555550199' };
  const r2 = await post(desconocido, T.twilioSignature('token-de-prueba', publicUrl + '/twilio/voice', desconocido));
  assert.match(await r2.text(), /<Say language="es-ES">/);

  const conectar = (tok) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream`);
    ws.on('open', () => ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CAtest1', customParameters: { to: '+15555550101', from: '+15555550100', token: tok } } })));
    ws.on('close', () => resolve('cerrado'));
    setTimeout(() => { ws.close(); resolve('abierto'); }, 1500);
  });
  assert.equal(await conectar('token-falso'), 'cerrado', 'token falso -> se cierra');
  assert.equal(await conectar(token), 'cerrado', 'token valido sin GCP_PROJECT -> cierra limpio');
  await new Promise((r) => T.httpServer.close(r));
});
