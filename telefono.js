/**
 * ============================================================================
 * HOSPITIA AI - Relay telefonico (Twilio Media Streams <-> Gemini Live / Vertex AI)
 * v0.1 - bot de voz para clientes, sin Vapi.
 *
 * Flujo de una llamada:
 *   1. Twilio recibe la llamada en el numero del cliente y hace POST a /twilio/voice.
 *   2. Este servicio valida la firma de Twilio, busca la configuracion del cliente
 *      por el numero llamado ("To") y responde TwiML <Connect><Stream>.
 *   3. Twilio abre un WebSocket a /twilio/stream con el audio (mu-law 8 kHz).
 *   4. El audio se convierte a PCM 16 kHz y se envia a Gemini Live; la voz de
 *      Gemini (PCM 24 kHz) se convierte a mu-law 8 kHz y vuelve a Twilio.
 *   5. Las herramientas (consultar, crear, cancelar reserva) hacen POST a los
 *      webhooks de n8n del cliente, con la cabecera secreta.
 *
 * Privacidad: no se graba audio ni se guarda la transcripcion. Los logs no
 * incluyen el numero completo de quien llama ni el contenido de la conversacion.
 *
 * Es un servicio independiente de server.js (la demo de la web): se arranca con
 * `npm run start:telefono` en un servicio de Render distinto.
 * ============================================================================
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fs.writeFileSync('/tmp/sa.json', process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
}

const PORT         = process.env.PORT || 8080;
const PROJECT      = process.env.GCP_PROJECT;
const LOCATION     = process.env.GCP_LOCATION || 'us-central1';
const MODEL        = process.env.GEMINI_MODEL || 'gemini-live-2.5-flash-native-audio';
const PUBLIC_URL   = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');   // https://<servicio>.onrender.com
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const SKIP_SIGNATURE = process.env.TWILIO_SKIP_SIGNATURE === '1';         // solo pruebas locales
const N8N_AUTH_HEADER = process.env.N8N_AUTH_HEADER || 'X-Hospitia-Token';
const N8N_AUTH_VALUE  = process.env.N8N_AUTH_VALUE || '';
const MAX_CALL_MS  = Number(process.env.MAX_CALL_SECONDS || 600) * 1000;
const TIMEZONE     = 'Europe/Madrid';

// ---------------------------------------------------------------------------
// Configuracion de clientes: NUNCA en el repositorio. Se lee de la variable
// CLIENTES_JSON o del fichero CLIENTES_FILE (Secret File de Render).
// Formato: ver clientes.example.json
// ---------------------------------------------------------------------------
function loadClientes() {
  let raw = process.env.CLIENTES_JSON || '';
  if (!raw && process.env.CLIENTES_FILE) raw = fs.readFileSync(process.env.CLIENTES_FILE, 'utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  const out = {};
  for (const [numero, cfg] of Object.entries(parsed)) out[normalizarNumero(numero)] = cfg;
  return out;
}
function normalizarNumero(n) { return String(n || '').replace(/[^\d+]/g, ''); }
function enmascarar(n) { const s = normalizarNumero(n); return s.length > 3 ? `***${s.slice(-3)}` : 'oculto'; }

const CLIENTES = loadClientes();

// ---------------------------------------------------------------------------
// Audio: G.711 mu-law <-> PCM16 y cambio de frecuencia de muestreo
// ---------------------------------------------------------------------------
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}
export function mulawToPcm16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE[buf[i]];
  return out;
}
export function pcm16ToMulaw(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > 32635) s = 32635;
    s += 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}
// 8 kHz -> 16 kHz por interpolacion lineal
export function upsample2x(input) {
  const out = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const a = input[i], b = i + 1 < input.length ? input[i + 1] : a;
    out[2 * i] = a;
    out[2 * i + 1] = (a + b) >> 1;
  }
  return out;
}
// 24 kHz -> 8 kHz promediando grupos de 3 (filtro paso bajo sencillo)
export function downsample3x(input) {
  const n = Math.floor(input.length / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((input[3 * i] + input[3 * i + 1] + input[3 * i + 2]) / 3);
  return out;
}
function int16FromBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}
function int16ToBase64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

// ---------------------------------------------------------------------------
// Seguridad: firma de Twilio en /twilio/voice y token por llamada en el stream
// ---------------------------------------------------------------------------
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function streamToken(callSid) {
  return crypto.createHmac('sha256', TWILIO_TOKEN || 'sin-token').update(String(callSid)).digest('hex');
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Herramientas que puede usar el modelo
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'consultar_disponibilidad',
    description: 'Comprueba si hay hueco para una reserva. Usala SIEMPRE antes de confirmar una reserva.',
    parameters: { type: 'OBJECT', properties: {
      fecha: { type: 'STRING', description: 'Fecha en formato YYYY-MM-DD' },
      hora: { type: 'STRING', description: 'Hora en formato HH:MM (24 h)' },
      comensales: { type: 'INTEGER', description: 'Numero de personas' }
    }, required: ['fecha', 'hora', 'comensales'] }
  },
  {
    name: 'crear_reserva',
    description: 'Crea la reserva cuando el cliente ha confirmado fecha, hora, numero de personas y nombre. El sistema envia un SMS de confirmacion al cliente.',
    parameters: { type: 'OBJECT', properties: {
      nombre: { type: 'STRING' },
      fecha: { type: 'STRING', description: 'YYYY-MM-DD' },
      hora: { type: 'STRING', description: 'HH:MM' },
      comensales: { type: 'INTEGER' },
      terraza: { type: 'BOOLEAN', description: 'true si pide terraza' },
      notas: { type: 'STRING', description: 'Notas breves. Nunca detalles de salud: solo "avisa de alergia o necesidad especial, confirmar en sala".' },
      telefono: { type: 'STRING', description: 'Solo si el cliente pide la confirmacion en un numero distinto del que llama, o si el numero de quien llama no esta disponible.' }
    }, required: ['nombre', 'fecha', 'hora', 'comensales'] }
  },
  {
    name: 'cancelar_reserva',
    description: 'Cancela una reserva por su ID, o por nombre y fecha si el cliente no tiene el ID.',
    parameters: { type: 'OBJECT', properties: {
      id_reserva: { type: 'STRING' },
      nombre: { type: 'STRING' },
      fecha: { type: 'STRING', description: 'YYYY-MM-DD' }
    } }
  },
  {
    name: 'finalizar_llamada',
    description: 'Cuelga la llamada. Solo cuando el cliente se despide o pide terminar. Despidete en una frase ANTES de usarla.',
    parameters: { type: 'OBJECT', properties: { motivo: { type: 'STRING' } } }
  }
];
const TOOL_TO_WEBHOOK = { consultar_disponibilidad: 'consultar', crear_reserva: 'crear', cancelar_reserva: 'cancelar' };

async function llamarWebhook(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (N8N_AUTH_VALUE) headers[N8N_AUTH_HEADER] = N8N_AUTH_VALUE;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `El sistema de reservas respondio con error (${r.status}).` };
    try { return JSON.parse(text); } catch { return { ok: true, respuesta: text.slice(0, 500) }; }
  } catch (e) {
    return { ok: false, error: 'No se pudo contactar con el sistema de reservas.' };
  } finally { clearTimeout(t); }
}

function contextoLlamada(callerId) {
  const ahora = new Date();
  const fecha = new Intl.DateTimeFormat('es-ES', { timeZone: TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(ahora);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  const hora = new Intl.DateTimeFormat('es-ES', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(ahora);
  const tel = callerId
    ? 'El numero de quien llama esta disponible: se usa automaticamente para el SMS de confirmacion. No lo leas en voz alta ni lo pidas, salvo que el cliente quiera otro numero.'
    : 'El numero de quien llama esta oculto: pide un telefono movil para enviar el SMS de confirmacion y repitelo agrupado para confirmarlo.';
  return `\n\n# CONTEXTO DE ESTA LLAMADA\nHoy es ${fecha} (${iso}). Hora actual en Madrid: ${hora}.\n${tel}\nEs una llamada telefonica: frases cortas, una idea por frase.`;
}

// ---------------------------------------------------------------------------
// Servidor HTTP (TwiML) + WebSocket (Media Streams)
// ---------------------------------------------------------------------------
const ai = PROJECT ? new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION }) : null;

function leerBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}
function twiml(res, xml) {
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
}

export const httpServer = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && path === '/twilio/voice') {
    const params = Object.fromEntries(new URLSearchParams(await leerBody(req)));
    if (!SKIP_SIGNATURE) {
      const firma = req.headers['x-twilio-signature'] || '';
      const esperada = TWILIO_TOKEN && PUBLIC_URL ? twilioSignature(TWILIO_TOKEN, PUBLIC_URL + req.url, params) : '';
      if (!esperada || !safeEqual(firma, esperada)) {
        console.warn(`[voice] firma de Twilio no valida. Rechazada.`);
        res.writeHead(403); res.end('Forbidden'); return;
      }
    }
    const cfg = CLIENTES[normalizarNumero(params.To)];
    if (!cfg) {
      console.warn(`[voice] numero ${enmascarar(params.To)} sin configuracion.`);
      return twiml(res, '<Say language="es-ES">Lo sentimos, este numero no esta disponible en este momento.</Say><Hangup/>');
    }
    const wsUrl = (PUBLIC_URL || `https://${req.headers.host}`).replace(/^http/, 'ws') + '/twilio/stream';
    console.log(`[voice] llamada a ${cfg.nombre || enmascarar(params.To)} desde ${enmascarar(params.From)}.`);
    return twiml(res,
      `<Connect><Stream url="${xmlEscape(wsUrl)}">` +
      `<Parameter name="to" value="${xmlEscape(params.To || '')}"/>` +
      `<Parameter name="from" value="${xmlEscape(params.From || '')}"/>` +
      `<Parameter name="token" value="${streamToken(params.CallSid)}"/>` +
      `</Stream></Connect>`);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HOSPITIA AI relay telefonico OK');
});

const wss = new WebSocketServer({ server: httpServer, path: '/twilio/stream' });

wss.on('connection', (twilio) => {
  let streamSid = null, session = null, cfg = null, callerId = '';
  let colgando = false, cerrado = false;
  const limite = setTimeout(() => colgar('duracion maxima'), MAX_CALL_MS);

  function enviarTwilio(obj) { try { if (twilio.readyState === 1) twilio.send(JSON.stringify(obj)); } catch (_) {} }
  function colgar(motivo) {
    if (cerrado) return;
    cerrado = true;
    clearTimeout(limite);
    console.log(`[stream] fin de llamada (${motivo}).`);
    try { session && session.close(); } catch (_) {}
    try { twilio.close(); } catch (_) {}   // al cerrar el stream, Twilio cuelga (no hay mas TwiML)
  }

  async function onTool(toolCall) {
    const responses = [];
    for (const fc of (toolCall.functionCalls || [])) {
      let result;
      const args = fc.args || {};
      if (fc.name === 'finalizar_llamada') {
        colgando = true;
        result = { ok: true, mensaje: 'colgando' };
      } else if (TOOL_TO_WEBHOOK[fc.name]) {
        const url = cfg.webhooks && cfg.webhooks[TOOL_TO_WEBHOOK[fc.name]];
        if (!url) {
          result = { ok: false, error: 'Esta funcion no esta disponible para este negocio.' };
        } else {
          const body = { ...args };
          if (fc.name === 'crear_reserva' && !body.telefono) body.telefono = callerId;
          result = await llamarWebhook(url, body);
        }
        console.log(`[tool] ${fc.name} -> ${result && result.ok === false ? 'error' : 'ok'}`);
      } else {
        result = { ok: false, error: 'Funcion desconocida.' };
      }
      responses.push({ id: fc.id, name: fc.name, response: { result } });
    }
    try { session.sendToolResponse({ functionResponses: responses }); } catch (e) { console.error('[tool] respuesta', e?.message || e); }
  }

  function onGemini(msg) {
    if (msg.toolCall) { onTool(msg.toolCall); return; }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) enviarTwilio({ event: 'clear', streamSid });
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) for (const p of parts) {
      if (p.inlineData && p.inlineData.data) {
        const mulaw = pcm16ToMulaw(downsample3x(int16FromBase64(p.inlineData.data)));
        enviarTwilio({ event: 'media', streamSid, media: { payload: mulaw.toString('base64') } });
      }
    }
    if (sc.turnComplete && colgando) {
      enviarTwilio({ event: 'mark', streamSid, mark: { name: 'fin' } });
      setTimeout(() => colgar('timeout despedida'), 8000);
    }
  }

  async function abrirGemini() {
    if (!ai) { console.error('[stream] falta GCP_PROJECT'); return colgar('sin configuracion de Google'); }
    const systemText = String(cfg.systemInstruction || '') + contextoLlamada(callerId);
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voz || 'Kore' } } },
        systemInstruction: { parts: [{ text: systemText }] },
        tools: [{ functionDeclarations: TOOLS }],
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600, prefixPaddingMs: 300 } },
        contextWindowCompression: { slidingWindow: {} }
      },
      callbacks: {
        onopen: () => console.log('[gemini] sesion abierta.'),
        onmessage: onGemini,
        onerror: (e) => { console.error('[gemini] error:', e?.message || e); colgar('error de Gemini'); },
        onclose: (e) => { console.log(`[gemini] cerrada (code ${e?.code || '?'}).`); colgar('Gemini cerro la sesion'); }
      }
    });
    const saludo = cfg.saludo || `Hola, has llamado a ${cfg.nombre}. Soy un asistente virtual con inteligencia artificial. ¿En que puedo ayudarte?`;
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `(SISTEMA: acaba de empezar la llamada. Saluda tu primero diciendo exactamente: "${saludo}")` }] }], turnComplete: true });
  }

  twilio.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.event === 'start') {
      streamSid = m.start.streamSid;
      const p = m.start.customParameters || {};
      if (!SKIP_SIGNATURE && !safeEqual(p.token || '', streamToken(m.start.callSid))) {
        console.warn('[stream] token no valido. Cerrado.');
        return colgar('token no valido');
      }
      cfg = CLIENTES[normalizarNumero(p.to)];
      if (!cfg) return colgar('numero sin configuracion');
      callerId = /^\+?\d{6,}$/.test(normalizarNumero(p.from)) ? normalizarNumero(p.from) : '';
      try { await abrirGemini(); } catch (e) { console.error('[gemini] no se pudo abrir:', e?.message || e); colgar('no se pudo abrir Gemini'); }
    } else if (m.event === 'media' && session && m.media && m.media.payload) {
      const pcm16k = upsample2x(mulawToPcm16(Buffer.from(m.media.payload, 'base64')));
      try { session.sendRealtimeInput({ audio: { data: int16ToBase64(pcm16k), mimeType: 'audio/pcm;rate=16000' } }); } catch (_) {}
    } else if (m.event === 'mark' && m.mark && m.mark.name === 'fin') {
      colgar('despedida');
    } else if (m.event === 'stop') {
      colgar('el cliente colgo');
    }
  });
  twilio.on('close', () => colgar('stream cerrado'));
});

if (process.argv[1] && process.argv[1].endsWith('telefono.js')) {
  if (!SKIP_SIGNATURE && (!TWILIO_TOKEN || !PUBLIC_URL)) console.warn('AVISO: faltan TWILIO_AUTH_TOKEN o PUBLIC_URL; las llamadas se rechazaran.');
  httpServer.listen(PORT, () => console.log(`HOSPITIA AI relay telefonico v0.1 en puerto ${PORT} | clientes: ${Object.keys(CLIENTES).length} | modelo ${MODEL} | loc ${LOCATION}`));
}
